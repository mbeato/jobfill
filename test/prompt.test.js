import { describe, it, expect } from 'vitest';
import { buildRequest, parseMapping, MAPPING_SCHEMA } from '../extension/lib/prompt.js';

const profile = { contact: { email: 'you@example.com' } };
const fields = [{ id: '0:jf-0', type: 'text', label: 'Email', required: true, value: '' }];
const ctx = { url: 'https://boards.greenhouse.io/x', title: 'Apply', heading: 'Software Engineer' };

describe('buildRequest', () => {
  it('builds a sonnet request with structured output and cached system prompt', () => {
    const req = buildRequest(profile, fields, ctx);
    expect(req.model).toBe('claude-sonnet-5');
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.output_config.format.schema).toBe(MAPPING_SCHEMA);
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.system[0].text).toContain('you@example.com');
    const user = JSON.parse(req.messages[0].content);
    expect(user.fields[0].id).toBe('0:jf-0');
    expect(user.pageContext.heading).toBe('Software Engineer');
  });

  it('injects a RESUME CONTEXT section when a summary is provided', () => {
    const req = buildRequest(profile, fields, ctx, ['led with X — JD wants Y']);
    expect(req.system[0].text).toContain('RESUME CONTEXT');
    expect(req.system[0].text).toContain('led with X — JD wants Y');
  });

  it('omits the RESUME CONTEXT section when no summary is provided', () => {
    const req = buildRequest(profile, fields, ctx);
    expect(req.system[0].text).not.toContain('RESUME CONTEXT');
  });
});

describe('parseMapping', () => {
  const ok = (json) => ({
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(json) }],
  });

  it('parses the first text block', () => {
    const data = { fields: [{ id: '0:jf-0', value: 'x', kind: 'profile', confidence: 1 }], skipped: [] };
    expect(parseMapping(ok(data))).toEqual(data);
  });

  it('throws on refusal', () => {
    expect(() => parseMapping({ stop_reason: 'refusal', content: [] })).toThrow(/refused/i);
  });

  it('throws on truncation', () => {
    expect(() => parseMapping({ stop_reason: 'max_tokens', content: [] })).toThrow(/truncat/i);
  });

  it('throws on malformed shape', () => {
    expect(() => parseMapping(ok({ nope: true }))).toThrow(/malformed/i);
  });
});
