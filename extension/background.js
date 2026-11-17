chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

// Backend proxy for content scripts. Requests from a content script run under
// the Znuny page's origin (HTTPS), which blocks plain-HTTP localhost calls; the
// service worker has host permission for the backend and is not affected.
const DEFAULT_BACKEND_URL = "http://localhost:8787";

// Fill the AI draft into Znuny's reply editor. CKEditor only exists in the
// page's own JS world, which content scripts can't reach, so inject there.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "EC_FILL_REPLY" || !sender.tab?.id) return false;
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
    world: "MAIN",
    args: [message.html, message.text],
    func: (draftHtml, draftText) => {
      // The reply is opened with the "Empty Answer" template, so the editor
      // already holds the agent's signature ("Best Regards, … AVCLabs Support
      // Team …") and the quoted original. Put the draft right above whichever
      // comes first and keep everything from there on.
      function firstIndex(text, patterns) {
        return patterns
          .map((re) => text.search(re))
          .filter((i) => i >= 0)
          .reduce((min, i) => Math.min(min, i), Infinity);
      }
      const SIGNATURE = [/Best\s+Regards/i, /Kind\s+Regards/i, /AVCLabs Support Team/i];
      const QUOTE = [/<[^>]*>[^<]*(wrote|写道)\s*[:：]/i, /<div[^>]+type=["']cite["']/i, /<blockquote/i];
      function merge(existing) {
        const at = firstIndex(existing, [...SIGNATURE, ...QUOTE]);
        if (at === Infinity) return `${draftHtml}<br/><br/>${existing}`;
        return `${existing.slice(0, at)}${draftHtml}<br/><br/>${existing.slice(at)}`;
      }
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        const editor = window.CKEDITOR?.instances?.RichText;
        if (editor && editor.status === "ready") {
          clearInterval(timer);
          editor.setData(merge(editor.getData()));
          editor.focus();
          return;
        }
        const plain = document.querySelector("textarea#RichText");
        if (!window.CKEDITOR && plain && tries > 4) {
          clearInterval(timer);
          const idx = firstIndex(plain.value, [...SIGNATURE, /^.*(wrote|写道)\s*[:：]/im]);
          plain.value = idx === Infinity
            ? draftText + "\n\n" + plain.value
            : plain.value.slice(0, idx) + draftText + "\n\n" + plain.value.slice(idx);
          return;
        }
        if (tries > 60) clearInterval(timer); // ~15s
      }, 250);
    }
  }).catch(() => {});
  return false;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "EC_BACKEND") return false;

  (async () => {
    const { backendUrl } = await chrome.storage.local.get("backendUrl");
    const base = String(backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
    const method = message.method || "GET";
    const response = await fetch(`${base}${message.path}`, {
      method,
      headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(message.body || {})
    });
    const data = await response.json().catch(() => null);
    sendResponse({ ok: response.ok, status: response.status, data });
  })().catch((error) => {
    sendResponse({ ok: false, status: 0, error: error?.message || String(error) });
  });

  return true;
});
