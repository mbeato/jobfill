import { buildRequest, parseMapping } from './lib/prompt.js';
import { callClaude, costUSD } from './lib/anthropic.js';
import { enforceIdentity, isBankableSkip } from './lib/identity.js';
import { resolveTargetTab } from './lib/trigger.js';

const HELPER = 'http://127.0.0.1:7877';
// Must match TOKEN in helper/server.ts — the helper rejects unauthenticated cross-origin callers.
const HELPER_TOKEN = 'REDACTED-TOKEN';
// Mirrors lib/identity.js — gates which skipped fields are safe to bank as free-text Q&A
// (a skipped dropdown/radio/checkbox with a hand-picked option value must never be captured).
const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'textarea']);

async function helperFetch(path, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HELPER}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), 'x-jobfill-token': HELPER_TOKEN },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `helper ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'jobfill.run') {
    runFill(msg.tabId, msg.force);
    sendResponse({ ok: true });
  }
  if (msg.type === 'jobfill.capture') {
    captureAnswers(msg.tabId);
    sendResponse({ ok: true });
  }
  if (msg.type === 'jobfill.trigger') {
    resolveTargetTab(msg, sender)
      .then(tabId => runFill(tabId, msg.force, { queueId: msg.queueId }))
      .then(sendResponse);
    return true; // keep the channel open — sendResponse fires once the fill finishes
  }
});

async function setStatus(patch) {
  const { jobfillStatus } = await chrome.storage.session.get('jobfillStatus');
  await chrome.storage.session.set({ jobfillStatus: { ...jobfillStatus, ...patch } });
}

async function runFill(tabId, force = false, opts = {}) {
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

    const pageContext = {
      ...perFrame[0].pageContext,
      frames: perFrame.map(f => ({ id: f.frameId, url: f.pageContext.url })),
    };
    if (!force) {
      try {
        const prior = await helperFetch('/applications?url=' + encodeURIComponent(pageContext.url));
        if (prior?.length) {
          const p = prior[0];
          const duplicateStatus = {
            state: 'duplicate',
            tabId,
            prior: { company: p.company, role: p.role, url: p.url, created_at: p.created_at },
          };
          await setStatus(duplicateStatus);
          return duplicateStatus;
        }
      } catch (e) {
        // helper unreachable/erroring — fail open, don't block the fill
        console.info('jobfill duplicate check skipped (helper unavailable)', e);
      }
    }

    // Tailored resume via local helper (headless Claude Code + pdflatex). Falls back
    // to the stored static resume if the helper is down, disabled, or errors. Runs before
    // mapping (D-01) so its summary can be injected into essay drafting.
    const { tailorEnabled = true } = await chrome.storage.local.get('tailorEnabled');
    let attachedResume = resume;
    let tailored = false;
    let tailorError = null;
    let summary = null;
    const jd = perFrame[0].pageContext.jd || '';
    if (tailorEnabled && jd.length >= 200) {
      try {
        await helperFetch('/health');
        await setStatus({ state: 'tailoring', company: pageContext.heading || pageContext.title || '' });
        const t = await helperFetch('/tailor', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jd, url: pageContext.url, company: '', role: '' }),
        }, 8 * 60 * 1000);
        attachedResume = { name: t.name, mime: t.mime, b64: t.b64 };
        attachedResume.path = t.path;
        tailored = true;
        summary = t.summary ?? null;
      } catch (e) {
        tailorError = String(e?.message || e);
      }
    }

    let library = null;
    try {
      library = await helperFetch('/answers/match?questions=' + encodeURIComponent(JSON.stringify(fields.map(f => f.label))));
    } catch (e) {
      // helper unreachable/erroring — fail open, essays draft without library context
      console.info('jobfill library fetch skipped (helper unavailable)', e);
    }

    await setStatus({ state: 'mapping', fieldCount: fields.length });
    const response = await callClaude(apiKey, buildRequest(profile, fields, pageContext, summary, library));
    const mapping = parseMapping(response);
    const cost = costUSD(response.usage);

    const identity = enforceIdentity(mapping, fields, profile);
    mapping.fields = identity.fields;
    mapping.skipped = identity.skipped;
    const corrections = identity.corrections;
    if (corrections.length) console.info('jobfill identity corrections', corrections);

    await setStatus({ state: 'filling', cost });
    const results = [];
    const failureRecords = [];
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
        for (const rec of resp?.failureRecords || []) failureRecords.push({ ...rec, id: `${f.frameId}:${rec.id}` });
      } catch {
        // frame navigated or was removed during the Claude call — report its fields, keep going
        for (const m of frameMapping) results.push({ id: `${f.frameId}:${m.id}`, status: 'frame_error', kind: m.kind, confidence: m.confidence, reused: m.reused });
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
          summary: tailored ? summary : null,
        }),
      });
    } catch {
      // helper down — totals in the popup still cover spend
    }

    const labelById = new Map(fields.map(f => [f.id, f.label]));

    // D-05/D-06: ship captured widget-failure evidence to the helper, fail-open.
    const enrichedFailureRecords = failureRecords.map(r => ({ ...r, label: labelById.get(r.id) || r.id }));
    let failuresSaved = true;
    if (enrichedFailureRecords.length) {
      try {
        await helperFetch('/failures', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: pageContext.url, records: enrichedFailureRecords }),
        });
      } catch (e) {
        failuresSaved = false;
        console.info('jobfill failure-capture skipped (helper unavailable)', e);
      }
    }

    const finalStatus = {
      state: 'done',
      cost,
      tailored,
      tailorError,
      summary,
      company: mapping.company,
      role: mapping.role,
      results: results.map(r => ({ ...r, label: labelById.get(r.id) || r.id })),
      skipped: mapping.skipped.map(s => ({ ...s, label: labelById.get(s.id) || s.id })),
      corrections: corrections.map(c => ({ ...c, label: labelById.get(c.id) || c.id })),
      failuresSaved,
      ...(failuresSaved ? {} : { failureRecords: enrichedFailureRecords }),
    };
    await setStatus(finalStatus);
    return finalStatus;
  } catch (e) {
    const errorStatus = { state: 'error', error: String(e?.message || e) };
    await setStatus(errorStatus);
    return errorStatus;
  } finally {
    clearInterval(heartbeat);
  }
}

// Explicit, popup-triggered capture (D-01/D-02/D-03): re-scrapes the page and banks the operator's
// post-edit answers for this run's own essay fields plus any free-text fields he hand-filled
// after the model skipped them. Never scrapes or banks fields outside those two label sets.
// Skipped fields banked from unrelated-frame (third-party chat/support/cookie-consent) or
// already-filled (pre-filled/autofilled PII) reasons are excluded (see the filter below).
async function captureAnswers(tabId) {
  try {
    const { jobfillStatus } = await chrome.storage.session.get('jobfillStatus');
    const essayLabels = new Set((jobfillStatus?.results || []).filter(r => r.kind === 'essay').map(r => r.label));
    const skippedLabels = new Set((jobfillStatus?.skipped || []).filter(s => isBankableSkip(s.reason)).map(s => s.label));

    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    const perFrame = [];
    for (const f of frames) {
      try {
        const resp = await chrome.tabs.sendMessage(tabId, { type: 'jobfill.scrape' }, { frameId: f.frameId });
        if (resp?.fields?.length) perFrame.push({ frameId: f.frameId, ...resp });
      } catch {
        // frame without content script — ignore
      }
    }
    const freshFields = perFrame.flatMap(f => f.fields);
    if (!freshFields.length) {
      await setStatus({ bankedCount: 0, captureError: null });
      return;
    }

    const answers = [];
    for (const label of essayLabels) {
      const field = freshFields.find(f => f.label === label && String(f.value ?? '').trim());
      if (field) answers.push({ question: label, answer: field.value.trim() });
    }
    for (const label of skippedLabels) {
      const field = freshFields.find(f => f.label === label && TEXT_TYPES.has(f.type) && String(f.value ?? '').trim());
      if (field) answers.push({ question: label, answer: field.value.trim() });
    }

    if (!answers.length) {
      await setStatus({ bankedCount: 0, captureError: null });
      return;
    }

    const url = perFrame[0]?.pageContext?.url || '';
    try {
      const resp = await helperFetch('/answers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, answers }),
      });
      await setStatus({ bankedCount: resp.banked, captureError: null });
    } catch (e) {
      console.info('jobfill capture skipped (helper unavailable)', e);
      await setStatus({ bankedCount: null, captureError: true });
    }
  } catch (e) {
    console.info('jobfill capture failed', e);
    await setStatus({ bankedCount: null, captureError: true });
  }
}
