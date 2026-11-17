(function () {
  // Queue-page spam triage (layer 2 of docs/spam-triage-design.md).
  // Rules → shared block/allow lists → AI review for borderline tickets.
  // Only marks tickets; never moves, closes or deletes anything.

  // Bump on every change so a stale script left in an open tab is easy to spot:
  // run `document.documentElement.dataset.ecSpamVersion` in the page console.
  const VERSION = "2026-11-17.7";
  const LEGACY_BLOCKLIST_KEY = "ec-blocked-senders";
  const AI_SPAM_MIN_CONFIDENCE = 0.9;
  const AI_CONCURRENCY = 2;

  // Strong signals only: any single match is spam on its own. Anything weaker
  // (caps, "!!", "seo", promo words, no-reply senders) is left to the AI, which
  // reads the content. Keep in sync with the PostMaster filters in
  // docs/spam-triage-design.md (layer 1).
  const SPAM_RULES = [
    // --- 群发发件人 ---
    { name: "群发发件人 newsletter@/bulk@", field: "sender", pattern: /(^|[._-])(newsletter|bulk)@/i },
    { name: "退信通知 mailer-daemon", field: "sender", pattern: /mailer-daemon@|postmaster@/i },

    // --- 外链 / SEO 推销 ---
    { name: "guest post", field: "text", pattern: /\bguest\s*post/i },
    { name: "do-follow 外链", field: "text", pattern: /\bdo[\s-]?follow\b/i },
    { name: "link building", field: "text", pattern: /\blink[\s-]?build/i },
    { name: "article submission", field: "text", pattern: /\barticle\s*submission/i },
    { name: "DR/DA 外链报价", field: "text", pattern: /\b(dr|da)\s*\d{2}\+?\s*(guest|post|site|link)/i },
    { name: "high DA / authority", field: "text", pattern: /\bhigh\s+(da|domain\s*authority|authority\s+placement)\b/i },
    { name: "promote your website", field: "text", pattern: /\bpromote\s+(your\s+)?website\b/i },

    // --- 新闻稿 / 合作推销 ---
    { name: "press release", field: "text", pattern: /\bpress\s+release\b/i },
    { name: "collaboration opportunity", field: "text", pattern: /\bcollaboration\s+op+ortunity\b/i },

    // --- 系统通知 ---
    { name: "邮件延迟通知", field: "text", pattern: /\bmessage\s+\S+\s+delayed\b/i },
  ];

  // ─── State ──────────────────────────────────────────────────────────────────

  let lists = null;            // shared lists from the backend
  let backendOnline = false;
  const aiResults = new Map(); // ticketId → classify result (this page load)
  const aiQueue = [];
  let aiRunning = 0;

  function log(...args) {
    console.info("[Email Copilot spam]", ...args);
  }

  // ─── Backend (via background.js proxy) ──────────────────────────────────────

  const BACKEND_TIMEOUT_MS = 20000;

  function backend(path, method = "GET", body) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log(`${method} ${path} timed out`);
        resolve({ ok: false, status: 0, error: "timeout" });
      }, BACKEND_TIMEOUT_MS);
      const done = (result) => {
        clearTimeout(timer);
        if (!result.ok) log(`${method} ${path} failed:`, result.error || result.status);
        resolve(result);
      };
      // After the extension is reloaded, scripts left in already-open tabs lose
      // their connection (chrome.runtime.id becomes undefined).
      if (!chrome.runtime?.id) {
        done({ ok: false, status: 0, error: "stale" });
        showStaleNotice();
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: "EC_BACKEND", path, method, body }, (response) => {
          if (chrome.runtime.lastError || !response) {
            done({ ok: false, status: 0, error: chrome.runtime.lastError?.message || "no response" });
            return;
          }
          done(response);
        });
      } catch (error) {
        done({ ok: false, status: 0, error: error?.message || String(error) });
      }
    });
  }

  function readLegacyBlocklist() {
    try {
      return JSON.parse(localStorage.getItem(LEGACY_BLOCKLIST_KEY) || "[]");
    } catch (_) {
      return [];
    }
  }

  async function loadLists() {
    const legacy = readLegacyBlocklist();
    if (legacy.length) {
      // One-time migration of the old per-browser blocklist to the shared one.
      const res = await backend("/spam/lists", "POST", { action: "import", emails: legacy });
      if (res.ok) {
        try { localStorage.removeItem(LEGACY_BLOCKLIST_KEY); } catch (_) {}
      }
    }

    const res = await backend("/spam/lists");
    if (res.ok && res.data?.lists) {
      lists = res.data.lists;
      backendOnline = true;
      return;
    }

    // Backend unreachable: keep the old local behaviour (blocklist + rules, no AI).
    backendOnline = false;
    lists = fallbackLists();
  }

  function fallbackLists() {
    return {
      blocked_senders: readLegacyBlocklist().map((e) => String(e).toLowerCase()),
      blocked_domains: [],
      allowed_senders: [],
      allowed_domains: ["paddle.com", "stripe.com", "paypal.com", "apple.com", "avclabs.com", "wetransfer.com"]
    };
  }

  // ─── Ticket helpers ─────────────────────────────────────────────────────────

  function domainMatches(domain, listed) {
    return domain === listed || domain.endsWith("." + listed);
  }

  function listStatus(sender) {
    const email = String(sender || "").trim().toLowerCase();
    if (!email || !lists) return null;
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (lists.allowed_senders.includes(email)) return "allowed";
    if (lists.allowed_domains.some((d) => domainMatches(domain, d))) return "allowed";
    if (lists.blocked_senders.includes(email)) return "blocked";
    if (lists.blocked_domains.some((d) => domainMatches(domain, d))) return "blocked";
    return null;
  }

  // Our action buttons are appended inside this label, which changes its
  // textContent — so mark it the first time and look it up by the marker after.
  function getCustomerIdLabel(ticket) {
    const marked = ticket.querySelector("label[data-ec-cid-label]");
    if (marked) return marked;
    // Znuny shows this field in the agent's UI language.
    const label = Array.from(ticket.querySelectorAll("label")).find(
      (el) => /^(客户ID|Customer ID)[:：]?$/i.test(el.textContent.trim())
    );
    if (label) label.dataset.ecCidLabel = "1";
    return label || null;
  }

  function getSenderEmail(ticket) {
    const label = getCustomerIdLabel(ticket);
    const div = label?.nextElementSibling;
    return (div?.getAttribute("title") || div?.textContent || "").trim();
  }

  function readTicket(ticket) {
    const link = ticket.querySelector("a.MasterActionLink");
    const title = link ? (link.getAttribute("title") || link.textContent || "") : "";
    // Preview markup differs by overview view (Medium: span.Subject, Large: span.Headline).
    const previewSubject = ticket.querySelector("div.Preview span.Subject, div.Preview li.Active span.Headline")?.textContent || "";
    const preview = (ticket.querySelector("div.Preview .Content.ArticleBody") ||
      ticket.querySelector("div.Preview li.Active div.HiddenBlock"))?.innerText || "";
    const idMatch = (link?.getAttribute("href") || "").match(/TicketID=(\d+)/);
    return {
      link,
      id: idMatch ? idMatch[1] : "",
      sender: getSenderEmail(ticket),
      subject: (title || previewSubject).trim(),
      preview: preview.trim(),
      ruleText: `${title} ${previewSubject} ${preview}`
    };
  }

  // Returns the name of the first strong rule that matches, or "".
  function matchRule(text, sender) {
    const rule = SPAM_RULES.find((r) => r.pattern.test(r.field === "sender" ? sender : text));
    return rule ? rule.name : "";
  }

  // ─── Evaluation ─────────────────────────────────────────────────────────────

  function evaluate(ticket) {
    const info = readTicket(ticket);
    if (!info.link) return;
    ticket.__ecGen = (ticket.__ecGen || 0) + 1;

    if (ticket.dataset.ecOrder === "yes") return render(ticket, info, "order");

    const status = listStatus(info.sender);
    if (status === "allowed") return render(ticket, info, "allowed");
    if (status === "blocked") return render(ticket, info, "blocked");

    const rule = matchRule(info.ruleText, info.sender);
    if (rule) return render(ticket, info, "spam", { reason: `规则命中：${rule}` });

    if (!backendOnline || !info.id) return render(ticket, info, "none");

    const known = aiResults.get(info.id);
    if (known) return renderAi(ticket, info, known);

    render(ticket, info, "pending");
    enqueueAi(ticket, info, ticket.__ecGen);
  }

  function renderAi(ticket, info, result) {
    if (result.verdict === "spam" && result.confidence >= AI_SPAM_MIN_CONFIDENCE) {
      return render(ticket, info, result.engine === "human" ? "spam" : "ai-spam", result);
    }
    if (result.verdict === "ham") return render(ticket, info, "none", result);
    return render(ticket, info, "unsure", result);
  }

  function enqueueAi(ticket, info, gen) {
    aiQueue.push({ ticket, info, gen });
    pumpAi();
  }

  function pumpAi() {
    while (aiRunning < AI_CONCURRENCY && aiQueue.length) {
      const job = aiQueue.shift();
      aiRunning += 1;
      backend("/spam/classify", "POST", {
        ticket_id: job.info.id,
        sender: job.info.sender,
        subject: job.info.subject,
        preview: job.info.preview
      }).then((res) => {
        if (res.error === "stale") return; // banner already tells the user to refresh
        const result = res.ok && res.data?.verdict
          ? res.data
          : { verdict: "unsure", confidence: 0, reason: "后端不可用，需人工判断" };
        if (res.ok) aiResults.set(job.info.id, result);
        // Skip stale results: the ticket was re-evaluated (order found, list changed…).
        if (job.ticket.__ecGen === job.gen) renderAi(job.ticket, job.info, result);
      }).finally(() => {
        aiRunning -= 1;
        pumpAi();
      });
    }
  }

  function reevaluateAll() {
    document.querySelectorAll("li.MasterAction").forEach(evaluate);
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  const BADGES = {
    blocked:   { text: "BLOCKED", cls: "ec-blocked-badge", spam: true },
    spam:      { text: "SPAM",    cls: "",                 spam: true },
    "ai-spam": { text: "AI-SPAM", cls: "ec-ai-badge",      spam: true },
    unsure:    { text: "?",       cls: "ec-unsure-badge",  spam: false },
    pending:   { text: "AI…",     cls: "ec-pending-badge", spam: false }
  };

  function render(ticket, info, kind, meta = {}) {
    ticket.querySelector(".ec-spam-badge")?.remove();
    ticket.querySelector(".ec-reason-row")?.remove();
    ticket.querySelector(".ec-spam-reason")?.remove();
    ticket.querySelector(".ec-spam-actions")?.remove();
    ticket.classList.remove("ec-spam");
    ticket.dataset.ecVerdict = kind;

    const badge = BADGES[kind];
    if (badge) {
      const reason = meta.reason || (kind === "blocked" ? "发件人或其域名已被拉黑" : "");
      const text = reason && meta.confidence && meta.confidence < 1
        ? `${reason}（置信度 ${Math.round(meta.confidence * 100)}%）`
        : reason;

      // Badge goes inside the title link: in the Large view the link is a block
      // inside a one-line clipped h2, so anything placed beside it pushes the
      // title out of view.
      const el = document.createElement("span");
      el.className = `ec-spam-badge ${badge.cls}`.trim();
      el.textContent = badge.text;
      if (text) el.title = text;
      info.link.insertBefore(el, info.link.firstChild);

      if (text && kind !== "pending") {
        const line = document.createElement("span");
        line.className = `ec-spam-reason ec-reason-${kind}`;
        line.textContent = text;
        // Put the reason as the first row of the ticket's field table (same
        // place queue-order-lookup.js adds its order row) so it lines up with
        // the fields instead of overlapping the left-hand column.
        const tbody = ticket.querySelector("div.Infos table tbody");
        if (tbody) {
          const tr = document.createElement("tr");
          tr.className = "ec-reason-row";
          const td = document.createElement("td");
          td.colSpan = 2;
          td.appendChild(line);
          tr.appendChild(td);
          tbody.insertBefore(tr, tbody.firstChild);
        } else {
          const heading = info.link.closest("h2") || info.link;
          heading.parentNode.insertBefore(line, heading.nextSibling);
        }
      }
      if (badge.spam) ticket.classList.add("ec-spam");
    }

    if (kind !== "pending" && kind !== "order") renderActions(ticket, info, kind);
    updateSelectButton();
  }

  function makeButton(text, cls, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ec-mini-btn ${cls}`;
    btn.textContent = text;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  function renderActions(ticket, info, kind) {
    if (!backendOnline) return;
    const box = document.createElement("span");
    box.className = "ec-spam-actions";

    if (kind === "blocked") {
      // Blocked either individually or through its whole domain — undo whichever applies.
      const email = info.sender.trim().toLowerCase();
      const domain = email.slice(email.lastIndexOf("@") + 1);
      const byDomain = !lists.blocked_senders.includes(email) &&
        lists.blocked_domains.find((d) => domainMatches(domain, d));
      const label = byDomain ? `取消拉黑域名 ${byDomain}` : "取消拉黑";
      const body = byDomain
        ? { action: "unblock_domain", domain: byDomain }
        : { action: "unblock", email: info.sender };
      box.append(makeButton(label, "ec-btn-purple", () => act(ticket, info, () =>
        backend("/spam/lists", "POST", body))));
    }
    if (kind === "spam" || kind === "ai-spam") {
      box.append(makeButton("拉黑发件人", "ec-btn-red", () => act(ticket, info, () =>
        sendFeedback(info, kind, "spam", "sender"))));
    }
    if (kind === "none" || kind === "unsure") {
      box.append(makeButton("是垃圾", "ec-btn-red", () => showSpamChoices(ticket, info, kind, box)));
    }
    if (kind !== "none" && kind !== "allowed") {
      box.append(makeButton("不是垃圾", "ec-btn-green", () => act(ticket, info, () =>
        sendFeedback(info, kind, "ham", "sender"))));
    }

    if (!box.childElementCount) return;
    const label = getCustomerIdLabel(ticket);
    (label || info.link.parentElement || ticket).appendChild(box);
  }

  function showSpamChoices(ticket, info, kind, box) {
    box.replaceChildren(
      makeButton("仅本封", "ec-btn-red", () => act(ticket, info, () => sendFeedback(info, kind, "spam", "ticket"))),
      makeButton("拉黑发件人", "ec-btn-red", () => act(ticket, info, () => sendFeedback(info, kind, "spam", "sender"))),
      makeButton("拉黑域名", "ec-btn-red", () => act(ticket, info, () => sendFeedback(info, kind, "spam", "domain"))),
      makeButton("取消", "ec-btn-grey", () => evaluate(ticket))
    );
  }

  function sendFeedback(info, shown, correction, scope) {
    return backend("/spam/feedback", "POST", { ticket_id: info.id, sender: info.sender, shown, correction, scope });
  }

  async function act(ticket, info, request) {
    ticket.querySelectorAll(".ec-spam-actions button").forEach((b) => { b.disabled = true; });
    const res = await request();
    if (!res.ok) {
      const detail = res.data?.detail || res.data?.error || res.error || `HTTP ${res.status}`;
      alert(`操作失败：${detail}`);
      evaluate(ticket);
      return;
    }
    if (res.data?.lists) lists = res.data.lists;
    // Human decisions are cached server-side per ticket; drop our copy so the
    // next evaluation fetches the override.
    if (info.id) aiResults.delete(info.id);
    reevaluateAll();
  }

  // ─── Select-all button & styles ─────────────────────────────────────────────

  function showStaleNotice() {
    if (document.getElementById("ec-stale-notice")) return;
    const el = document.createElement("div");
    el.id = "ec-stale-notice";
    el.textContent = "Email Copilot 已更新，请关闭并重新打开这个标签页";
    el.style.cssText = "position:fixed;top:12px;right:12px;z-index:100000;padding:8px 14px;" +
      "background:#1f2937;color:#fff;font-size:13px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    document.body.appendChild(el);
  }

  function updateSelectButton() {
    const btn = document.getElementById("ec-select-btn");
    if (!btn) return;
    const n = document.querySelectorAll("li.MasterAction.ec-spam").length;
    btn.textContent = n > 0 ? `选中垃圾邮件 (${n})` : "无垃圾邮件";
    btn.disabled = n === 0;
  }

  function injectSelectButton() {
    if (document.getElementById("ec-select-btn")) return;
    const btn = document.createElement("button");
    btn.id = "ec-select-btn";
    btn.textContent = "选中垃圾邮件 (0)";
    btn.disabled = true;
    btn.addEventListener("click", () => {
      document.querySelectorAll("li.MasterAction.ec-spam input.Checkbox[type='checkbox']").forEach((cb) => {
        if (!cb.checked) cb.click();
      });
    });
    document.body.appendChild(btn);
  }

  function injectStyles() {
    if (document.getElementById("ec-spam-styles")) return;
    const style = document.createElement("style");
    style.id = "ec-spam-styles";
    style.textContent = `
      .ec-spam-badge {
        display: inline-block; margin-right: 7px; padding: 1px 7px;
        background: #ef4444; color: #fff; font-size: 11px; font-weight: 700;
        letter-spacing: 0.06em; border-radius: 3px; vertical-align: middle;
      }
      .ec-blocked-badge { background: #7c3aed; }
      .ec-ai-badge      { background: #ea580c; }
      .ec-unsure-badge  { background: #eab308; color: #1f2937; }
      .ec-pending-badge { background: #9ca3af; }
      .ec-spam-actions  { display: inline-block; margin-left: 5px; }
      .ec-spam-reason {
        display: block; margin-top: 3px;
        font-size: 12px; font-weight: normal; line-height: 1.4; color: #6b7280;
      }
      .ec-reason-unsure  { color: #a16207; }
      .ec-reason-ai-spam { color: #c2410c; }
      .ec-mini-btn {
        display: inline-block; margin-left: 4px; padding: 1px 6px;
        background: transparent; font-size: 10px; font-weight: 600;
        border: 1px solid currentColor; border-radius: 3px; cursor: pointer;
        vertical-align: middle; line-height: 1.4;
      }
      .ec-mini-btn:disabled { opacity: 0.5; cursor: default; }
      .ec-btn-red    { color: #ef4444; }
      .ec-btn-green  { color: #16a34a; }
      .ec-btn-purple { color: #7c3aed; }
      .ec-btn-grey   { color: #6b7280; }
      li.MasterAction.ec-spam { opacity: 0.5; }
      #ec-select-btn {
        position: fixed; bottom: 24px; right: 24px; z-index: 99999;
        padding: 8px 14px; background: #ef4444; color: #fff;
        font-size: 13px; font-weight: 600; border: none; border-radius: 6px;
        cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      }
      #ec-select-btn:hover { background: #dc2626; }
      #ec-select-btn:disabled { background: #9ca3af; cursor: default; }
    `;
    document.head.appendChild(style);
  }

  // ─── Init ───────────────────────────────────────────────────────────────────

  let started = false;

  async function init() {
    if (started || !document.querySelector("li.MasterAction")) return;
    started = true;
    document.documentElement.dataset.ecSpamVersion = VERSION;
    log(`v${VERSION} queue page detected:`, document.querySelectorAll("li.MasterAction").length, "tickets");
    injectStyles();
    injectSelectButton();

    // queue-order-lookup.js fires this when it finds orders for a ticket's customer.
    // Registered before the async list load so no event is missed.
    document.addEventListener("ec:orders", (event) => {
      const ticket = event.target.closest?.("li.MasterAction");
      if (!ticket) return;
      ticket.dataset.ecOrder = event.detail?.count > 0 ? "yes" : "no";
      if (ticket.dataset.ecOrder === "yes" && lists) evaluate(ticket);
    });

    const evaluateNew = () => {
      document.querySelectorAll("li.MasterAction:not([data-ec-checked])").forEach((ticket) => {
        ticket.setAttribute("data-ec-checked", "1");
        evaluate(ticket);
      });
    };

    // Show rule-based badges right away from the local fallback lists, so a slow
    // or unreachable backend never leaves the queue unmarked.
    lists = fallbackLists();
    evaluateNew();

    // The ticket list is ul#TicketOverviewLarge.Overview (Large/Preview view) or similar.
    const container = document.querySelector("li.MasterAction")?.parentElement;
    if (container) new MutationObserver(evaluateNew).observe(container, { childList: true });

    await loadLists();
    log(backendOnline ? "backend online, shared lists loaded" : "backend unreachable — rules only, no AI");
    reevaluateAll();
  }

  function start() {
    if (document.querySelector("li.MasterAction")) {
      init();
      return;
    }
    // Znuny can render the ticket list after document_idle (AJAX filters, paging).
    // Watch briefly for it instead of giving up on the first check.
    if (window.top !== window || !document.body) return;
    const observer = new MutationObserver(() => {
      if (document.querySelector("li.MasterAction")) {
        observer.disconnect();
        init();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
