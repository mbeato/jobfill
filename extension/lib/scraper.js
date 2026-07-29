const FIELD_ATTR = 'data-jobfill-id';
// 'password': never inventory login-wall credential fields — jobfill has no
// business filling passwords, and a login page should scrape as empty.
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password']);

let nextId = 0;
const registry = new Map(); // id -> { el } | { els }

export function getEntry(id) {
  return registry.get(id);
}

export function collectFields(doc = document) {
  registry.clear();
  nextId = 0;
  const fields = [];
  const doneGroups = new Set();

  for (const el of doc.querySelectorAll('input, select, textarea')) {
    if (!isFillable(el)) continue;

    if (el.matches('input[type=radio][name], input[type=checkbox][name]')) {
      const key = `${el.type}:${el.name}:${el.form ? [...doc.forms].indexOf(el.form) : -1}`;
      if (doneGroups.has(key)) continue;
      doneGroups.add(key);
      const els = [...doc.querySelectorAll(`input[type=${el.type}][name="${cssEscape(el.name)}"]`)]
        .filter(isFillable)
        .filter(e => e.form === el.form);
      fields.push(describeGroup(el.type, els, doc));
    } else {
      fields.push(describeSingle(el, doc));
    }
  }
  return fields;
}

function describeSingle(el, doc) {
  const id = tag(el, { el });
  const type =
    el instanceof HTMLSelectElement ? 'select'
    : el instanceof HTMLTextAreaElement ? 'textarea'
    : isCombobox(el) ? 'combobox'
    : el.type || 'text';
  const f = {
    id,
    type,
    label: labelFor(el, doc),
    required: isRequired(el),
    value: el instanceof HTMLSelectElement
      ? (el.selectedOptions[0]?.textContent.trim() ?? '')
      : type === 'checkbox' ? String(el.checked)
      : type === 'file' ? ''
      : (el.value ?? ''),
  };
  if (type === 'select') f.options = optionList(el);
  if (type === 'file' && el.accept) f.accept = el.accept;
  if (el.maxLength > 0) f.maxLength = el.maxLength;
  return f;
}

function describeGroup(type, els, doc) {
  const id = tag(els[0], { els });
  return {
    id,
    type, // 'radio' | 'checkbox'
    label: groupLabel(els[0], doc),
    required: els.some(isRequired),
    value: els.filter(e => e.checked).map(e => labelFor(e, doc)).join(', '),
    options: els.map(e => ({ value: e.value, label: labelFor(e, doc) })),
  };
}

function tag(el, entry) {
  const id = `jf-${nextId++}`;
  el.setAttribute(FIELD_ATTR, id);
  registry.set(id, entry);
  return id;
}

function isFillable(el) {
  if (el.disabled || el.readOnly) return false;
  if (el instanceof HTMLInputElement && SKIP_TYPES.has(el.type)) return false;
  return isVisible(el);
}

export function isVisible(el) {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  let node = el;
  while (node && node instanceof Element) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    node = node.parentElement;
  }
  return true;
}

function isCombobox(el) {
  return el.getAttribute('role') === 'combobox'
    || el.getAttribute('aria-autocomplete') === 'list'
    || el.getAttribute('aria-haspopup') === 'listbox';
}

function isRequired(el) {
  return !!(el.required || el.getAttribute('aria-required') === 'true');
}

function optionList(sel) {
  return [...sel.options].slice(0, 150).map(o => ({ value: o.value, label: clean(o.textContent) }));
}

function labelFor(el, doc) {
  const byIds = el.getAttribute('aria-labelledby');
  if (byIds) {
    const text = byIds.split(/\s+/).map(i => doc.getElementById(i)?.textContent || '').join(' ');
    if (clean(text)) return clean(text);
  }
  if (el.id) {
    const lab = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (lab) return clean(lab.textContent);
  }
  const wrap = el.closest('label');
  if (wrap) return clean(wrap.textContent);
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);
  if (el.placeholder) return clean(el.placeholder);
  const sib = precedingText(el);
  if (sib) return sib;
  return clean(el.name || '');
}

function groupLabel(el, doc) {
  const legend = el.closest('fieldset')?.querySelector('legend');
  if (legend) return clean(legend.textContent);
  // walk up: nearest ancestor's first label-ish text that isn't an option label
  let node = el.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const cand = node.querySelector(':scope > label, :scope > legend, :scope > div[class*="label"], :scope > span[class*="label"], :scope > p');
    if (cand && !cand.contains(el)) {
      const t = clean(cand.textContent);
      if (t) return t;
    }
  }
  return clean(el.name || '');
}

function precedingText(el) {
  let node = el;
  for (let depth = 0; node && depth < 3; depth++) {
    let sib = node.previousElementSibling;
    while (sib) {
      const t = clean(sib.textContent);
      if (t && t.length <= 200 && !sib.querySelector('input, select, textarea')) return t;
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function cssEscape(s) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"');
}

// Job-description capture for resume tailoring. ATS pages (Ashby, Greenhouse,
// Lever) embed a schema.org JobPosting in JSON-LD even on application-form
// routes where the description is never rendered into the DOM — prefer that,
// then fall back to visible-text heuristics.
export function extractJD(doc = document) {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(script.textContent); } catch { continue; }
    for (const item of Array.isArray(data) ? data : [data]) {
      if (item?.['@type'] !== 'JobPosting' || typeof item.description !== 'string') continue;
      const text = new DOMParser().parseFromString(item.description, 'text/html')
        .body.textContent.replace(/\s+/g, ' ').trim();
      if (text.length >= 200) return text.slice(0, 8000);
    }
  }
  for (const selector of JD_CONTAINERS) {
    // Longest match within a tier, not the first: pages carry both a short
    // "description" teaser and the full posting, and document order does not
    // say which is which.
    let best = '';
    for (const el of doc.querySelectorAll(selector)) {
      const text = readableText(el);
      if (text.length > best.length) best = text;
    }
    if (best.length >= 200) return best.slice(0, 8000);
  }
  return readableText(doc.body).slice(0, 8000);
}

// Tried in THIS order, most-likely-to-be-the-JD first, one selector at a time.
// It used to be a single comma-joined querySelector, which returns the first
// match in DOCUMENT ORDER regardless of which selector matched — so a <main>
// wrapping the form, the nav and the description always beat the description
// itself, and the JD came back as page furniture. Measured on the live corpus:
// 5 of 63 stored JDs were chrome, one of them 8,000 chars of Oracle form text.
//
// Deliberately structural rather than a content classifier. Judging JD-ness
// from the text was tried and abandoned: on the 63-JD corpus, requiring the
// JD vocabulary that catches all 5 chrome rows also discarded 11 real
// descriptions, including a 4,588-char one with none of the markers at all.
const JD_CONTAINERS = ['[class*="description"]', '[id*="description"]', 'article', 'main'];

// innerText already excludes script/style, but it is falsy on an unrendered
// container (a hidden iframe body, a display:none panel) and the textContent
// fallback swallows inline source — which is how an iCIMS postMessage shim was
// stored as a 3,091-char "job description". Strip the non-content nodes off a
// clone so the fallback cannot.
function readableText(el) {
  if (!el) return '';
  let raw = el.innerText;
  if (!raw) {
    const clone = el.cloneNode(true);
    for (const node of clone.querySelectorAll('script, style, noscript, template')) node.remove();
    raw = clone.textContent || '';
  }
  return raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
