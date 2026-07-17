import { collectFields } from '../lib/scraper.js';
import { applyMapping } from '../lib/filler.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'jobfill.scrape') {
    sendResponse({ fields: collectFields(document), pageContext: pageContext() });
    return;
  }
  if (msg.type === 'jobfill.fill') {
    applyMapping(msg.mapping, msg.attachments || {})
      .then(results => sendResponse({ results }))
      .catch(e => sendResponse({ results: [], error: String(e) }));
    return true; // keep the channel open for the async response
  }
});

function pageContext() {
  return {
    url: location.href.slice(0, 300),
    title: (document.title || '').slice(0, 200),
    heading: (document.querySelector('h1, h2')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}
