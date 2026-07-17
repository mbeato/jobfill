import { describe, it, expect } from 'vitest';
import { collectFields } from '../extension/lib/scraper.js';
import { applyMapping } from '../extension/lib/filler.js';

function mount(html) {
  document.body.innerHTML = html;
}

describe('applyMapping', () => {
  it('fills a text input and dispatches input + change', async () => {
    mount(`<input type="text" aria-label="First Name">`);
    const [f] = collectFields(document);
    const el = document.querySelector('input');
    const seen = [];
    el.addEventListener('input', () => seen.push('input'));
    el.addEventListener('change', () => seen.push('change'));
    const results = await applyMapping([{ id: f.id, value: 'Example', kind: 'profile', confidence: 1 }], {});
    expect(el.value).toBe('Example');
    expect(seen).toEqual(['input', 'change']);
    expect(results[0].status).toBe('filled');
  });

  it('selects an option by case-insensitive label match', async () => {
    mount(`<select aria-label="Country"><option value="">--</option><option value="us">United States</option></select>`);
    const [f] = collectFields(document);
    await applyMapping([{ id: f.id, value: 'united states', kind: 'profile', confidence: 1 }], {});
    expect(document.querySelector('select').value).toBe('us');
  });

  it('returns needs_manual when no select option matches', async () => {
    mount(`<select aria-label="Visa"><option value="a">H-1B</option></select>`);
    const [f] = collectFields(document);
    const results = await applyMapping([{ id: f.id, value: 'Green Card', kind: 'profile', confidence: 0.9 }], {});
    expect(results[0].status).toBe('needs_manual');
  });

  it('clicks the matching radio in a group', async () => {
    mount(`
      <label><input type="radio" name="auth" value="1">Yes</label>
      <label><input type="radio" name="auth" value="0">No</label>`);
    const [f] = collectFields(document);
    await applyMapping([{ id: f.id, value: 'Yes', kind: 'profile', confidence: 1 }], {});
    expect(document.querySelector('input[value="1"]').checked).toBe(true);
  });

  it('checks multiple checkboxes from an array value', async () => {
    mount(`
      <label><input type="checkbox" name="src" value="li">LinkedIn</label>
      <label><input type="checkbox" name="src" value="ref">Referral</label>
      <label><input type="checkbox" name="src" value="other">Other</label>`);
    const [f] = collectFields(document);
    await applyMapping([{ id: f.id, value: ['LinkedIn', 'Referral'], kind: 'profile', confidence: 1 }], {});
    const checked = [...document.querySelectorAll('input:checked')].map(e => e.value);
    expect(checked).toEqual(['li', 'ref']);
  });

  it('highlights essay fields and reports kind', async () => {
    mount(`<textarea aria-label="Why do you want to work here?"></textarea>`);
    const [f] = collectFields(document);
    const results = await applyMapping([{ id: f.id, value: 'because…', kind: 'essay', confidence: 0.8 }], {});
    const el = document.querySelector('textarea');
    expect(el.value).toBe('because…');
    expect(el.style.outline).toContain('3px solid');
    expect(results[0].kind).toBe('essay');
  });

  // jsdom has no DataTransfer constructor — this path is covered by manual E2E (Task 9)
  it.skipIf(typeof DataTransfer === 'undefined')('attaches the resume to file inputs on attach_resume', async () => {
    mount(`<input type="file" aria-label="Resume">`);
    const [f] = collectFields(document);
    const b64 = btoa('%PDF-1.4 fake');
    const results = await applyMapping(
      [{ id: f.id, value: 'attach_resume', kind: 'profile', confidence: 1 }],
      { resume: { name: 'resume.pdf', mime: 'application/pdf', b64 } },
    );
    const el = document.querySelector('input');
    expect(results[0].status).toBe('filled');
    expect(el.files).toHaveLength(1);
    expect(el.files[0].name).toBe('resume.pdf');
  });

  it('reports not_found for unknown ids', async () => {
    mount(`<input type="text" aria-label="X">`);
    collectFields(document);
    const results = await applyMapping([{ id: 'jf-999', value: 'x', kind: 'profile', confidence: 1 }], {});
    expect(results[0].status).toBe('not_found');
  });
});
