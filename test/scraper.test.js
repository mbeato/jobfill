import { describe, it, expect } from 'vitest';
import { collectFields, getEntry, extractJD } from '../extension/lib/scraper.js';

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

describe('extractJD', () => {
  const longDesc = 'We are hiring a senior engineer. '.repeat(30); // ~990 chars

  it('prefers JSON-LD JobPosting description over sparse DOM text (Ashby application-tab case)', () => {
    document.body.innerHTML = `<div id="root"><form><label>First Name</label><input></form></div>`;
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org/', '@type': 'JobPosting',
      title: 'Head of AI Enablement Engineering',
      description: `<h1>Company Overview</h1><p>${longDesc}</p>`,
    });
    document.head.appendChild(ld);
    const jd = extractJD(document);
    expect(jd).toContain('Company Overview');
    expect(jd).toContain('senior engineer');
    expect(jd).not.toContain('<p>');
    expect(jd.length).toBeGreaterThanOrEqual(200);
    ld.remove();
  });

  it('handles JSON-LD arrays and skips non-JobPosting entries', () => {
    document.body.innerHTML = `<div></div>`;
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify([
      { '@type': 'Organization', name: 'Acme' },
      { '@type': 'JobPosting', description: `<p>${longDesc}</p>` },
    ]);
    document.head.appendChild(ld);
    expect(extractJD(document)).toContain('senior engineer');
    ld.remove();
  });

  it('falls back to the DOM heuristic when JSON-LD is absent or malformed', () => {
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = '{not json';
    document.head.appendChild(ld);
    document.body.innerHTML = `<main>About the role: ${longDesc}</main>`;
    expect(extractJD(document)).toContain('About the role');
    ld.remove();
  });

  it('ignores a short JSON-LD description and falls back to richer DOM text', () => {
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify({ '@type': 'JobPosting', description: 'Short.' });
    document.head.appendChild(ld);
    document.body.innerHTML = `<main>Full posting text here. ${longDesc}</main>`;
    expect(extractJD(document)).toContain('Full posting text');
    ld.remove();
  });

  // The selector list read like a priority order but was passed to a single
  // querySelector call, which returns the first match in DOCUMENT ORDER
  // regardless of which selector matched. So a <main> wrapping both the form
  // and the description won every time, and the JD came back as page chrome
  // with the real description buried inside it. Live consequence: 5 of 63
  // stored JDs were furniture, one of them 8,000 chars of Oracle form text.
  it('prefers a description-named container over an outer <main> that wraps the whole page', () => {
    document.body.innerHTML = `
      <main>
        <nav>Job application form Import your profile Exit to job board</nav>
        <form><label>First Name</label><input></form>
        <div class="job-description">About the role: ${longDesc}</div>
      </main>`;
    const jd = extractJD(document);
    expect(jd).toContain('About the role');
    expect(jd).not.toContain('Import your profile');
  });

  it('skips a description-named container too short to be the JD and keeps looking', () => {
    document.body.innerHTML = `
      <div id="description-header">Software Engineer</div>
      <article>About the role: ${longDesc}</article>`;
    expect(extractJD(document)).toContain('About the role');
  });

  // textContent swallows <script> text, and innerText is falsy on an unrendered
  // container — which is how an iCIMS postMessage shim ended up stored as a
  // 3,091-char "job description" (application 100, live).
  it('never returns inline <script> source as the description', () => {
    document.body.innerHTML = `
      <main>
        <script>var useAutoScrolling = false; if (window.addEventListener) { window.addEventListener('message', icims_handlePostMessage, false); }</script>
        <p>About the role: ${longDesc}</p>
      </main>`;
    const jd = extractJD(document);
    expect(jd).not.toContain('useAutoScrolling');
    expect(jd).not.toContain('addEventListener');
    expect(jd).toContain('About the role');
  });

  it('falls back to body text when no candidate container exists', () => {
    document.body.innerHTML = `<div>About the role: ${longDesc}</div>`;
    expect(extractJD(document)).toContain('About the role');
  });
  it('takes the longest description-named container, not the first (teaser vs full posting)', () => {
    document.body.innerHTML = `
      <div class="description-teaser">Software Engineer in New York. Apply now to join our growing team today.</div>
      <div class="job-description">About the role: ${longDesc}</div>`;
    const jd = extractJD(document);
    expect(jd).toContain('About the role');
    expect(jd.length).toBeGreaterThan(900);
  });
});
