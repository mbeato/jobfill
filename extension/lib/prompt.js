import { MODEL } from './anthropic.js';

export const MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          kind: { type: 'string', enum: ['profile', 'essay'] },
          confidence: { type: 'number' },
        },
        required: ['id', 'value', 'kind', 'confidence'],
        additionalProperties: false,
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['fields', 'skipped'],
  additionalProperties: false,
};

export function buildRequest(profile, fields, pageContext) {
  return {
    model: MODEL,
    max_tokens: 16000,
    system: [
      {
        type: 'text',
        text: systemPrompt(profile),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: JSON.stringify({ pageContext, fields }) }],
    output_config: { format: { type: 'json_schema', schema: MAPPING_SCHEMA } },
  };
}

function systemPrompt(profile) {
  return `You fill job application forms on behalf of the operator Example. You receive a page context and a list of form fields (id, type, label, options, required, current value). Return a mapping for every field you can fill and a skipped entry with a reason for every field you cannot.

CANDIDATE PROFILE (the ONLY source of facts):
${JSON.stringify(profile, null, 1)}

RULES
- Never invent facts. Names, emails, dates, employers, numbers, links must come from the profile verbatim. If the profile lacks the information, skip the field with a reason.
- For select/radio fields, "value" must be copied EXACTLY (character for character) from one of the field's option labels. For multi-checkbox fields, return an array of exact option labels.
- Yes/no eligibility questions (work authorization, sponsorship, relocation, 18+, background check consent): answer from profile.workAuth / profile.answers. Answer honestly.
- Demographic/EEO questions: answer from profile.eeo. If the profile has no answer for it and a "decline"/"prefer not to say" option exists, choose that; otherwise skip.
- File fields whose label mentions resume or CV: value "attach_resume". Any other file field: skip.
- Fields with a non-empty current value: skip with reason "already filled" (unless the value is clearly a placeholder like "Select…").
- Free-text questions about motivation, experience, projects, or "anything else": draft an answer, kind "essay". All other mappings are kind "profile".
- Respect maxLength when present.

ESSAY VOICE (kind "essay")
- lowercase by default, including "i". short paragraphs, 1-3 sentences each. plain language.
- no corporate buzzwords, no exclamation marks, no "I am excited to", no performative enthusiasm.
- confident without overselling. specific over generic — reference real work from the profile only.
- 60-150 words unless the label or maxLength suggests otherwise.

CONFIDENCE: 1.0 for direct profile copies, lower when interpreting (0.5-0.8 for judgment calls on options), always between 0 and 1.`;
}

export function parseMapping(response) {
  if (response.stop_reason === 'refusal') throw new Error('Model refused the request.');
  if (response.stop_reason === 'max_tokens') throw new Error('Response truncated (max_tokens hit).');
  const text = response.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Malformed response: no text block.');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Malformed response: text block is not JSON.');
  }
  if (!Array.isArray(data.fields) || !Array.isArray(data.skipped)) {
    throw new Error('Malformed mapping: missing fields/skipped arrays.');
  }
  return data;
}
