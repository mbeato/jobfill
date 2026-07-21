// Resolves the tab a jobfill.trigger message should act on. Explicit url/tabId first
// (the only safe resolution for an external/dashboard caller — see Pitfall 1); bare
// active-tab resolution is reserved for the popup's own path, where the caller and the
// tab it cares about are the same tab by construction.
export async function resolveTargetTab(msg, sender, deps = {}) {
  const tabsQuery = deps.tabsQuery || chrome.tabs.query.bind(chrome.tabs);
  const tabsCreate = deps.tabsCreate || chrome.tabs.create.bind(chrome.tabs);
  const onUpdated = deps.onUpdated || chrome.tabs.onUpdated;

  if (typeof msg.tabId === 'number') return msg.tabId;

  if (msg.url) {
    const tabs = await tabsQuery({ url: msg.url });
    if (tabs && tabs.length) return tabs[0].id;

    const created = await tabsCreate({ url: msg.url, active: true });
    return new Promise(resolve => {
      function listener(tabId, changeInfo) {
        if (tabId === created.id && changeInfo.status === 'complete') {
          onUpdated.removeListener(listener);
          resolve(tabId);
        }
      }
      onUpdated.addListener(listener);
    });
  }

  // Only the popup's own path has neither an external url/origin nor an explicit tabId.
  const isExternal = Boolean(sender?.url || sender?.origin);
  if (!isExternal) {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    return tabs[0].id;
  }

  throw new Error('trigger requires a url or tabId');
}
