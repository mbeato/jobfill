import { describe, it, expect } from 'vitest';
import { enforceIdentity } from '../extension/lib/identity.js';

const profile = {
  contact: { email: 'you@example.edu', phone: '555-555-0100' },
  links: {
    linkedin: 'https://www.linkedin.com/in/example/',
    github: 'https://github.com/example',
    portfolio: 'https://example.com',
  },
};

function field(overrides) {
  return { id: '0:jf-0', type: 'text', label: 'Field', required: false, value: '', ...overrides };
}

describe('enforceIdentity', () => {
  it('corrects a hallucinated email', () => {
    const fields = [field({ id: '0:jf-1', type: 'email', label: 'Email' })];
    const mapping = { fields: [{ id: '0:jf-1', value: 'fake@x.com', kind: 'profile', confidence: 0.9 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields[0].value).toBe('you@example.edu');
    expect(out.corrections).toEqual([{ id: '0:jf-1', category: 'email', from: 'fake@x.com', to: 'you@example.edu' }]);
  });

  it('leaves a correct email unchanged and records no correction', () => {
    const fields = [field({ id: '0:jf-1', type: 'email', label: 'Email' })];
    const mapping = { fields: [{ id: '0:jf-1', value: 'you@example.edu', kind: 'profile', confidence: 1 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields[0].value).toBe('you@example.edu');
    expect(out.corrections).toHaveLength(0);
  });

  it('forces a phone field regardless of model value', () => {
    const fields = [field({ id: '0:jf-2', type: 'tel', label: 'Phone' })];
    const mapping = { fields: [{ id: '0:jf-2', value: '000-000-0000', kind: 'profile', confidence: 0.7 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields[0].value).toBe('555-555-0100');
  });

  it('forces linkedin, github, and portfolio fields', () => {
    const fields = [
      field({ id: '0:jf-3', type: 'url', label: 'LinkedIn URL' }),
      field({ id: '0:jf-4', type: 'url', label: 'GitHub' }),
      field({ id: '0:jf-5', type: 'url', label: 'Portfolio' }),
      field({ id: '0:jf-6', type: 'url', label: 'Personal website' }),
    ];
    const mapping = {
      fields: [
        { id: '0:jf-3', value: 'wrong', kind: 'profile', confidence: 0.5 },
        { id: '0:jf-4', value: 'wrong', kind: 'profile', confidence: 0.5 },
        { id: '0:jf-5', value: 'wrong', kind: 'profile', confidence: 0.5 },
        { id: '0:jf-6', value: 'wrong', kind: 'profile', confidence: 0.5 },
      ],
      skipped: [],
    };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields.find(f => f.id === '0:jf-3').value).toBe(profile.links.linkedin);
    expect(out.fields.find(f => f.id === '0:jf-4').value).toBe(profile.links.github);
    expect(out.fields.find(f => f.id === '0:jf-5').value).toBe(profile.links.portfolio);
    expect(out.fields.find(f => f.id === '0:jf-6').value).toBe(profile.links.portfolio);
  });

  it('injects an identity field the model skipped', () => {
    const fields = [field({ id: '0:jf-7', type: 'email', label: 'Email' })];
    const mapping = { fields: [], skipped: [{ id: '0:jf-7', reason: 'already filled' }] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields).toEqual([{ id: '0:jf-7', value: 'you@example.edu', kind: 'profile', confidence: 1 }]);
    expect(out.skipped).toHaveLength(0);
    expect(out.corrections).toEqual([{ id: '0:jf-7', category: 'email', from: null, to: 'you@example.edu' }]);
  });

  it('never overwrites an emergency-contact field', () => {
    const fields = [field({ id: '0:jf-8', type: 'email', label: 'Emergency contact email' })];
    const mapping = { fields: [{ id: '0:jf-8', value: 'someone@else.com', kind: 'profile', confidence: 0.8 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields[0].value).toBe('someone@else.com');
    expect(out.corrections).toHaveLength(0);
  });

  it('does not overwrite third-party contact fields under varied phrasings', () => {
    const labels = [
      'Referred by (email)',
      'Who referred you',
      "Friend's email",
      "Contact person's phone",
    ];
    for (const label of labels) {
      const fields = [field({ id: '0:jf-9', type: label.toLowerCase().includes('email') ? 'email' : 'tel', label })];
      const mapping = { fields: [{ id: '0:jf-9', value: 'untouched', kind: 'profile', confidence: 0.5 }], skipped: [] };
      const out = enforceIdentity(mapping, fields, profile);
      expect(out.fields[0].value).toBe('untouched');
      expect(out.corrections).toHaveLength(0);
    }
  });

  it('does not overwrite with an empty/missing profile constant', () => {
    const emptyProfile = { contact: { email: '' }, links: {} };
    const fields = [field({ id: '0:jf-10', type: 'email', label: 'Email' })];
    const mapping = { fields: [{ id: '0:jf-10', value: 'whatever@x.com', kind: 'profile', confidence: 0.5 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, emptyProfile);
    expect(out.fields[0].value).toBe('whatever@x.com');
    expect(out.corrections).toHaveLength(0);
  });

  it('does not inject when the model skipped an identity field and the constant is empty', () => {
    const emptyProfile = { contact: {}, links: {} };
    const fields = [field({ id: '0:jf-11', type: 'email', label: 'Email' })];
    const mapping = { fields: [], skipped: [{ id: '0:jf-11', reason: 'unknown' }] };
    const out = enforceIdentity(mapping, fields, emptyProfile);
    expect(out.fields).toHaveLength(0);
    expect(out.skipped).toEqual([{ id: '0:jf-11', reason: 'unknown' }]);
  });

  it('preserves frame-prefixed ids on returned entries', () => {
    const fields = [field({ id: '2:jf-5', type: 'email', label: 'Email' })];
    const mapping = { fields: [{ id: '2:jf-5', value: 'fake@x.com', kind: 'profile', confidence: 0.9 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields[0].id).toBe('2:jf-5');
  });

  it('leaves a select labeled Phone Device Type untouched', () => {
    const fields = [field({ id: '0:jf-12', type: 'select', label: 'Phone Device Type' })];
    const mapping = { fields: [{ id: '0:jf-12', value: 'Mobile', kind: 'model', confidence: 0.9 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields[0].value).toBe('Mobile');
    expect(out.corrections).toHaveLength(0);
  });

  it('leaves a select labeled Country Phone Code untouched', () => {
    const fields = [field({ id: '0:jf-13', type: 'select', label: 'Country Phone Code' })];
    const mapping = { fields: [{ id: '0:jf-13', value: '+1', kind: 'model', confidence: 0.9 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields[0].value).toBe('+1');
    expect(out.corrections).toHaveLength(0);
  });

  it('leaves a checkbox labeled Email me updates untouched', () => {
    const fields = [field({ id: '0:jf-14', type: 'checkbox', label: 'Email me updates' })];
    const mapping = { fields: [{ id: '0:jf-14', value: 'true', kind: 'model', confidence: 0.9 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields[0].value).toBe('true');
    expect(out.corrections).toHaveLength(0);
  });

  it('does not un-skip a non-text checkbox skipped as already filled', () => {
    const fields = [field({ id: '0:jf-15', type: 'checkbox', label: 'Sign up for email newsletter' })];
    const mapping = { fields: [], skipped: [{ id: '0:jf-15', reason: 'already filled' }] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields).toHaveLength(0);
    expect(out.skipped).toEqual([{ id: '0:jf-15', reason: 'already filled' }]);
    expect(out.corrections).toHaveLength(0);
  });

  it('does not inject into a field the model skipped as unrelated frame', () => {
    const fields = [field({ id: '0:jf-16', type: 'email', label: 'Email' })];
    const mapping = { fields: [], skipped: [{ id: '0:jf-16', reason: 'unrelated frame' }] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields).toHaveLength(0);
    expect(out.skipped).toEqual([{ id: '0:jf-16', reason: 'unrelated frame' }]);
    expect(out.corrections).toHaveLength(0);
  });

  it('still injects an identity field skipped for a non-frame reason', () => {
    const fields = [field({ id: '0:jf-17', type: 'email', label: 'Email' })];
    const mapping = { fields: [], skipped: [{ id: '0:jf-17', reason: 'already filled' }] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields).toEqual([{ id: '0:jf-17', value: 'you@example.edu', kind: 'profile', confidence: 1 }]);
    expect(out.skipped).toHaveLength(0);
  });

  it('does not inject when the frame-exclusion reason phrasing drifts', () => {
    const reasons = ['unrelated iframe', 'third-party chat widget', 'cookie consent embed', 'survey frame'];
    for (const reason of reasons) {
      const fields = [field({ id: '3:jf-18', type: 'email', label: 'Email' })];
      const mapping = { fields: [], skipped: [{ id: '3:jf-18', reason }] };
      const out = enforceIdentity(mapping, fields, profile);
      expect(out.fields).toHaveLength(0);
      expect(out.skipped).toEqual([{ id: '3:jf-18', reason }]);
    }
  });

  it('does not inject into a field omitted from both fields and skipped in a frame the model never mapped', () => {
    const fields = [
      field({ id: '0:jf-1', type: 'text', label: 'Full name' }),
      field({ id: '4:jf-19', type: 'email', label: 'Email' }),
    ];
    const mapping = { fields: [{ id: '0:jf-1', value: 'the operator Example', kind: 'profile', confidence: 1 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0].id).toBe('0:jf-1');
    expect(out.corrections).toHaveLength(0);
  });

  it('still injects an omitted identity field in a frame the model mapped', () => {
    const fields = [
      field({ id: '0:jf-1', type: 'text', label: 'Full name' }),
      field({ id: '0:jf-20', type: 'email', label: 'Email' }),
    ];
    const mapping = { fields: [{ id: '0:jf-1', value: 'the operator Example', kind: 'profile', confidence: 1 }], skipped: [] };
    const out = enforceIdentity(mapping, fields, profile);
    expect(out.fields.find(f => f.id === '0:jf-20')).toEqual({ id: '0:jf-20', value: 'you@example.edu', kind: 'profile', confidence: 1 });
    expect(out.corrections).toEqual([{ id: '0:jf-20', category: 'email', from: null, to: 'you@example.edu' }]);
  });
});
