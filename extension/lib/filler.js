import { getEntry, isVisible } from './scraper.js';

const ESSAY_STYLE = '3px solid #f5c518';   // yellow — always review
const LOWCONF_STYLE = '3px solid #f57c00'; // orange — verify

export async function applyMapping(mapping, attachments = {}) {
  const results = [];
  for (const m of mapping) {
    const entry = getEntry(m.id);
    if (!entry) {
      results.push({ id: m.id, status: 'not_found' });
      continue;
    }
    let status;
    try {
      status = await fillOne(entry, m, attachments);
    } catch (e) {
      status = 'error';
      console.warn('jobfill fill error', m.id, e);
    }
    const el = entry.el || entry.els[0];
    if (status === 'filled') {
      if (m.kind === 'essay') el.style.outline = ESSAY_STYLE;
      else if (m.confidence < 0.7) el.style.outline = LOWCONF_STYLE;
    }
    results.push({ id: m.id, status, kind: m.kind, confidence: m.confidence });
  }
  return results;
}

async function fillOne(entry, m, attachments) {
  if (entry.els) return fillGroup(entry.els, m.value);
  const el = entry.el;
  if (el instanceof HTMLSelectElement) return fillSelect(el, m.value);
  if (el instanceof HTMLInputElement && el.type === 'file') return fillFile(el, m.value, attachments);
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    const want = /^(true|yes|1)$/i.test(String(m.value));
    if (el.checked !== want) el.click();
    return 'filled';
  }
  if (isComboboxEl(el)) return fillCombobox(el, String(m.value));
  setNativeValue(el, String(m.value));
  return 'filled';
}

function fillGroup(els, value) {
  const wanted = Array.isArray(value) ? value : [value];
  let hit = 0;
  for (const w of wanted) {
    const target = els.find(e => matches(optionText(e), w) || matches(e.value, w));
    if (target) {
      if (!target.checked) target.click();
      hit++;
    }
  }
  return hit === wanted.length ? 'filled' : hit > 0 ? 'partial' : 'needs_manual';
}

function fillSelect(el, value) {
  const wanted = String(Array.isArray(value) ? value[0] : value);
  const opt = bestOption([...el.options], o => o.textContent, wanted)
    || bestOption([...el.options], o => o.value, wanted);
  if (!opt) return 'needs_manual';
  setNativeValue(el, opt.value);
  return 'filled';
}

async function fillCombobox(el, value) {
  el.focus();
  setNativeValue(el, value);
  await sleep(700); // let the widget fetch/filter options
  const doc = el.ownerDocument;
  const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  let opts = listId ? [...(doc.getElementById(listId)?.querySelectorAll('[role="option"]') ?? [])] : [];
  if (!opts.length) opts = [...doc.querySelectorAll('[role="option"]')].filter(isVisible);
  const target = bestOption(opts, o => o.textContent, value);
  if (target) {
    target.click();
    return 'filled';
  }
  return 'verify'; // typed text left in place; user confirms
}

function fillFile(el, value, attachments) {
  if (value !== 'attach_resume') return 'skipped';
  const resume = attachments.resume;
  if (!resume?.b64) return 'needs_manual';
  const bytes = Uint8Array.from(atob(resume.b64), c => c.charCodeAt(0));
  const file = new File([bytes], resume.name || 'resume.pdf', { type: resume.mime || 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'filled';
}

export function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function bestOption(items, getText, wanted) {
  const w = norm(wanted);
  if (!w) return null;
  return items.find(i => norm(getText(i)) === w)
    || items.find(i => norm(getText(i)).startsWith(w))
    || items.find(i => norm(getText(i)).includes(w))
    || null;
}

function matches(a, b) {
  const na = norm(a), nb = norm(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

function optionText(input) {
  const wrap = input.closest('label');
  if (wrap) return wrap.textContent;
  if (input.id) {
    const lab = input.ownerDocument.querySelector(`label[for="${input.id}"]`);
    if (lab) return lab.textContent;
  }
  return input.value;
}

function isComboboxEl(el) {
  return el.getAttribute('role') === 'combobox'
    || el.getAttribute('aria-autocomplete') === 'list'
    || el.getAttribute('aria-haspopup') === 'listbox';
}

function norm(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
