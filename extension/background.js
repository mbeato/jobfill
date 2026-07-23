import { enforceIdentity, isBankableSkip } from './lib/identity.js';
import { resolveTargetTab } from './lib/trigger.js';
import { mapFields } from './lib/mapping-client.js';

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

// Shared jobfill.trigger handler for both message surfaces. Rejections (bad url
// pattern, missing url/tabId) are converted to an error response so the caller
// always hears back and the channel never leaks.
function handleTrigger(msg, sender, sendResponse) {
  resolveTargetTab(msg, sender)
    .then(tabId => runFill(tabId, msg.force, { queueId: msg.queueId }))
    .catch(e => ({ state: 'error', error: String(e?.message || e) }))
    .then(sendResponse);
  return true; // keep the channel open — sendResponse fires once the fill finishes
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
    return handleTrigger(msg, sender, sendResponse);
  }
});

// Messages sent from the externally_connectable dashboard page arrive HERE, not at
// onMessage — without this listener the dashboard's "Fill now" can never be received.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // Defense-in-depth on top of the manifest's externally_connectable matches:
  // only the helper dashboard may trigger.
  if (!sender.url?.startsWith('http://127.0.0.1:7877/')) return;
  if (msg.type === 'jobfill.trigger') {
    return handleTrigger(msg, sender, sendResponse);
  }
});

async function setStatus(patch) {
  const { jobfillStatus } = await chrome.storage.session.get('jobfillStatus');
  // Stamp stage transitions so the popup can show a live per-stage elapsed timer.
  const stamped = patch.state && patch.state !== jobfillStatus?.state
    ? { ...patch, stageStartedAt: Date.now() }
    : patch;
  await chrome.storage.session.set({ jobfillStatus: { ...jobfillStatus, ...stamped } });
}

async function runFill(tabId, force = false, opts = {}) {
  const { queueId } = opts;
  // MV3 service workers idle out after ~30s without extension API activity; a periodic
  // no-op storage read resets the timer so the long Claude call can't strand the run.
  const heartbeat = setInterval(() => chrome.storage.session.get('jobfillStatus'), 20000);
  try {
    await chrome.storage.session.set({
      jobfillStatus: { state: 'scraping', tabId, startedAt: Date.now() },
    });

    let { apiKey, profile, resume } = await chrome.storage.local.get(['apiKey', 'profile', 'resume']);
    // Self-seed the profile from the helper (profile.local.json is the source of
    // truth on disk) so the extension works in any browser the helper can reach.
    if (!profile) {
      try {
        profile = await helperFetch('/profile');
        await chrome.storage.local.set({ profile });
      } catch {
        // helper down — fall through to the hard error below
      }
    }
    if (!profile) throw new Error('No profile imported — open jobfill options (or start the helper).');
    // The API key is only needed for the direct-API FALLBACK — mapping is
    // helper-first via the subscription-billed claude CLI (/map). Gate hard only
    // when both the key is missing AND the helper is unreachable.
    if (!apiKey) {
      try {
        await helperFetch('/health');
      } catch {
        throw new Error('No API key set and local helper unreachable — open jobfill options, or start the helper (bun run helper).');
      }
    }

    // Scrape every frame that has our content script
    const scrapeAll = async () => {
      const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
      const perFrame = [];
      let responded = 0;
      for (const f of frames) {
        try {
          const resp = await chrome.tabs.sendMessage(tabId, { type: 'jobfill.scrape' }, { frameId: f.frameId });
          responded++;
          if (resp?.fields?.length) perFrame.push({ frameId: f.frameId, ...resp });
        } catch {
          // frame without content script (chrome://, cross-origin about:blank) — ignore
        }
      }
      return { perFrame, responded };
    };
    let { perFrame, responded } = await scrapeAll();
    // Self-heal orphaned content scripts: reloading the extension disconnects the
    // script in every already-open tab, which reads as "no fillable fields" on
    // pages that obviously have them. If NO frame answered, re-inject and retry.
    if (responded === 0) {
      try {
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.bundle.js'] });
        await new Promise((r) => setTimeout(r, 300));
        ({ perFrame, responded } = await scrapeAll());
      } catch (e) {
        console.info('jobfill content-script reinject failed', e);
      }
    }
    const fields = perFrame.flatMap(f => f.fields.map(x => ({ ...x, id: `${f.frameId}:${x.id}` })));
    if (!fields.length) {
      throw new Error(responded === 0
        ? 'Content script not reachable in this tab — refresh the page and try again.'
        : 'No fillable fields found on this page.');
    }

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

    // QUEUE-02: advance the queue row to 'filling' now that this run is committed to
    // (past the duplicate early-return, so a duplicate never leaves a row stuck there).
    // Fail-open — a failed PATCH must never abort the fill (D-02: never 'submitted').
    if (queueId) {
      try {
        await helperFetch(`/queue/${queueId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'filling' }),
        });
      } catch (e) {
        console.info('jobfill queue-status update skipped (helper unavailable)', e);
      }
    }

    // Tailored resume via local helper (headless Claude Code + pdflatex). Falls back
    // to the stored static resume if the helper is down, disabled, or errors. Runs before
    // mapping (D-01) so its summary can be injected into essay drafting.
    const { tailorEnabled = true } = await chrome.storage.local.get('tailorEnabled');
    let attachedResume = resume;
    const jd = perFrame[0].pageContext.jd || '';
    // Same predicate the mapping rules use for attach_resume: if no field could
    // ever receive the PDF (e.g. Work at a Startup reachout boxes), tailoring is
    // minutes of CLI spend for an unattachable artifact — skip it visibly.
    const hasResumeField = fields.some(f => f.type === 'file' && /resume|c\.?v\.?|curriculum/i.test(f.label || ''));
    let tailorState = 'skipped';
    let tailorMessage = !tailorEnabled
      ? 'tailoring disabled in options'
      : !hasResumeField
        ? 'no resume upload field on this page'
        : jd.length < 200
          ? `no usable job description found (${jd.length} chars, need 200+)`
          : null;
    let summary = null;
    if (tailorEnabled && hasResumeField && jd.length >= 200) {
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
        tailorState = 'ran';
        tailorMessage = null;
        summary = t.summary ?? null;
      } catch (e) {
        tailorState = 'error';
        tailorMessage = String(e?.message || e);
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
    const { mapping, cost } = await mapFields({
      apiKey,
      profile,
      fields,
      pageContext,
      summary,
      library,
      helperToken: HELPER_TOKEN,
    });

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
          resume_path: tailorState === 'ran' ? attachedResume.path : '',
          cost_usd: cost,
          summary: tailorState === 'ran' ? summary : null,
          tailor_state: tailorState,
          tailor_message: tailorMessage ?? '',
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
      tailorState,
      tailorMessage,
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

    // QUEUE-02: a completed run counts as 'filled' even when some fields came back
    // needs_manual/verify — that per-field distinction is what RUN-02 is for, not this
    // coarser queue status (Pitfall 3). Fail-open.
    if (queueId) {
      try {
        await helperFetch(`/queue/${queueId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'filled', company: mapping.company || '', role: mapping.role || '', results_summary: JSON.stringify(finalStatus.results), resume_name: attachedResume?.name || '' }),
        });
      } catch (e) {
        console.info('jobfill queue-status update skipped (helper unavailable)', e);
      }
    }

    return finalStatus;
  } catch (e) {
    const errorStatus = { state: 'error', error: String(e?.message || e) };
    await setStatus(errorStatus);

    // QUEUE-02: only a thrown exception (mapping failed, no fields, no API key, etc.)
    // counts as 'failed' (Pitfall 3). Fail-open.
    if (queueId) {
      try {
        await helperFetch(`/queue/${queueId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'failed', error: errorStatus.error }),
        });
      } catch (patchErr) {
        console.info('jobfill queue-status update skipped (helper unavailable)', patchErr);
      }
    }

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
