(function () {
  // Ticket actions on Znuny/OTRS without an API: the extension runs inside the
  // agent's logged-in browser, so it fetches the same popup forms the agent
  // would open, fills them, and posts them back with the form's own
  // ChallengeToken/FormID. Every action is triggered by an explicit click in
  // the side panel; nothing here runs on its own.

  // The side panel may inject this file on demand (chrome.scripting) in
  // addition to the manifest; run only once per page.
  if (window.__ecZnunyActionsLoaded) return;
  window.__ecZnunyActionsLoaded = true;

  const PENDING_REPLY_KEY = "ec-pending-reply";
  const PENDING_REPLY_TTL_MS = 2 * 60 * 1000;

  const href = location.href;
  const isTop = window.top === window;
  const isZoom = /[?;&]Action=AgentTicketZoom\b/.test(href);
  const isCompose = /[?;&]Action=AgentTicketCompose\b/.test(href);

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function currentTicketId() {
    const m = href.match(/[?;&]TicketID=(\d+)/);
    return m ? m[1] : (document.querySelector("input[name='TicketID']")?.value || "");
  }

  function indexUrl(params) {
    const url = new URL(location.pathname, location.origin); // …/otrs/index.pl
    return `${url}?${params}`;
  }

  async function fetchDoc(url, init = {}) {
    const res = await fetch(url, { credentials: "include", ...init });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc.querySelector("#LoginBox, form#Login, input[name='Action'][value='Login']")) {
      throw new Error("Znuny 登录已过期，请刷新页面重新登录");
    }
    return { doc, html, url: res.url || url, status: res.status };
  }

  // The popup's main form (OTRS 6 AgentTicketActionCommon uses id="Compose").
  function findActionForm(doc) {
    return doc.querySelector("form#Compose") ||
      Array.from(doc.querySelectorAll("form")).find((f) =>
        f.querySelector("input[name='Subaction'][value='Store']") && f.querySelector("input[name='TicketID']")
      ) || null;
  }

  // Same fields a browser would submit: skips files/buttons, unchecked boxes.
  function collectFields(form) {
    const pairs = [];
    form.querySelectorAll("input, select, textarea").forEach((el) => {
      const name = el.getAttribute("name");
      if (!name || el.disabled) return;
      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT") {
        if (["file", "button", "submit", "image", "reset"].includes(type)) return;
        if ((type === "checkbox" || type === "radio") && !el.checked) return;
        pairs.push([name, el.value || ""]);
      } else if (tag === "SELECT") {
        const selected = Array.from(el.options).filter((o) => o.selected);
        if (el.multiple) selected.forEach((o) => pairs.push([name, o.value]));
        else pairs.push([name, (selected[0] || el.options[0])?.value || ""]);
      } else {
        pairs.push([name, el.value || el.textContent || ""]);
      }
    });
    return pairs;
  }

  function setField(pairs, name, value) {
    const rest = pairs.filter(([n]) => n !== name);
    if (value !== undefined && value !== null) rest.push([name, String(value)]);
    return rest;
  }

  function normalize(text) {
    return String(text || "").toLowerCase().replace(/[\s,._-]+/g, " ").trim();
  }

  // Match "Julie Cai" against "Julie Cai (jcai)", "Cai, Julie", etc.
  function findOption(select, wanted) {
    if (!select) return null;
    const words = normalize(wanted).split(" ").filter(Boolean);
    return Array.from(select.options).find((o) => {
      if (!o.value) return false;
      const text = normalize(o.textContent);
      return words.every((w) => text.includes(w));
    }) || null;
  }

  function findOptionByPattern(select, re) {
    if (!select) return null;
    return Array.from(select.options).find((o) => o.value && re.test(o.textContent)) || null;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function textToHtml(text) {
    return escapeHtml(String(text || "").replace(/\r/g, "")).replace(/\n/g, "<br/>");
  }

  function isRichText(form) {
    const body = form.querySelector("textarea[name='Body']");
    return Boolean(body && (body.id === "RichText" || body.classList.contains("RichText")));
  }

  function fieldLabel(doc, el) {
    const id = el.getAttribute("id");
    const label = id && doc.querySelector(`label[for='${CSS.escape(id)}']`);
    return (label?.textContent || el.getAttribute("name") || id || "").replace(/[*:：\s]+/g, " ").trim();
  }

  // After POST: a validation failure re-renders the same form with
  // ServerError markers; success returns a page that closes the popup.
  function analyzeResponse(doc) {
    const errors = Array.from(doc.querySelectorAll(".ServerError"))
      .map((el) => fieldLabel(doc, el))
      .filter(Boolean);
    const errorBox = doc.querySelector(".MessageBox.Error p, .ErrorScreen .Content, #ServerErrorMsg");
    if (errors.length || (findActionForm(doc) && errorBox)) {
      return { ok: false, error: errors.length ? `表单校验未通过：${[...new Set(errors)].join("、")}` : errorBox.textContent.trim() };
    }
    if (doc.querySelector(".ErrorScreen")) {
      return { ok: false, error: doc.querySelector(".ErrorScreen")?.textContent.replace(/\s+/g, " ").trim().slice(0, 200) };
    }
    return { ok: true };
  }

  async function loadActionForm(action, ticketId) {
    const url = indexUrl(`Action=${action};TicketID=${encodeURIComponent(ticketId)}`);
    const { doc, url: finalUrl } = await fetchDoc(url);
    const form = findActionForm(doc);
    if (!form) {
      const msg = doc.querySelector(".ErrorScreen, .MessageBox p")?.textContent.replace(/\s+/g, " ").trim();
      throw new Error(msg ? `无法打开 ${action}：${msg.slice(0, 160)}` : `在 ${action} 页面没有找到表单`);
    }
    return { doc, form, url: finalUrl };
  }

  async function submitForm(form, baseUrl, pairs) {
    const target = new URL(form.getAttribute("action") || "index.pl", baseUrl).toString();
    const data = new FormData();
    pairs.forEach(([n, v]) => data.append(n, v));
    const { doc } = await fetchDoc(target, { method: "POST", body: data });
    return analyzeResponse(doc);
  }

  // Note fields shared by note / owner / close.
  function applyNote(form, pairs, { subject, body, internal = true }) {
    if (subject !== undefined && form.querySelector("[name='Subject']")) pairs = setField(pairs, "Subject", subject);
    if (body !== undefined && form.querySelector("[name='Body']")) {
      pairs = setField(pairs, "Body", isRichText(form) ? textToHtml(body) : body);
    }
    if (internal) {
      pairs = setField(pairs, "IsVisibleForCustomer", null); // OTRS 6: unchecked = internal
      const typeSelect = form.querySelector("select[name='ArticleTypeID']"); // OTRS 5
      const internalType = findOptionByPattern(typeSelect, /note-internal|内部/i);
      if (internalType) pairs = setField(pairs, "ArticleTypeID", internalType.value);
    }
    return pairs;
  }

  // ─── Actions ────────────────────────────────────────────────────────────────

  async function addNote(ticketId, { subject, body }) {
    if (!String(body || "").trim()) throw new Error("备注内容不能为空");
    const { form, url } = await loadActionForm("AgentTicketNote", ticketId);
    let pairs = applyNote(form, collectFields(form), { subject: subject || "内部备注", body });
    return submitForm(form, url, pairs);
  }

  async function changeOwner(ticketId, { owner, title, subject, body }) {
    const { form, url } = await loadActionForm("AgentTicketOwner", ticketId);
    const select = form.querySelector("select[name='NewOwnerID']");
    if (!select) throw new Error("转交表单里没有找到负责人（NewOwnerID）字段");
    const option = findOption(select, owner);
    if (!option) throw new Error(`负责人列表里没有找到「${owner}」`);

    let pairs = collectFields(form);
    pairs = setField(pairs, "NewOwnerID", option.value);
    if (form.querySelector("[name='NewOwnerType']")) pairs = setField(pairs, "NewOwnerType", "New");
    const warnings = [];
    if (title) {
      if (form.querySelector("[name='Title']")) pairs = setField(pairs, "Title", title);
      else warnings.push("转交表单里没有标题字段，标题未修改");
    }
    pairs = applyNote(form, pairs, { subject: subject || title || "转交", body: body || subject || title || "转交" });
    const result = await submitForm(form, url, pairs);
    return { ...result, owner: option.textContent.trim(), warnings };
  }

  async function closeTicket(ticketId, { state, subject, body }) {
    const { form, url } = await loadActionForm("AgentTicketClose", ticketId);
    const select = form.querySelector("select[name='NewStateID']");
    const option = state === "unsuccessful"
      ? findOptionByPattern(select, /closed unsuccessful|关闭.*(未|不)成功|失败/i)
      : findOptionByPattern(select, /closed successful|成功关闭|关闭.*成功/i);
    if (!option) throw new Error("关闭表单里没有找到对应的关闭状态");
    let pairs = setField(collectFields(form), "NewStateID", option.value);
    pairs = applyNote(form, pairs, { subject: subject || "关闭工单", body: body || "关闭工单" });
    const result = await submitForm(form, url, pairs);
    return { ...result, state: option.textContent.trim() };
  }

  // Lock/unlock are plain links on the zoom page carrying the ChallengeToken.
  async function setLock(ticketId, lock) {
    const sub = lock ? "Lock" : "Unlock";
    let link = document.querySelector(`a[href*='AgentTicketLock'][href*='Subaction=${sub}']`)?.getAttribute("href");
    if (!link) {
      const token = document.querySelector("input[name='ChallengeToken']")?.value;
      if (!token) throw new Error(lock ? "工单可能已被锁定（页面上没有「锁定」链接）" : "工单可能未被锁定（页面上没有「解锁」链接）");
      link = indexUrl(`Action=AgentTicketLock;Subaction=${sub};TicketID=${ticketId};ChallengeToken=${token}`);
    }
    const { doc } = await fetchDoc(new URL(link, location.href).toString());
    return analyzeResponse(doc);
  }

  // Reply: the agent's own reply window, opened by the panel, gets the draft.
  function replyUrl(ticketId, root = document, base = location.href) {
    const forms = Array.from(root.querySelectorAll("form[id^='Reply']"))
      .filter((f) => f.querySelector("input[name='Action'][value='AgentTicketCompose']"));
    if (!forms.length) throw new Error("页面上没有找到回复表单");
    // Latest article = highest ArticleID.
    const form = forms.sort((a, b) =>
      Number(b.querySelector("input[name='ArticleID']")?.value || 0) - Number(a.querySelector("input[name='ArticleID']")?.value || 0)
    )[0];
    const select = form.querySelector("select[name='ResponseID']");
    const empty = findOptionByPattern(select, /empty answer|空白|空回复/i);
    const params = new URLSearchParams();
    form.querySelectorAll("input[type='hidden']").forEach((i) => params.set(i.name, i.value));
    params.set("Action", "AgentTicketCompose");
    params.set("TicketID", ticketId);
    params.set("ResponseID", empty ? empty.value : "");
    return { url: new URL(`${form.getAttribute("action") || "index.pl"}?${params}`, base).toString(), template: empty?.textContent.trim() || "" };
  }

  // ─── Reply from the queue page (no zoom page open) ──────────────────────────

  async function composeUrlFor(ticketId) {
    const { doc, url } = await fetchDoc(indexUrl(`Action=AgentTicketZoom;TicketID=${encodeURIComponent(ticketId)}`));
    return replyUrl(ticketId, doc, url).url;
  }

  // Opens the agent's own reply window with the draft filled in, for review.
  // Pass a window opened synchronously in the click handler (`win`): after
  // the awaits here the click no longer counts and a new popup is blocked.
  async function openReplyDraft(ticketId, { text, win }) {
    const url = await composeUrlFor(ticketId);
    await chrome.storage.local.set({ [PENDING_REPLY_KEY]: { ticketId: String(ticketId), text, ts: Date.now() } });
    if (win && !win.closed) win.location.href = url;
    else if (!window.open(url, `ec-reply-${ticketId}`, "width=1100,height=850")) throw new Error("回复窗口被浏览器拦截，请允许本站弹出窗口");
    return { ok: true };
  }

  // Shared with queue-triage.js (same content-script world).
  window.__ecZnuny = { addNote, changeOwner, openReplyDraft, indexUrl, fetchDoc };

  // Read-only: what the plugin would see in a popup form.
  async function inspectForm(ticketId, action) {
    const { doc, form } = await loadActionForm(action, ticketId);
    const fields = Array.from(form.querySelectorAll("input, select, textarea"))
      .filter((el) => el.getAttribute("name") && !["hidden"].includes((el.getAttribute("type") || "").toLowerCase()) || ["ChallengeToken", "FormID", "Subaction"].includes(el.getAttribute("name")))
      .map((el) => {
        const name = el.getAttribute("name");
        const entry = { name, label: fieldLabel(doc, el), type: el.tagName === "INPUT" ? (el.getAttribute("type") || "text") : el.tagName.toLowerCase() };
        if (["ChallengeToken", "FormID"].includes(name)) entry.value = el.value ? "(有)" : "(空)";
        if (el.tagName === "SELECT") entry.options = Array.from(el.options).slice(0, 40).map((o) => o.textContent.trim()).filter(Boolean);
        if (el.classList.contains("Validate_Required") || doc.querySelector(`label.Mandatory[for='${CSS.escape(el.id || "_")}']`)) entry.required = true;
        return entry;
      });
    return { ok: true, action, richText: isRichText(form), fields };
  }

  // ─── Message handling (zoom page, top frame only) ───────────────────────────

  if (isTop && isZoom) {
    // Check in the page console: document.documentElement.dataset.ecActions
    document.documentElement.dataset.ecActions = "2026-11-17.3";
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "EC_ZNUNY_ACTION") return false;
      const ticketId = currentTicketId();
      const p = message.params || {};
      const run = {
        info: async () => ({ ok: true, ticketId, ticketNumber: (document.title.match(/\d{10,}/) || [""])[0] }),
        note: () => addNote(ticketId, p),
        owner: () => changeOwner(ticketId, p),
        close: () => closeTicket(ticketId, p),
        lock: () => setLock(ticketId, true),
        unlock: () => setLock(ticketId, false),
        replyUrl: async () => ({ ok: true, ticketId, ...replyUrl(ticketId) }),
        inspect: () => inspectForm(ticketId, p.action)
      }[message.action];

      if (!run) {
        sendResponse({ ok: false, error: `未知操作：${message.action}` });
        return false;
      }
      Promise.resolve()
        .then(run)
        .then((result) => sendResponse({ ticketId, ...result }))
        .catch((error) => sendResponse({ ok: false, ticketId, error: error?.message || String(error) }));
      return true;
    });
  }

  // ─── Reply window: insert the pending draft ─────────────────────────────────

  if (isTop && isCompose) {
    chrome.storage.local.get(PENDING_REPLY_KEY).then((stored) => {
      const pending = stored[PENDING_REPLY_KEY];
      if (!pending) return;
      const ticketId = currentTicketId();
      const fresh = Date.now() - (pending.ts || 0) < PENDING_REPLY_TTL_MS;
      if (!fresh || String(pending.ticketId) !== String(ticketId)) return;
      chrome.storage.local.remove(PENDING_REPLY_KEY);
      // CKEditor lives in the page's own JS world; background.js injects there.
      // Znuny adds the agent's signature; drop a sign-off the AI may have
      // written itself so it isn't doubled.
      const text = String(pending.text || "")
        .replace(/\n\s*(best|kind|warm)\s+regards\b[\s\S]{0,200}$/i, "")
        .replace(/\n\s*(sincerely|regards),?\s*(\n[^\n]{0,60}){0,3}\s*$/i, "")
        .trimEnd();
      chrome.runtime.sendMessage({ type: "EC_FILL_REPLY", html: textToHtml(text), text });
    }).catch(() => {});
  }
})();
