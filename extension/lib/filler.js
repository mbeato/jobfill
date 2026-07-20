import { getEntry, isVisible } from './scraper.js';

const ESSAY_STYLE = '3px solid #f5c518';   // yellow — always review
const LOWCONF_STYLE = '3px solid #f57c00'; // orange — verify
const DIDNT_STICK_STYLE = '3px solid #d32f2f'; // red — value did not persist

// D-08: only these triage statuses, on widget-ish elements, are in scope for failure capture.
const IN_SCOPE_STATUSES = new Set(['verify', 'needs_manual', 'error', 'didnt_stick']);

export async function applyMapping(mapping, attachments = {}) {
  const results = [];
  const failureRecords = [];
  for (const m of mapping) {
    let entry = getEntry(m.id);
    if (!entry) {
      results.push({ id: m.id, status: 'not_found', kind: m.kind, confidence: m.confidence, reused: m.reused });
      captureFailure(failureRecords, m, 'not_found', null, null, null);
      continue;
    }
    entry = resolveEntry(entry, m.id);
    if (!entry) {
      results.push({ id: m.id, status: 'stale', kind: m.kind, confidence: m.confidence, reused: m.reused });
      captureFailure(failureRecords, m, 'stale', null, null, null);
      continue;
    }
    let status;
    const capture = {};
    try {
      status = await fillOne(entry, m, attachments, capture);
    } catch (e) {
      status = 'error';
      console.warn('jobfill fill error', m.id, e);
    }
    let stuck;
    if (status === 'filled') {
      await sleep(120); // let framework renders / scheduled reverts / masks settle before read-back
      const resolved = resolveEntry(entry, m.id); // node may have been replaced during the delay
      if (resolved) {
        const el = resolved.el || resolved.els[0];
        stuck = verifyStuck(resolved, m);
        if (stuck === false) el.style.outline = DIDNT_STICK_STYLE;
        else if (m.kind === 'essay') el.style.outline = ESSAY_STYLE;
        else if (m.confidence < 0.7) el.style.outline = LOWCONF_STYLE;
      }
    }
    const result = { id: m.id, status, kind: m.kind, confidence: m.confidence, reused: m.reused };
    if (typeof stuck === 'boolean') result.stuck = stuck;
    results.push(result);

    // D-05/D-07: snapshot the failure moment for in-scope widget-ish statuses only (D-08).
    const el = entry.el || entry.els?.[0];
    const widgetKind = resolveWidgetKind(el);
    const triageStatus = stuck === false ? 'didnt_stick' : status;
    if (widgetKind !== null && IN_SCOPE_STATUSES.has(triageStatus)) {
      captureFailure(failureRecords, m, triageStatus, el, widgetKind, capture);
    }
  }
  return { results, failureRecords };
}

// Never let a snapshot bug regress the fill loop (D-05).
function captureFailure(failureRecords, m, status, el, widgetKind, capture) {
  try {
    failureRecords.push(buildFailureSnapshot(m, status, el, widgetKind, capture));
  } catch (e) {
    console.warn('jobfill failure-snapshot error', m.id, e);
  }
}

function buildFailureSnapshot(m, status, el, widgetKind, capture) {
  let outerHTML = '';
  if (el) {
    outerHTML = el.outerHTML;
    if (outerHTML.length > 4000) outerHTML = outerHTML.slice(0, 4000) + '… (truncated)';
  }
  const combo = widgetKind === 'combobox' ? capture : null;
  return {
    id: m.id,
    status,
    mappedValue: String(Array.isArray(m.value) ? m.value.join(', ') : m.value),
    widgetKind,
    outerHTML,
    optionsSeen: combo?.optionsSeen ?? null,
    listResolvedViaAria: combo?.listResolvedViaAria ?? null,
  };
}

// D-08 widget-ish gate: real ARIA widgets that are not native form controls.
function isCustomWidget(el) {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return false;
  const role = el.getAttribute('role');
  return ['listbox', 'menu', 'tree', 'grid', 'spinbutton', 'slider', 'switch', 'textbox'].includes(role)
    || el.hasAttribute('aria-haspopup')
    || el.hasAttribute('aria-expanded');
}

function resolveWidgetKind(el) {
  if (!el) return null;
  if (isComboboxEl(el)) return 'combobox';
  if (el instanceof HTMLSelectElement) return 'select';
  if (isCustomWidget(el)) return 'custom';
  return null;
}

// SPA forms can re-render between scrape and fill; never write into detached nodes.
function resolveEntry(entry, id) {
  if (entry.els) {
    const live = entry.els.filter(e => e.isConnected);
    return live.length ? { els: live } : null;
  }
  if (entry.el.isConnected) return entry;
  const fresh = entry.el.ownerDocument?.querySelector(`[data-jobfill-id="${id}"]`);
  return fresh ? { el: fresh } : null;
}

// Post-fill read-back: did the write actually persist? undefined = not verifiable, don't judge.
function verifyStuck(entry, m) {
  if (entry.els) {
    const wanted = Array.isArray(m.value) ? m.value : [m.value];
    return wanted.every(w => entry.els.some(e => e.checked && (matches(optionText(e), w) || matches(e.value, w))));
  }
  const el = entry.el;
  if (el instanceof HTMLSelectElement) {
    const sel = el.selectedOptions[0];
    const wanted = String(Array.isArray(m.value) ? m.value[0] : m.value);
    return !!sel && (matches(sel.textContent, wanted) || matches(sel.value, wanted));
  }
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    const want = /^(true|yes|1)$/i.test(String(m.value));
    return el.checked === want;
  }
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'file')) return undefined;
  if (isComboboxEl(el)) return undefined;
  const digits = s => String(s ?? '').replace(/\D/g, '');
  return matches(el.value, String(m.value))
    || (digits(m.value).length >= 7 && digits(el.value) === digits(m.value));
}

async function fillOne(entry, m, attachments, capture) {
  if (entry.els) return fillGroup(entry.els, m.value);
  const el = entry.el;
  if (el instanceof HTMLSelectElement) return fillSelect(el, m.value);
  if (el instanceof HTMLInputElement && el.type === 'file') return fillFile(el, m.value, attachments);
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    const want = /^(true|yes|1)$/i.test(String(m.value));
    if (el.checked !== want) el.click();
    return 'filled';
  }
  if (el instanceof HTMLInputElement && el.type === 'radio') {
    // nameless radio that escaped grouping — check it, never overwrite its submit value
    const affirm = /^(true|yes|1)$/i.test(String(m.value))
      || matches(optionText(el), m.value)
      || matches(el.value, m.value);
    if (!affirm) return 'needs_manual';
    if (!el.checked) el.click();
    return 'filled';
  }
  if (isComboboxEl(el)) return fillCombobox(el, String(m.value), capture);
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

async function fillCombobox(el, value, capture) {
  const doc = el.ownerDocument;
  // snapshot pre-existing options so the fallback can't click some unrelated widget
  const before = new Set([...doc.querySelectorAll('[role="option"]')]);
  el.focus();
  setNativeValue(el, value);
  await sleep(700); // let the widget fetch/filter options
  const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  let opts = listId ? [...(doc.getElementById(listId)?.querySelectorAll('[role="option"]') ?? [])] : [];
  if (!opts.length) {
    opts = [...doc.querySelectorAll('[role="option"]')].filter(isVisible).filter(o => !before.has(o));
  }
  // D-07: failure-moment state — only observable here, threaded back for the failure snapshot.
  if (capture) {
    capture.optionsSeen = opts.map(o => (o.textContent || '').replace(/\s+/g, ' ').trim());
    capture.listResolvedViaAria = !!(listId && doc.getElementById(listId));
  }
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
