import { MODEL } from './anthropic.js';

export const MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    role: { type: 'string' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          kind: { type: 'string', enum: ['profile', 'essay'] },
          confidence: { type: 'number' },
          reused: { type: 'boolean' },
        },
        required: ['id', 'value', 'kind', 'confidence', 'reused'],
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
  required: ['company', 'role', 'fields', 'skipped'],
  additionalProperties: false,
};

export function buildRequest(profile, fields, pageContext, summary, library) {
  return {
    model: MODEL,
    max_tokens: 16000,
    system: [
      {
        type: 'text',
        text: systemPrompt(profile, summary, library),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: JSON.stringify({ pageContext, fields }) }],
    output_config: { format: { type: 'json_schema', schema: MAPPING_SCHEMA } },
  };
}

function systemPrompt(profile, summary, library) {
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
- Field ids are prefixed with a frame number ("2:jf-5"), and pageContext.frames lists each frame's URL. Only fill fields belonging to the job application itself. If a frame's URL indicates an unrelated embed (chat/support widget, ads, analytics, surveys, cookie consent), skip ALL of its fields with reason "unrelated frame", and NEVER return "attach_resume" for file fields in such frames.

ESSAY VOICE (kind "essay")
- lowercase by default, including "i". short paragraphs, 1-3 sentences each. plain language.
- no corporate buzzwords, no exclamation marks, no "I am excited to", no performative enthusiasm.
- confident without overselling. specific over generic — reference real work from the profile only.
- 60-150 words unless the label or maxLength suggests otherwise.
- PUNCTUATION TELLS: never use em-dashes, semicolons, or parenthetical asides. periods and commas only. no colon-led clauses mid-sentence.
- RHYTHM TELLS: vary sentence length like someone typing quickly. at most one "X, Y, and Z" list per answer. never open with a restatement of the question. no summary-closer sentences ("overall...", "in short...").
- WORD TELLS: never "passionate", "thrilled", "leverage", "delve", "honing", "aligns", "resonates", "excited by the opportunity".

CONFIDENCE: 1.0 for direct profile copies, lower when interpreting (0.5-0.8 for judgment calls on options), always between 0 and 1.

Also return "company" and "role" — the employer name and job title this application is for, inferred from pageContext (title, heading, jd text, url). Use "" when genuinely undeterminable.${summaryBlock(summary)}${libraryBlock(library)}`;
}

function summaryBlock(summary) {
  if (!Array.isArray(summary) || summary.length === 0) return '';
  return `

RESUME CONTEXT (for kind "essay" answers)
The resume was tailored for this role as summarized below. Essay answers must stay consistent with that framing — lead with the same strengths, don't contradict the emphasis.
${summary.join('\n')}`;
}

function libraryBlock(library) {
  const reuse = library?.reuse || [];
  const examples = library?.examples || [];
  if (reuse.length === 0 && examples.length === 0) return '';
  const reuseSection = reuse.length
    ? `

REUSE (the operator's own accepted answers to matching questions)
These are the operator's own accepted answers to matching questions on prior applications — reuse each one, keeping its voice and substance, adapting ONLY company/role-specific references. When you reuse one, set "reused": true on that field.
${reuse.map(r => `Q: ${r.question}\nA: ${r.answer}`).join('\n\n')}`
    : '';
  const examplesSection = examples.length
    ? `

EXAMPLES (the operator's approved answers to other questions)
Examples of the operator's approved answers to other questions — borrow phrasing, anecdotes, and voice when relevant, but facts still come only from the profile and this library, never invented.
${examples.map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')}`
    : '';
  return `

ANSWER LIBRARY${reuseSection}${examplesSection}`;
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
