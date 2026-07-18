import { buildRequest, parseMapping } from './lib/prompt.js';
import { callClaude, costUSD } from './lib/anthropic.js';
import { enforceIdentity } from './lib/identity.js';

const HELPER = 'http://127.0.0.1:7877';

async function helperFetch(path, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HELPER}${path}`, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `helper ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'jobfill.run') {
    runFill(msg.tabId);
    sendResponse({ ok: true });
  }
});

async function setStatus(patch) {
  const { jobfillStatus } = await chrome.storage.session.get('jobfillStatus');
  await chrome.storage.session.set({ jobfillStatus: { ...jobfillStatus, ...patch } });
}

async function runFill(tabId) {
  // MV3 service workers idle out after ~30s without extension API activity; a periodic
  // no-op storage read resets the timer so the long Claude call can't strand the run.
  const heartbeat = setInterval(() => chrome.storage.session.get('jobfillStatus'), 20000);
  try {
    await chrome.storage.session.set({
      jobfillStatus: { state: 'scraping', tabId, startedAt: Date.now() },
    });

    const { apiKey, profile, resume } = await chrome.storage.local.get(['apiKey', 'profile', 'resume']);
    if (!apiKey) throw new Error('No API key set — open jobfill options.');
    if (!profile) throw new Error('No profile imported — open jobfill options.');

    // Scrape every frame that has our content script
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    const perFrame = [];
    for (const f of frames) {
      try {
        const resp = await chrome.tabs.sendMessage(tabId, { type: 'jobfill.scrape' }, { frameId: f.frameId });
        if (resp?.fields?.length) perFrame.push({ frameId: f.frameId, ...resp });
      } catch {
        // frame without content script (chrome://, cross-origin about:blank) — ignore
      }
    }
    const fields = perFrame.flatMap(f => f.fields.map(x => ({ ...x, id: `${f.frameId}:${x.id}` })));
    if (!fields.length) throw new Error('No fillable fields found on this page.');

    await setStatus({ state: 'mapping', fieldCount: fields.length });
    const pageContext = {
      ...perFrame[0].pageContext,
      frames: perFrame.map(f => ({ id: f.frameId, url: f.pageContext.url })),
    };
    const response = await callClaude(apiKey, buildRequest(profile, fields, pageContext));
    const mapping = parseMapping(response);
    const cost = costUSD(response.usage);

    const identity = enforceIdentity(mapping, fields, profile);
    mapping.fields = identity.fields;
    mapping.skipped = identity.skipped;
    const corrections = identity.corrections;
    if (corrections.length) console.info('jobfill identity corrections', corrections);

    // Tailored resume via local helper (headless Claude Code + pdflatex). Falls back
    // to the stored static resume if the helper is down, disabled, or errors.
    const { tailorEnabled = true } = await chrome.storage.local.get('tailorEnabled');
    let attachedResume = resume;
    let tailored = false;
    let tailorError = null;
    const jd = perFrame[0].pageContext.jd || '';
    if (tailorEnabled && jd.length >= 200) {
      try {
        await helperFetch('/health');
        await setStatus({ state: 'tailoring', cost, company: mapping.company, role: mapping.role });
        const t = await helperFetch('/tailor', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ company: mapping.company, role: mapping.role, jd, url: pageContext.url }),
        }, 8 * 60 * 1000);
        attachedResume = { name: t.name, mime: t.mime, b64: t.b64 };
        attachedResume.path = t.path;
        tailored = true;
      } catch (e) {
        tailorError = String(e?.message || e);
      }
    }

    await setStatus({ state: 'filling', cost });
    const results = [];
    for (const f of perFrame) {
      const frameMapping = mapping.fields
        .filter(m => m.id.startsWith(`${f.frameId}:`))
        .map(m => ({ ...m, id: m.id.slice(String(f.frameId).length + 1) }));
      if (!frameMapping.length) continue;
      try {
        const resp = await chrome.tabs.sendMessage(
          tabId,
          { type: 'jobfill.fill', mapping: frameMapping, attachments: { resume: attachedResume } },
          { frameId: f.frameId },
        );
        for (const r of resp?.results || []) results.push({ ...r, id: `${f.frameId}:${r.id}` });
      } catch {
        // frame navigated or was removed during the Claude call — report its fields, keep going
        for (const m of frameMapping) results.push({ id: `${f.frameId}:${m.id}`, status: 'frame_error' });
      }
    }

    const { jobfillTotals } = await chrome.storage.local.get('jobfillTotals');
    await chrome.storage.local.set({
      jobfillTotals: {
        spendUSD: (jobfillTotals?.spendUSD ?? 0) + cost,
        fills: (jobfillTotals?.fills ?? 0) + 1,
      },
    });

    // auto-log the application in the helper's tracker (best effort)
    try {
      await helperFetch('/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          company: mapping.company || pageContext.heading || pageContext.title || 'unknown',
          role: mapping.role || '',
          url: pageContext.url,
          resume_path: tailored ? attachedResume.path : '',
          cost_usd: cost,
        }),
      });
    } catch {
      // helper down — totals in the popup still cover spend
    }

    const labelById = new Map(fields.map(f => [f.id, f.label]));
    await setStatus({
      state: 'done',
      cost,
      tailored,
      tailorError,
      company: mapping.company,
      role: mapping.role,
      results: results.map(r => ({ ...r, label: labelById.get(r.id) || r.id })),
      skipped: mapping.skipped.map(s => ({ ...s, label: labelById.get(s.id) || s.id })),
      corrections: corrections.map(c => ({ ...c, label: labelById.get(c.id) || c.id })),
    });
  } catch (e) {
    await setStatus({ state: 'error', error: String(e?.message || e) });
  } finally {
    clearInterval(heartbeat);
  }
}
