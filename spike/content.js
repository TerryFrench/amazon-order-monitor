// AOM Spike content script (runs on https://example.com/*).
// On load, push a ping to the service worker — same shape as the real
// extension's scrape-result push (experiment B).

(function () {
  chrome.runtime.sendMessage(
    {
      type: "SPIKE_PING",
      ts: new Date().toISOString(),
      title: document.title,
      url: location.href
    },
    () => void chrome.runtime.lastError // swallow "no receiver" noise
  );
})();
