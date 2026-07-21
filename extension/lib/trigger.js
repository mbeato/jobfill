// Resolves the tab a jobfill.trigger message should act on. Explicit url/tabId first
// (the only safe resolution for an external/dashboard caller — see Pitfall 1); bare
// active-tab resolution is reserved for the popup's own path, where the caller and the
// tab it cares about are the same tab by construction.
// Bound on waiting for a created tab to finish loading — without it a tab that never
// completes (closed early, hung load) leaves the trigger's message channel open forever.
export const CREATED_TAB_TIMEOUT_MS = 60_000;

export async function resolveTargetTab(msg, sender, deps = {}) {
  const tabsQuery = deps.tabsQuery || chrome.tabs.query.bind(chrome.tabs);
  const tabsCreate = deps.tabsCreate || chrome.tabs.create.bind(chrome.tabs);
  const onUpdated = deps.onUpdated || chrome.tabs.onUpdated;
  const onRemoved = deps.onRemoved || chrome.tabs.onRemoved;
  const runtimeId = deps.runtimeId ?? chrome.runtime.id;

  if (typeof msg.tabId === 'number') return msg.tabId;

  if (msg.url) {
    // tabs.query treats url as a match pattern, not a literal: a #fragment makes the
    // pattern invalid (query throws) and job-posting URLs routinely carry them. Strip
    // the fragment, and treat a still-invalid pattern as "no open tab" so the trigger
    // falls through to creating a fresh tab instead of rejecting.
    const pattern = msg.url.split('#')[0];
    let tabs = [];
    try {
      tabs = (await tabsQuery({ url: pattern })) || [];
    } catch {
      // invalid match pattern — fall through to tabsCreate below
    }
    if (tabs.length) return tabs[0].id;

    const created = await tabsCreate({ url: msg.url, active: true });
    // Settle on load-complete, tab-removed, or timeout — whichever fires first —
    // and clean up both listeners plus the timer on every exit path.
    return new Promise((resolve, reject) => {
      function cleanup() {
        clearTimeout(timer);
        onUpdated.removeListener(updateListener);
        onRemoved.removeListener(removeListener);
      }
      function updateListener(tabId, changeInfo) {
        if (tabId === created.id && changeInfo.status === 'complete') {
          cleanup();
          resolve(tabId);
        }
      }
      function removeListener(tabId) {
        if (tabId === created.id) {
          cleanup();
          reject(new Error('created tab was closed before it finished loading'));
        }
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`created tab did not finish loading within ${CREATED_TAB_TIMEOUT_MS / 1000}s`));
      }, CREATED_TAB_TIMEOUT_MS);
      onUpdated.addListener(updateListener);
      onRemoved.addListener(removeListener);
    });
  }

  // Discriminate on sender identity, not url presence: the extension's own pages
  // (popup, options) also carry a url/origin, but their sender.id is this extension's
  // id — only web-page senders (dashboard via onMessageExternal) lack it.
  const isExternal = sender?.id !== runtimeId;
  if (!isExternal) {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    return tabs[0].id;
  }

  throw new Error('trigger requires a url or tabId');
}
