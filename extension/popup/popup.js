const $ = (id) => document.getElementById(id);

$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('fill').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.runtime.sendMessage({ type: 'jobfill.run', tabId: tab.id });
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.jobfillStatus) render(changes.jobfillStatus.newValue);
});

chrome.storage.session.get('jobfillStatus').then(({ jobfillStatus }) => render(jobfillStatus));

renderTotals();
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.jobfillTotals) renderTotals();
});

async function renderTotals() {
  const { jobfillTotals } = await chrome.storage.local.get('jobfillTotals');
  if (!jobfillTotals?.fills) return;
  $('totals').textContent = `all-time: $${jobfillTotals.spendUSD.toFixed(2)} across ${jobfillTotals.fills} fills`;
}

// Weighted stage model: percent-by-stage is honest (LLM latency is unknowable,
// so the bar fills by completed work, shimmering on the active segment).
// Weights reflect real durations: tailoring dominates a fill.
const STAGES = [
  { key: 'scraping', label: 'scan the page', weight: 5, hint: 'a few seconds' },
  { key: 'tailoring', label: 'tailor resume', weight: 60, hint: 'usually 1-3 min' },
  { key: 'mapping', label: 'map fields', weight: 25, hint: 'about a minute' },
  { key: 'filling', label: 'fill the form', weight: 10, hint: 'seconds' },
];
let tickHandle = null;
let lastStatus = null;

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderProgress(st) {
  const idx = STAGES.findIndex(x => x.key === st.state);
  const inFlight = idx !== -1;
  const isDone = st.state === 'done';
  $('progress').className = (inFlight || isDone) ? 'on' : '';
  if (!inFlight && !isDone) { clearInterval(tickHandle); tickHandle = null; return; }

  const pctDone = STAGES.slice(0, idx === -1 ? STAGES.length : idx).reduce((s, x) => s + x.weight, 0);
  // Active stage credits half its weight while running — forward motion on every transition.
  const pct = isDone ? 100 : pctDone + STAGES[idx].weight / 2;
  const bar = $('barFill');
  bar.style.width = `${pct}%`;
  bar.classList.toggle('settled', isDone);
  bar.style.background = isDone ? '#2e7d32' : '#1565c0';

  const detail = {
    scraping: '',
    tailoring: st.company ? `for ${st.company}` : '',
    mapping: st.fieldCount ? `${st.fieldCount} fields` : '',
    filling: '',
  };
  $('steps').innerHTML = STAGES.map((s, i) => {
    const state = isDone || i < idx ? 'done' : i === idx ? 'active' : '';
    const tick = state === 'done' ? '✓' : state === 'active' ? '●' : '○';
    const extra = state === 'active' && detail[s.key] ? ` <span class="muted">${esc(detail[s.key])}</span>` : '';
    const hint = state === 'active'
      ? `<span class="hint">${fmtElapsed(Date.now() - (st.stageStartedAt || st.startedAt || Date.now()))} · ${s.hint}</span>`
      : '';
    return `<div class="step ${state}"><span class="tick">${tick}</span><span>${s.label}${extra}</span>${hint}</div>`;
  }).join('');

  // Live elapsed ticker while a stage is active; popup-close clears it naturally.
  if (inFlight && !tickHandle) tickHandle = setInterval(() => lastStatus && renderProgress(lastStatus), 1000);
  if (!inFlight && tickHandle) { clearInterval(tickHandle); tickHandle = null; }
}

function render(st) {
  if (!st) return;
  lastStatus = st;
  const labels = {
    scraping: 'scanning the page…',
    mapping: 'mapping fields with claude…',
    tailoring: `tailoring resume for ${st.company || 'this role'}…`,
    filling: 'filling…',
    done: 'done — review highlighted fields',
    duplicate: 'already applied to this job',
    error: `error: ${st.error}`,
  };
  $('status').textContent = labels[st.state] || st.state;
  $('status').className = st.state === 'error' || st.state === 'duplicate' ? '' : 'muted';
  renderProgress(st);

  if (st.tailorState === 'ran') {
    $('tailorState').textContent = 'tailored resume attached';
    $('tailorState').className = 'muted';
  } else if (st.tailorState === 'skipped') {
    $('tailorState').textContent = `static resume — ${esc(st.tailorMessage)}`;
    $('tailorState').className = 'muted';
  } else if (st.tailorState === 'error') {
    $('tailorState').textContent = `tailor failed — ${esc(st.tailorMessage)} · static resume used`;
    $('tailorState').className = 'tailor-error';
  } else {
    $('tailorState').textContent = '';
    $('tailorState').className = '';
  }

  $('cost').textContent = st.cost ? `api cost ~$${st.cost.toFixed(3)}` : '';

  if (st.state === 'duplicate' && st.prior) {
    const when = new Date(st.prior.created_at).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    $('summary').innerHTML = '';
    $('results').innerHTML = `<div class="row s-duplicate">
      <span>you already applied to ${esc(st.prior.company)}${st.prior.role ? ' · ' + esc(st.prior.role) : ''} on ${esc(when)}</span>
    </div>
    <div class="row"><span class="muted">${esc(st.prior.url)}</span></div>
    <button id="fillAnyway">Fill anyway</button>`;
    $('fillAnyway').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'jobfill.run', tabId: st.tabId, force: true });
    });
    return;
  }

  // Array.isArray belt-and-suspenders (server already normalizes): a string summary is
  // truthy with a .length but .map() would throw and abort render() mid-way.
  if (st.state === 'done' && st.tailorState === 'ran' && Array.isArray(st.summary) && st.summary.length) {
    $('summary').innerHTML = `<div class="summary-block">
      <div class="summary-label">resume changes</div>
      ${st.summary.map((line) => `<div class="summary-line">${esc(line)}</div>`).join('')}
    </div>`;
  } else {
    $('summary').innerHTML = '';
  }

  const rows = [];
  for (const r of st.results || []) {
    rows.push(`<div class="row ${r.kind === 'essay' ? 'essay' : ''}">
      <span>${esc(r.label)}</span><span class="s-${r.status}">${r.status}${r.kind === 'essay' ? ' · essay' : ''}${r.reused ? ' · <span class="reused">reused</span>' : ''}</span>
    </div>`);
    if (r.stuck === false) {
      rows.push(`<div class="row"><span class="s-didnt_stick">${esc(r.label)}: didn't stick — check this field</span></div>`);
    }
  }
  for (const s of st.skipped || []) {
    rows.push(`<div class="row"><span>${esc(s.label)}</span><span class="muted">skipped: ${esc(s.reason)}</span></div>`);
  }

  const canCapture = st.state === 'done' &&
    ((st.results || []).some((r) => r.kind === 'essay') || st.skipped?.length > 0);
  if (canCapture) {
    rows.push('<button id="capture">Bank answers</button><div id="captureStatus" class="muted"></div>');
  }

  const canExportFailures = st.state === 'done' && st.failureRecords?.length > 0 && st.failuresSaved === false;
  if (canExportFailures) {
    rows.push('<button id="exportFailures">Export failures</button><div id="exportStatus" class="muted"></div>');
  }

  $('results').innerHTML = rows.join('');

  if (canCapture) {
    $('capture').addEventListener('click', () => {
      $('capture').disabled = true;
      $('capture').textContent = 'Banking…';
      chrome.runtime.sendMessage({ type: 'jobfill.capture', tabId: st.tabId });
    });
    if (st.captureError) {
      $('captureStatus').textContent = 'answers not saved — helper offline';
    } else if (typeof st.bankedCount === 'number') {
      $('captureStatus').textContent = `banked ${st.bankedCount} answer${st.bankedCount === 1 ? '' : 's'}`;
      $('captureStatus').style.color = '#2e7d32';
    }
  }

  if (canExportFailures) {
    $('exportFailures').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(st.failureRecords, null, 2));
        const n = st.failureRecords.length;
        $('exportStatus').textContent = `copied ${n} failure record${n === 1 ? '' : 's'}`;
        $('exportStatus').style.color = '#2e7d32';
      } catch {
        $('exportStatus').textContent = 'copy failed — try again';
      }
    });
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
