import { buildRequest, parseMapping } from './lib/prompt.js';
import { callClaude, costUSD } from './lib/anthropic.js';

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
    const pageContext = perFrame[0].pageContext;
    const response = await callClaude(apiKey, buildRequest(profile, fields, pageContext));
    const mapping = parseMapping(response);
    const cost = costUSD(response.usage);

    await setStatus({ state: 'filling', cost });
    const results = [];
    for (const f of perFrame) {
      const frameMapping = mapping.fields
        .filter(m => m.id.startsWith(`${f.frameId}:`))
        .map(m => ({ ...m, id: m.id.slice(String(f.frameId).length + 1) }));
      if (!frameMapping.length) continue;
      const resp = await chrome.tabs.sendMessage(
        tabId,
        { type: 'jobfill.fill', mapping: frameMapping, attachments: { resume } },
        { frameId: f.frameId },
      );
      for (const r of resp?.results || []) results.push({ ...r, id: `${f.frameId}:${r.id}` });
    }

    const labelById = new Map(fields.map(f => [f.id, f.label]));
    await setStatus({
      state: 'done',
      cost,
      results: results.map(r => ({ ...r, label: labelById.get(r.id) || r.id })),
      skipped: mapping.skipped.map(s => ({ ...s, label: labelById.get(s.id) || s.id })),
    });
  } catch (e) {
    await setStatus({ state: 'error', error: String(e?.message || e) });
  }
}
