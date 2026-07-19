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

function render(st) {
  if (!st) return;
  const labels = {
    scraping: 'scanning the page…',
    mapping: `mapping ${st.fieldCount ?? ''} fields with claude…`,
    tailoring: `tailoring resume for ${st.company || 'this role'}… (1-3 min)`,
    filling: 'filling…',
    done: `done — review highlighted fields${st.tailored ? ' · tailored resume attached' : st.tailorError ? ' · static resume (tailor failed)' : ''}`,
    duplicate: 'already applied to this job',
    error: `error: ${st.error}`,
  };
  $('status').textContent = labels[st.state] || st.state;
  $('status').className = st.state === 'error' || st.state === 'duplicate' ? '' : 'muted';
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

  if (st.state === 'done' && st.tailored && st.summary?.length) {
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
      <span>${esc(r.label)}</span><span class="s-${r.status}">${r.status}${r.kind === 'essay' ? ' · essay' : ''}</span>
    </div>`);
    if (r.stuck === false) {
      rows.push(`<div class="row"><span class="s-didnt_stick">${esc(r.label)}: didn't stick — check this field</span></div>`);
    }
  }
  for (const s of st.skipped || []) {
    rows.push(`<div class="row"><span>${esc(s.label)}</span><span class="muted">skipped: ${esc(s.reason)}</span></div>`);
  }
  $('results').innerHTML = rows.join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
