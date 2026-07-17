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
    jd: jdText(),
  };
}

// best-effort job-description capture for resume tailoring
function jdText() {
  const el = document.querySelector('main, article, [class*="description"], [id*="description"]') || document.body;
  return (el.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
}
