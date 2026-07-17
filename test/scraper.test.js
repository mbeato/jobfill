import { describe, it, expect } from 'vitest';
import { collectFields, getEntry } from '../extension/lib/scraper.js';

function mount(html) {
  document.body.innerHTML = html;
}

describe('collectFields', () => {
  it('collects a text input with its <label for> text', () => {
    mount(`<label for="fn">First Name *</label><input id="fn" type="text" required>`);
    const fields = collectFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ type: 'text', label: 'First Name *', required: true });
    expect(fields[0].id).toMatch(/^jf-\d+$/);
  });

  it('falls back to aria-label, then placeholder', () => {
    mount(`<input type="email" aria-label="Email address"><input type="tel" placeholder="Phone">`);
    const [email, phone] = collectFields(document);
    expect(email.label).toBe('Email address');
    expect(phone.label).toBe('Phone');
  });

  it('groups radios by name into one field with options', () => {
    mount(`
      <fieldset><legend>Are you authorized to work in the US?</legend>
        <label><input type="radio" name="auth" value="1">Yes</label>
        <label><input type="radio" name="auth" value="0">No</label>
      </fieldset>`);
    const fields = collectFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('radio');
    expect(fields[0].label).toContain('authorized to work');
    expect(fields[0].options.map(o => o.label)).toEqual(['Yes', 'No']);
  });

  it('captures select options', () => {
    mount(`<label for="s">Gender</label><select id="s">
      <option value="">Select…</option><option value="m">Man</option><option value="d">Decline to state</option>
    </select>`);
    const [f] = collectFields(document);
    expect(f.type).toBe('select');
    expect(f.options.map(o => o.label)).toEqual(['Select…', 'Man', 'Decline to state']);
  });

  it('skips hidden, disabled, and non-fillable inputs', () => {
    mount(`
      <input type="hidden" name="token">
      <input type="text" disabled>
      <input type="text" style="display:none">
      <input type="submit" value="Apply">
      <input type="text" aria-label="Visible one">`);
    const fields = collectFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('Visible one');
  });

  it('detects comboboxes via role', () => {
    mount(`<input type="text" role="combobox" aria-label="School">`);
    expect(collectFields(document)[0].type).toBe('combobox');
  });

  it('records file inputs with accept attr', () => {
    mount(`<label for="r">Resume/CV</label><input id="r" type="file" accept=".pdf,.docx">`);
    const [f] = collectFields(document);
    expect(f.type).toBe('file');
    expect(f.accept).toBe('.pdf,.docx');
  });

  it('registry resolves ids back to elements', () => {
    mount(`<input type="text" aria-label="X">`);
    const [f] = collectFields(document);
    expect(getEntry(f.id).el).toBe(document.querySelector('input'));
  });

  it('includes current value so already-filled fields can be skipped', () => {
    mount(`<input type="text" aria-label="City" value="Miami">`);
    expect(collectFields(document)[0].value).toBe('Miami');
  });
});
