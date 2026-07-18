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

  it('clicks a nameless single radio instead of overwriting its value', async () => {
    mount(`<label><input type="radio" value="acknowledge">I acknowledge the terms</label>`);
    const [f] = collectFields(document);
    const el = document.querySelector('input');
    const results = await applyMapping([{ id: f.id, value: 'yes', kind: 'profile', confidence: 1 }], {});
    expect(el.checked).toBe(true);
    expect(el.value).toBe('acknowledge'); // submit value must be untouched
    expect(results[0].status).toBe('filled');
  });

  it('reports stale when the element was detached after scraping', async () => {
    mount(`<input type="text" aria-label="First Name">`);
    const [f] = collectFields(document);
    document.querySelector('input').remove(); // SPA re-render tore the node out
    const results = await applyMapping([{ id: f.id, value: 'Example', kind: 'profile', confidence: 1 }], {});
    expect(results[0].status).toBe('stale');
  });

  it('re-resolves by data attribute when a tagged replacement node exists', async () => {
    mount(`<input type="text" aria-label="First Name">`);
    const [f] = collectFields(document);
    const old = document.querySelector('input');
    const clone = old.cloneNode(true); // keeps data-jobfill-id, like a DOM morph
    old.replaceWith(clone);
    const results = await applyMapping([{ id: f.id, value: 'Example', kind: 'profile', confidence: 1 }], {});
    expect(results[0].status).toBe('filled');
    expect(clone.value).toBe('Example');
  });

  it('combobox fallback never clicks options that pre-existed the typing', async () => {
    mount(`
      <div role="listbox"><div role="option" id="unrelated">New Jersey</div></div>
      <input type="text" role="combobox" aria-label="Location">`);
    const [f] = collectFields(document);
    let clicked = false;
    document.getElementById('unrelated').addEventListener('click', () => { clicked = true; });
    const results = await applyMapping([{ id: f.id, value: 'New York', kind: 'profile', confidence: 1 }], {});
    expect(clicked).toBe(false);
    expect(results[0].status).toBe('verify'); // typed text left for the user to confirm
  });

  it('reports not_found for unknown ids', async () => {
    mount(`<input type="text" aria-label="X">`);
    collectFields(document);
    const results = await applyMapping([{ id: 'jf-999', value: 'x', kind: 'profile', confidence: 1 }], {});
    expect(results[0].status).toBe('not_found');
  });

  it('flags stuck: true when a filled text value persists', async () => {
    mount(`<input type="text" aria-label="Email">`);
    const [f] = collectFields(document);
    const results = await applyMapping([{ id: f.id, value: 'max@x.com', kind: 'profile', confidence: 1 }], {});
    expect(results[0].stuck).toBe(true);
  });

  it('flags stuck: false and outlines red when a controlled input reverts the value', async () => {
    mount(`<input type="text" aria-label="First Name">`);
    const [f] = collectFields(document);
    const el = document.querySelector('input');
    el.addEventListener('input', () => { el.value = ''; }); // simulate a controlled component resetting
    const results = await applyMapping([{ id: f.id, value: 'Example', kind: 'profile', confidence: 1 }], {});
    expect(results[0].status).toBe('filled');
    expect(results[0].stuck).toBe(false);
    expect(el.style.outline).toContain('#d32f2f');
  });

  it('flags stuck: false when a controlled input reverts the value asynchronously (macrotask)', async () => {
    mount(`<input type="text" aria-label="First Name">`);
    const [f] = collectFields(document);
    const el = document.querySelector('input');
    el.addEventListener('input', () => { setTimeout(() => { el.value = ''; }, 0); }); // async revert
    const results = await applyMapping([{ id: f.id, value: 'Example', kind: 'profile', confidence: 1 }], {});
    expect(results[0].status).toBe('filled');
    expect(results[0].stuck).toBe(false);
    expect(el.style.outline).toContain('#d32f2f');
  });

  it('omits stuck (does not throw) when the node detaches during the read-back delay', async () => {
    mount(`<input type="text" aria-label="First Name">`);
    const [f] = collectFields(document);
    const el = document.querySelector('input');
    el.addEventListener('input', () => { setTimeout(() => { el.remove(); }, 0); });
    const results = await applyMapping([{ id: f.id, value: 'Example', kind: 'profile', confidence: 1 }], {});
    expect(results[0].status).toBe('filled');
    expect('stuck' in results[0]).toBe(false);
  });

  it('flags stuck: true when a masked tel input reformats the value (not a revert)', async () => {
    mount(`<input type="text" aria-label="Phone">`);
    const [f] = collectFields(document);
    const el = document.querySelector('input');
    el.addEventListener('input', () => { el.value = '(555) 555-0100'; }); // mask reformat
    const results = await applyMapping([{ id: f.id, value: '555-555-0100', kind: 'profile', confidence: 1 }], {});
    expect(results[0].stuck).toBe(true);
  });

  it('flags stuck: false when a tel input is reverted to a genuinely different number', async () => {
    mount(`<input type="text" aria-label="Phone">`);
    const [f] = collectFields(document);
    const el = document.querySelector('input');
    el.addEventListener('input', () => { el.value = '(999) 999-9999'; }); // different number, not a mask
    const results = await applyMapping([{ id: f.id, value: '555-555-0100', kind: 'profile', confidence: 1 }], {});
    expect(results[0].stuck).toBe(false);
  });

  it('flags stuck: true when a select lands on the intended option', async () => {
    mount(`<select aria-label="Country"><option value="">--</option><option value="us">United States</option></select>`);
    const [f] = collectFields(document);
    const results = await applyMapping([{ id: f.id, value: 'united states', kind: 'profile', confidence: 1 }], {});
    expect(results[0].stuck).toBe(true);
  });

  it('flags stuck: true for a checkbox toggled to the wanted state', async () => {
    mount(`<label><input type="checkbox" aria-label="Subscribe">Subscribe</label>`);
    const [f] = collectFields(document);
    const results = await applyMapping([{ id: f.id, value: 'true', kind: 'profile', confidence: 1 }], {});
    expect(results[0].stuck).toBe(true);
  });

  it('flags stuck: false when a listener flips a checkbox back after click', async () => {
    mount(`<label><input type="checkbox" aria-label="Subscribe">Subscribe</label>`);
    const [f] = collectFields(document);
    const el = document.querySelector('input');
    el.addEventListener('click', () => { el.checked = false; }); // listener rejects the check
    const results = await applyMapping([{ id: f.id, value: 'true', kind: 'profile', confidence: 1 }], {});
    expect(results[0].stuck).toBe(false);
  });

  it('flags stuck: true when a checkbox group has all wanted options checked', async () => {
    mount(`
      <label><input type="checkbox" name="src" value="li">LinkedIn</label>
      <label><input type="checkbox" name="src" value="ref">Referral</label>
      <label><input type="checkbox" name="src" value="other">Other</label>`);
    const [f] = collectFields(document);
    const results = await applyMapping([{ id: f.id, value: ['LinkedIn', 'Referral'], kind: 'profile', confidence: 1 }], {});
    expect(results[0].stuck).toBe(true);
  });

  it('does not judge combobox verify results for stuck', async () => {
    mount(`
      <div role="listbox"><div role="option" id="unrelated">New Jersey</div></div>
      <input type="text" role="combobox" aria-label="Location">`);
    const [f] = collectFields(document);
    const results = await applyMapping([{ id: f.id, value: 'New York', kind: 'profile', confidence: 1 }], {});
    expect(results[0].status).toBe('verify');
    expect('stuck' in results[0]).toBe(false);
  });

  it.skipIf(typeof DataTransfer === 'undefined')('does not judge file input fills for stuck', async () => {
    mount(`<input type="file" aria-label="Resume">`);
    const [f] = collectFields(document);
    const b64 = btoa('%PDF-1.4 fake');
    const results = await applyMapping(
      [{ id: f.id, value: 'attach_resume', kind: 'profile', confidence: 1 }],
      { resume: { name: 'resume.pdf', mime: 'application/pdf', b64 } },
    );
    expect(results[0].status).toBe('filled');
    expect('stuck' in results[0]).toBe(false);
  });

  it('omits stuck for non-filled statuses', async () => {
    mount(`<select aria-label="Visa"><option value="a">H-1B</option></select>`);
    const [f] = collectFields(document);
    const results = await applyMapping([{ id: f.id, value: 'Green Card', kind: 'profile', confidence: 0.9 }], {});
    expect(results[0].status).toBe('needs_manual');
    expect('stuck' in results[0]).toBe(false);
  });
});
