(function () {
  // Queue routing on the Znuny queue page.
  //
  // Tickets in the home queue (avclabs) sometimes ask about another product
  // line. For each such ticket the backend (POST /queue-routing/classify)
  // suggests a destination from the subject/preview and the customer's orders;
  // the page shows "→ Queue" with a move button. Nothing moves unless the agent
  // clicks, or turns on auto mode (high-confidence suggestions only).
  //
  // "学习队列产品" crawls the other queues: for the open tickets in each queue
  // it looks up the customer's orders and uploads queue ↔ product samples to
  // POST /queue-routing/learn, which turns them into the product → queue map.

  if (window.__ecQueueRoutingLoaded) return;
  window.__ecQueueRoutingLoaded = true;

  // Check in the page console: document.documentElement.dataset.ecRoutingVersion
  const VERSION = "2026-11-19.2";
  const HOME_QUEUE = "avclabs";
  const AUTO_KEY = "ec-queue-route-auto";
  const CONCURRENCY = 3;
  const ORDER_WAIT_MS = 15000;        // auto mode waits this long for the order lookup
  const CRAWL_MAX_PER_QUEUE = 40;     // tickets sampled per queue
  const CRAWL_MAX_PAGES = 4;
  // System queues and the home queue itself say nothing about product lines.
  const CRAWL_SKIP = /^(junk|raw|postmaster|feedback)$/i;

  const results = new Map(); // ticketId → classify result
  let backendOnline = true;
  let autoMode = false;

  function log(...args) {
    console.info("[Email Copilot routing]", ...args);
  }

  // ─── Backend (via background.js proxy) ──────────────────────────────────────

  function backend(path, method = "GET", body) {
    return new Promise((resolve) => {
      if (!chrome.runtime?.id) return resolve({ ok: false, error: "stale" });
      const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 20000);
      try {
        chrome.runtime.sendMessage({ type: "EC_BACKEND", path, method, body }, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !response) {
            resolve({ ok: false, error: chrome.runtime.lastError?.message || "no response" });
            return;
          }
          resolve(response);
        });
      } catch (error) {
        clearTimeout(timer);
        resolve({ ok: false, error: error?.message || String(error) });
      }
    });
  }

  // ─── Page helpers ───────────────────────────────────────────────────────────

  function indexUrl(params) {
    return `${new URL(location.pathname, location.origin)}?${params}`;
  }

  async function fetchDoc(url, init = {}) {
    const res = await fetch(url, { credentials: "include", ...init });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc.querySelector("#LoginBox, form#Login, input[name='Action'][value='Login']")) {
      throw new Error("Znuny 登录已过期，请刷新页面重新登录");
    }
    return { doc, url: res.url || url };
  }

  // "anvsoft::anvsoft.jp::Sidify JP (3)" → "Sidify JP"; the queue view
  // shows counters as "(3)" or "(32/21)" (all/new).
  function shortQueueName(text) {
    // The active queue's link also holds its counter and a timestamp on later lines.
    return String(text || "").trim().split(/\s*\n/)[0]
      .replace(/\u00a0/g, " ")
      .split("::").pop()
      .replace(/\(\s*\d+(\s*\/\s*\d+)?\s*\)\s*$/, "")
      .trim();
  }

  // The queue view writes "contact: tunepat", the move dialog "Contact:TunePat".
  function queueKey(name) {
    return shortQueueName(name).toLowerCase().replace(/\s+/g, "");
  }

  function sameQueue(a, b) {
    return queueKey(a) === queueKey(b);
  }

  // Value of a field in the ticket's info table, by its (localized) label.
  function fieldValue(ticket, labelRe) {
    const label = Array.from(ticket.querySelectorAll("label")).find((el) => labelRe.test(el.textContent.trim()));
    const div = label?.nextElementSibling;
    return (div?.getAttribute("title") || div?.textContent || "").trim();
  }

  // Queue links on the page (queue view navigation): [{id, name}]
  function queueLinks(root = document) {
    const seen = new Map();
    root.querySelectorAll("a[href*='Action=AgentTicketQueue'][href*='QueueID=']").forEach((a) => {
      const id = (a.getAttribute("href").match(/QueueID=(\d+)/) || [])[1];
      const name = shortQueueName(a.getAttribute("title") || a.textContent);
      if (id && id !== "0" && name && !seen.has(id)) seen.set(id, { id, name });
    });
    return [...seen.values()];
  }

  function pageQueueName() {
    const id = (location.href.match(/[?;&]QueueID=(\d+)/) || [])[1];
    return id ? (queueLinks().find((q) => q.id === id)?.name || "") : "";
  }

  function ticketQueue(ticket) {
    return shortQueueName(fieldValue(ticket, /^(队列|Queue)[:：]?$/i)) || pageQueueName();
  }

  function readTicket(ticket) {
    const link = ticket.querySelector("a.MasterActionLink");
    const title = link ? (link.getAttribute("title") || link.textContent || "") : "";
    const preview = (ticket.querySelector("div.Preview .Content.ArticleBody") ||
      ticket.querySelector("div.Preview li.Active div.HiddenBlock"))?.innerText || "";
    return {
      link,
      id: ((link?.getAttribute("href") || "").match(/TicketID=(\d+)/) || [])[1] || "",
      subject: title.trim(),
      preview: preview.trim().slice(0, 2000),
      queue: ticketQueue(ticket),
      lock: fieldValue(ticket, /^(锁定|Lock)[:：]?$/i)
    };
  }

  // ─── Classification ─────────────────────────────────────────────────────────

  const queue = [];
  let running = 0;

  function evaluate(ticket) {
    const info = readTicket(ticket);
    if (!info.link || !info.id) return;
    if (!info.queue || !sameQueue(info.queue, HOME_QUEUE)) {
      render(ticket, info, null);
      return;
    }
    ticket.__ecRouteGen = (ticket.__ecRouteGen || 0) + 1;
    queue.push({ ticket, info, gen: ticket.__ecRouteGen });
    pump();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const job = queue.shift();
      running += 1;
      backend("/queue-routing/classify", "POST", {
        ticket_id: job.info.id,
        subject: job.info.subject,
        preview: job.info.preview,
        products: job.ticket.__ecProducts || []
      }).then((res) => {
        if (!res.ok) {
          backendOnline = false;
          return;
        }
        backendOnline = true;
        if (job.ticket.__ecRouteGen !== job.gen) return;
        results.set(job.info.id, res.data);
        render(job.ticket, job.info, res.data);
        maybeAutoMove(job.ticket, job.info, res.data);
      }).finally(() => {
        running -= 1;
        pump();
        updateToolbar();
      });
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  function clear(ticket) {
    ticket.querySelector(".ec-route-badge")?.remove();
    ticket.querySelector(".ec-route-row")?.remove();
    ticket.classList.remove("ec-route-move");
  }

  function render(ticket, info, result) {
    clear(ticket);
    delete ticket.dataset.ecRoute;
    if (!result || result.action !== "move") return;
    ticket.dataset.ecRoute = result.queue;
    ticket.dataset.ecRouteConfidence = result.confidence;
    ticket.classList.add("ec-route-move");

    const badge = document.createElement("span");
    badge.className = `ec-route-badge ec-route-${result.confidence}`;
    badge.textContent = `→ ${result.queue}`;
    badge.title = result.reason || "";
    info.link.insertBefore(badge, info.link.firstChild);

    const row = document.createElement("tr");
    row.className = "ec-route-row";
    const td = document.createElement("td");
    td.colSpan = 2;
    const text = document.createElement("span");
    text.className = "ec-route-reason";
    text.textContent = `应属队列 ${result.queue}（${result.confidence === "high" ? "高" : "中"}置信）：${result.reason}`;
    td.append(text,
      button(`移到 ${result.queue}`, "ec-route-btn", (btn) => moveOne(ticket, info, result, btn, false)),
      button("忽略", "ec-route-btn ec-route-btn-grey", () => { render(ticket, info, null); updateToolbar(); }));
    row.appendChild(td);
    const tbody = ticket.querySelector("div.Infos table tbody");
    if (tbody) {
      tbody.insertBefore(row, tbody.firstChild);
    } else {
      const div = document.createElement("div");
      div.className = "ec-route-row";
      div.append(...td.childNodes);
      (info.link.closest("h2") || info.link).after(div);
    }
  }

  function button(text, cls, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = text;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  // ─── Moving ─────────────────────────────────────────────────────────────────

  function collectFields(form) {
    const pairs = [];
    form.querySelectorAll("input, select, textarea").forEach((el) => {
      const name = el.getAttribute("name");
      if (!name || el.disabled) return;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT") {
        if (["file", "button", "submit", "image", "reset"].includes(type)) return;
        if ((type === "checkbox" || type === "radio") && !el.checked) return;
        pairs.push([name, el.value || ""]);
      } else if (el.tagName === "SELECT") {
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
    return [...pairs.filter(([n]) => n !== name), [name, String(value)]];
  }

  function responseError(doc) {
    const fields = Array.from(doc.querySelectorAll(".ServerError")).map((el) => el.getAttribute("name") || el.id).filter(Boolean);
    if (fields.length) return `表单校验未通过：${[...new Set(fields)].join("、")}`;
    const box = doc.querySelector(".ErrorScreen, .MessageBox.Error p, #ServerErrorMsg");
    return box ? box.textContent.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  }

  // AgentTicketMove popup form: pick the destination, keep everything else.
  async function moveTicket(ticketId, destName, { unlockAfter }) {
    const { doc, url } = await fetchDoc(indexUrl(`Action=AgentTicketMove;TicketID=${encodeURIComponent(ticketId)}`));
    const form = Array.from(doc.querySelectorAll("form")).find((f) =>
      f.querySelector("select[name='DestQueueID']") && f.querySelector("input[name='TicketID']"));
    if (!form) throw new Error(responseError(doc) || "没有找到移动工单的表单");
    const select = form.querySelector("select[name='DestQueueID']");
    const option = Array.from(select.options).find((o) => o.value && !o.disabled && sameQueue(o.textContent, destName));
    if (!option) throw new Error(`移动表单里没有队列「${destName}」`);

    let pairs = setField(collectFields(form), "DestQueueID", option.value);
    pairs = setField(pairs, "Subaction", "MoveTicket");
    const body = form.querySelector("textarea[name='Body']");
    if (body && (body.classList.contains("Validate_Required") || body.classList.contains("Validate_RequiredRichText"))) {
      pairs = setField(pairs, "Subject", `移至队列 ${destName}`);
      pairs = setField(pairs, "Body", `邮件咨询的产品属于 ${destName}，从 ${HOME_QUEUE} 移入。`);
    }
    const data = new FormData();
    pairs.forEach(([n, v]) => data.append(n, v));
    const target = new URL(form.getAttribute("action") || "index.pl", url).toString();
    const { doc: after } = await fetchDoc(target, { method: "POST", body: data });
    if (after.querySelector("select[name='DestQueueID']") || after.querySelector(".ServerError, .ErrorScreen")) {
      throw new Error(responseError(after) || "移动没有成功（表单被退回）");
    }

    // Opening the move form can lock the ticket to this agent (RequiredLock);
    // a routed ticket should arrive unlocked so the other team picks it up.
    if (unlockAfter) {
      const token = form.querySelector("input[name='ChallengeToken']")?.value;
      if (token) {
        await fetch(indexUrl(`Action=AgentTicketLock;Subaction=Unlock;TicketID=${encodeURIComponent(ticketId)};ChallengeToken=${encodeURIComponent(token)}`),
          { credentials: "include" }).catch(() => {});
      }
    }
    return option.textContent.replace(/\u00a0/g, " ").trim();
  }

  async function moveOne(ticket, info, result, btn, auto) {
    if (!auto && !confirm(`把工单「${info.subject}」从 ${info.queue} 移到 ${result.queue}？`)) return false;
    ticket.querySelectorAll(".ec-route-row button").forEach((b) => { b.disabled = true; });
    if (btn) btn.textContent = "移动中…";
    try {
      // Locked = someone is working on it; leave the lock as it was.
      const wasLocked = /^(lock|locked|锁定|已锁定)$/i.test(info.lock);
      await moveTicket(info.id, result.queue, { unlockAfter: !wasLocked });
      backend("/queue-routing/moved", "POST", {
        ticket_id: info.id, from: info.queue, to: result.queue,
        suggested: result.queue, confidence: result.confidence, auto
      });
      clear(ticket);
      delete ticket.dataset.ecRoute;
      ticket.classList.add("ec-route-done");
      const badge = document.createElement("span");
      badge.className = "ec-route-badge ec-route-done-badge";
      badge.textContent = `已移到 ${result.queue}`;
      info.link.insertBefore(badge, info.link.firstChild);
      return true;
    } catch (error) {
      if (!auto) alert(`移动失败：${error?.message || error}`);
      log("move failed", info.id, error);
      render(ticket, info, result);
      return false;
    } finally {
      updateToolbar();
    }
  }

  // Auto mode: only high-confidence suggestions, and only once the order
  // lookup has answered (or timed out), so a home-queue order can veto.
  function maybeAutoMove(ticket, info, result) {
    if (!autoMode || result?.action !== "move" || result.confidence !== "high") return;
    if (ticket.classList.contains("ec-spam")) return;
    if (!ticket.__ecOrdersDone && Date.now() - (ticket.__ecSeenAt || 0) < ORDER_WAIT_MS) return;
    if (ticket.__ecAutoTried) return;
    ticket.__ecAutoTried = true;
    moveOne(ticket, info, result, null, true);
  }

  async function moveAllSuggested() {
    // Tickets the spam triage flagged are left alone: they get deleted, not routed.
    const tickets = Array.from(document.querySelectorAll("li.MasterAction.ec-route-move:not(.ec-spam)"));
    if (!tickets.length) return;
    const lines = tickets.map((t) => `${readTicket(t).subject.slice(0, 50)}  →  ${t.dataset.ecRoute}`);
    if (!confirm(`移动以下 ${tickets.length} 个工单？\n\n${lines.join("\n")}`)) return;
    let ok = 0;
    for (const ticket of tickets) {
      const info = readTicket(ticket);
      const result = results.get(info.id);
      if (result && await moveOne(ticket, info, result, null, true)) ok += 1;
    }
    alert(`已移动 ${ok} / ${tickets.length} 个工单${ok < tickets.length ? "，失败的仍保留建议，可单独重试" : ""}`);
  }

  // ─── Crawler ────────────────────────────────────────────────────────────────

  // Opaque per-customer key so the backend can spot customers who appear in
  // many queues without storing their email.
  // (FNV-1a; crypto.subtle is unavailable on the plain-HTTP Znuny page.)
  function customerKey(email) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (const ch of String(email).toLowerCase()) {
      const c = ch.codePointAt(0);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  async function crawl(btn) {
    const lookup = window.__ecOrderLookup;
    if (!lookup) return alert("订单查询脚本没有加载，请刷新页面");
    const crawlable = (q) => !sameQueue(q.name, HOME_QUEUE) && !CRAWL_SKIP.test(q.name);
    // Subqueues (TP-Video under TunePat …) only appear in the queue bar once
    // their parent is selected, so queues found on each fetched page are
    // appended as the crawl goes.
    const queues = queueLinks().filter(crawlable);
    const known = new Set(queues.map((q) => q.id));
    const discovered = [...queueLinks()];
    if (!queues.length) return alert("页面上没有找到其他队列的链接（请在「队列视图」页面使用）");
    if (!confirm(`将读取 ${queues.length} 个队列（及其子队列）中最多各 ${CRAWL_MAX_PER_QUEUE} 个工单，并查询这些客户的订单，只读不改。继续？`)) return;

    const origin = `${location.protocol}//${location.host}`;
    btn.disabled = true;
    let first = true;
    let totalSamples = 0;
    try {
      for (let qi = 0; qi < queues.length; qi += 1) {
        const q = queues[qi];
        btn.textContent = `学习中 ${qi + 1}/${queues.length}：${q.name}`;
        // queue key + email → the ticket's own queue. A parent queue's view can
        // include its subqueues' tickets, so each ticket is credited to the
        // queue in its own "队列" field, falling back to the queue being read.
        const seen = new Map();
        for (let page = 0, start = 1; page < CRAWL_MAX_PAGES && seen.size < CRAWL_MAX_PER_QUEUE; page += 1) {
          const { doc } = await fetchDoc(indexUrl(`Action=AgentTicketQueue;QueueID=${q.id};StartHit=${start}`));
          if (page === 0) {
            queueLinks(doc).forEach((found) => {
              if (!discovered.some((d) => d.id === found.id)) discovered.push(found);
              if (known.has(found.id) || !crawlable(found)) return;
              known.add(found.id);
              queues.push(found);
            });
          }
          const tickets = Array.from(doc.querySelectorAll("li.MasterAction"));
          if (!tickets.length) break;
          const before = seen.size;
          tickets.forEach((t) => {
            const email = lookup.resolveCustomerEmail(t);
            const own = shortQueueName(fieldValue(t, /^(队列|Queue)[:：]?$/i)) || q.name;
            if (!email || sameQueue(own, HOME_QUEUE) || seen.size >= CRAWL_MAX_PER_QUEUE) return;
            seen.set(`${queueKey(own)}|${email.toLowerCase()}`, { queue: own, email: email.toLowerCase() });
          });
          if (seen.size === before) break;
          start += tickets.length;
        }

        const list = [...seen.values()];
        const samples = [];
        let i = 0;
        const worker = async () => {
          while (i < list.length) {
            const { queue: own, email } = list[i++];
            try {
              const rows = await lookup.searchOrders(origin, email);
              const products = rows.map((r) => r.Product).filter(Boolean);
              if (products.length) samples.push({ queue: own, customer: customerKey(email), products });
            } catch (_) { /* skip this customer */ }
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));

        // Upload per queue so an interrupted crawl still keeps what it found.
        const res = await backend("/queue-routing/learn", "POST", {
          replace: first, queues: discovered, samples
        });
        if (!res.ok) throw new Error(`后端保存失败：${res.error || res.status}`);
        first = false;
        totalSamples += samples.length;
        log(`crawled ${q.name}: ${list.length} customers, ${samples.length} with orders`);
      }
      const table = await backend("/queue-routing/table");
      const learned = Object.keys(table.data?.learned || {}).length;
      alert(`学习完成：${queues.length} 个队列，${totalSamples} 个有订单的客户，得到 ${learned} 个产品 → 队列对应。\n` +
        `完整结果：http://localhost:8787/queue-routing/table`);
      reevaluateAll();
    } catch (error) {
      alert(`学习中断：${error?.message || error}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "学习队列产品";
    }
  }

  // ─── Toolbar & styles ───────────────────────────────────────────────────────

  function updateToolbar() {
    const btn = document.getElementById("ec-route-all-btn");
    if (!btn) return;
    const n = document.querySelectorAll("li.MasterAction.ec-route-move").length;
    btn.textContent = n ? `移动建议工单 (${n})` : "无需分流";
    btn.disabled = n === 0;
    const auto = document.getElementById("ec-route-auto");
    if (auto) auto.title = backendOnline ? "" : "后端不可用";
  }

  function injectToolbar() {
    if (document.getElementById("ec-route-bar")) return;
    const bar = document.createElement("div");
    bar.id = "ec-route-bar";
    const all = button("无需分流", "", moveAllSuggested);
    all.id = "ec-route-all-btn";
    all.disabled = true;
    const learn = button("学习队列产品", "ec-route-secondary", (b) => crawl(b));
    const label = document.createElement("label");
    label.id = "ec-route-auto";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = autoMode;
    box.addEventListener("change", () => {
      autoMode = box.checked;
      chrome.storage.local.set({ [AUTO_KEY]: autoMode }).catch(() => {});
      if (autoMode) {
        document.querySelectorAll("li.MasterAction.ec-route-move").forEach((t) => {
          const info = readTicket(t);
          maybeAutoMove(t, info, results.get(info.id));
        });
      }
    });
    label.append(box, " 自动分流（仅高置信）");
    bar.append(all, learn, label);
    document.body.appendChild(bar);
  }

  function injectStyles() {
    if (document.getElementById("ec-route-styles")) return;
    const style = document.createElement("style");
    style.id = "ec-route-styles";
    style.textContent = `
      .ec-route-badge {
        display: inline-block; margin-right: 7px; padding: 1px 7px;
        color: #fff; font-size: 11px; font-weight: 700; border-radius: 3px; vertical-align: middle;
      }
      .ec-route-high   { background: #2563eb; }
      .ec-route-medium { background: #0891b2; }
      .ec-route-done-badge { background: #16a34a; }
      li.MasterAction.ec-route-done { opacity: 0.5; }
      .ec-route-reason { font-size: 12px; color: #1d4ed8; margin-right: 4px; }
      .ec-route-btn {
        display: inline-block; margin-left: 4px; padding: 1px 6px; background: transparent;
        color: #2563eb; font-size: 10px; font-weight: 600; line-height: 1.4;
        border: 1px solid currentColor; border-radius: 3px; cursor: pointer;
      }
      .ec-route-btn-grey { color: #6b7280; }
      .ec-route-btn:disabled { opacity: 0.5; cursor: default; }
      #ec-route-bar {
        position: fixed; bottom: 70px; right: 24px; z-index: 99999;
        display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      }
      #ec-route-bar button {
        padding: 7px 12px; background: #2563eb; color: #fff; font-size: 13px; font-weight: 600;
        border: none; border-radius: 6px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      }
      #ec-route-bar button.ec-route-secondary { background: #fff; color: #2563eb; border: 1px solid #2563eb; }
      #ec-route-bar button:disabled { background: #9ca3af; color: #fff; cursor: default; }
      #ec-route-auto {
        padding: 4px 8px; background: #fff; font-size: 12px; border-radius: 4px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.2); cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Init ───────────────────────────────────────────────────────────────────

  function reevaluateAll() {
    document.querySelectorAll("li.MasterAction").forEach(evaluate);
  }

  let started = false;

  async function init() {
    if (started || window.top !== window || !document.querySelector("li.MasterAction")) return;
    started = true;
    document.documentElement.dataset.ecRoutingVersion = VERSION;
    try {
      autoMode = Boolean((await chrome.storage.local.get(AUTO_KEY))[AUTO_KEY]);
    } catch (_) { autoMode = false; }
    injectStyles();
    injectToolbar();

    // queue-order-lookup.js reports each customer's products; re-classify
    // with them (orders can confirm or veto a text-only suggestion).
    document.addEventListener("ec:orders", (event) => {
      const ticket = event.target.closest?.("li.MasterAction");
      if (!ticket) return;
      ticket.__ecProducts = event.detail?.products || [];
      ticket.__ecOrdersDone = true;
      evaluate(ticket);
    });

    const evaluateNew = () => {
      document.querySelectorAll("li.MasterAction:not([data-ec-route-seen])").forEach((ticket) => {
        ticket.setAttribute("data-ec-route-seen", "1");
        ticket.__ecSeenAt = Date.now();
        evaluate(ticket);
      });
    };
    evaluateNew();
    const container = document.querySelector("li.MasterAction")?.parentElement;
    if (container) new MutationObserver(evaluateNew).observe(container, { childList: true });

    // Tickets without a customer email never get an ec:orders event; let auto
    // mode act on them once the wait is over.
    setTimeout(() => {
      if (!autoMode) return;
      document.querySelectorAll("li.MasterAction.ec-route-move").forEach((t) => {
        const info = readTicket(t);
        maybeAutoMove(t, info, results.get(info.id));
      });
    }, ORDER_WAIT_MS + 500);

    log(`v${VERSION} on queue page; home queue ${HOME_QUEUE}`);
  }

  function start() {
    if (document.querySelector("li.MasterAction")) return init();
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
