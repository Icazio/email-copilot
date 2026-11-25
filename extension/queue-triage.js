(function () {
  // Queue page: "处理类型" (category · case + one-line summary) and a
  // "一键处理" button on every ticket card. Classification comes from the
  // backend (/queue-triage); every write action asks for confirmation first.
  //   取消续订            → 转交 Julie Cai + 订单备注
  //   免费积分 YouTube无图 → 回复窗口填好「索要截图」；有附件图 → 待人工审核
  //   退款 自动续订        → 转交 Julie Cai + 订单备注
  //   退款 效果不满意      → 回复窗口填好「索要对比图」
  //   退款 程序问题        → 回复窗口填好「索要 log」
  //   Replies are never sent from here: the agent clicks Send in Znuny.
  //   咨询                → 知识库搜索 + AI 写回复，打开回复窗口人工确认

  // The queue list may sit inside a frame, so no top-frame check; init()
  // only runs where li.MasterAction exists.
  if (window.__ecTriageLoaded) return;
  window.__ecTriageLoaded = true;
  const VERSION = "2026-11-20.4";
  const BACKEND_TIMEOUT_MS = 90000;
  const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic)\b/i;
  const CREDIT_HINT_RE = /credit/i;

  const BUTTONS = {
    transfer_julie:       { text: "转交 Julie",      cls: "ec-tri-btn-purple" },
    reply_ask_screenshot: { text: "回复：索要截图",   cls: "ec-tri-btn-blue" },
    reply_ask_comparison: { text: "回复：索要对比图", cls: "ec-tri-btn-blue" },
    reply_ask_log:        { text: "回复：索要日志",   cls: "ec-tri-btn-blue" },
    draft_reply:          { text: "搜索并写回复",     cls: "ec-tri-btn-green" },
    manual_review:        { text: "待人工审核",       cls: "ec-tri-btn-grey" },
    open:                 { text: "打开工单",         cls: "ec-tri-btn-grey" }
  };

  function log(...args) { console.info("[Email Copilot triage]", ...args); }

  // Diagnostics without opening the console: a small fixed note on the page.
  function notice(text, isError) {
    let n = document.getElementById("ec-tri-notice");
    if (!n) {
      n = document.createElement("div");
      n.id = "ec-tri-notice";
      n.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:100000;" +
        "padding:4px 10px;font-size:12px;border-radius:4px;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:pointer";
      n.title = "点击关闭";
      n.addEventListener("click", () => n.remove());
      (document.body || document.documentElement).appendChild(n);
    }
    n.style.background = isError ? "#dc2626" : "#374151";
    n.textContent = `处理类型 v${VERSION}：${text}`;
    if (!isError) setTimeout(() => n.remove(), 6000);
  }

  function backend(path, method = "GET", body) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, status: 0, error: "timeout" }), BACKEND_TIMEOUT_MS);
      const done = (r) => { clearTimeout(timer); resolve(r); };
      if (!chrome.runtime?.id) return done({ ok: false, status: 0, error: "插件已更新，请刷新页面" });
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

  function errText(res) {
    return res.data?.detail || res.data?.error || res.error || `HTTP ${res.status}`;
  }

  // ─── Reading the card ───────────────────────────────────────────────────────

  function readTicket(ticket) {
    const link = ticket.querySelector("a.MasterActionLink");
    const title = link ? (link.getAttribute("title") || link.textContent || "") : "";
    const preview = (ticket.querySelector("div.Preview .Content.ArticleBody") ||
      ticket.querySelector("div.Preview li.Active div.HiddenBlock"))?.innerText || "";
    const idMatch = (link?.getAttribute("href") || "").match(/TicketID=(\d+)/);
    // Preview header: "Peter Leung <peterleung401@yahoo.com> – Subject"
    const header = ticket.querySelector("div.Preview")?.innerText || "";
    const nameMatch = header.match(/(?:^|\n)\s*([^\n<>@]{2,60}?)\s*<[^>\s]+@[^>\s]+>/);
    return {
      id: idMatch ? idMatch[1] : "",
      href: link?.href || "",
      subject: title.replace(/^Ticket#\d+\s*[–-]\s*/i, "").trim(),
      text: preview.trim(),
      name: (nameMatch?.[1] || "").replace(/["']/g, "").trim()
    };
  }

  // Image attachments live on the zoom page only; fetched just for tickets
  // that look like free-credit requests.
  async function hasImageAttachments(ticketId) {
    try {
      const { doc } = await window.__ecZnuny.fetchDoc(
        window.__ecZnuny.indexUrl(`Action=AgentTicketZoom;TicketID=${encodeURIComponent(ticketId)}`));
      const names = Array.from(doc.querySelectorAll(
        "[id^='TicketAttachment'] .AttachmentElement h3 a, a[href*='AgentTicketAttachment']"))
        .map((a) => (a.getAttribute("title") || a.textContent || "").trim());
      return names.some((n) => IMAGE_RE.test(n));
    } catch (error) {
      log("attachment check failed", ticketId, error?.message);
      return false;
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  function rowFor(ticket) {
    let row = ticket.querySelector(".ec-tri-row");
    if (row) return row.querySelector("td");
    const tbody = ticket.querySelector("div.Infos table tbody");
    if (!tbody) return null;
    const cols = Math.max(2, ...Array.from(tbody.rows).map((r) =>
      Array.from(r.cells).reduce((n, c) => n + (c.colSpan || 1), 0)));
    row = document.createElement("tr");
    row.className = "ec-tri-row";
    const td = document.createElement("td");
    td.colSpan = cols;
    row.appendChild(td);
    // Above the order row (queue-order-lookup.js), below Znuny's own fields.
    tbody.insertBefore(row, tbody.querySelector(".ec-order-row"));
    return td;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderLoading(ticket) {
    const td = rowFor(ticket);
    if (td) td.replaceChildren(el("span", "ec-tri-muted", "处理类型分析中…"));
  }

  function renderResult(ticket, info, result) {
    const td = rowFor(ticket);
    if (!td) return;
    const box = el("div", "ec-tri-box");
    const head = el("div", "ec-tri-head");
    const type = el("span", `ec-tri-type ec-tri-${result.category}`,
      result.case_label ? `${result.category_label} · ${result.case_label}` : result.category_label);
    type.title = `判断来源：${result.engine}`;
    head.appendChild(type);

    const spec = BUTTONS[result.action] || BUTTONS.open;
    const btn = el("button", `ec-tri-btn ${spec.cls}`, spec.text);
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAction(ticket, info, result, btn, status);
    });
    head.appendChild(btn);
    const status = el("span", "ec-tri-status");
    head.appendChild(status);

    box.appendChild(head);
    box.appendChild(el("div", "ec-tri-summary", result.summary || ""));
    td.replaceChildren(box);
  }

  function setStatus(status, text, kind = "") {
    status.textContent = text;
    status.className = `ec-tri-status ${kind ? "ec-tri-" + kind : ""}`.trim();
  }

  // ─── Actions ────────────────────────────────────────────────────────────────

  async function orderRows(ticket) {
    if (Array.isArray(ticket.__ecOrderRows)) return { rows: ticket.__ecOrderRows, email: ticket.__ecOrderEmail || "" };
    const lookup = window.__ecOrderLookup;
    const email = lookup?.resolveCustomerEmail(ticket) || "";
    if (!email) return { rows: [], email: "" };
    const rows = await lookup.searchOrders(`${location.protocol}//${location.host}`, email).catch(() => []);
    return { rows, email };
  }

  function noteBody(result, email, rows) {
    const lines = [`AI 摘要：${result.summary || "-"}`, `客户邮箱：${email || "-"}`, ""];
    if (!rows.length) {
      lines.push("订单：未查到订单");
    } else {
      lines.push("订单：");
      rows.forEach((r) => lines.push("- " + [r.Product, r["Purchase Date"], r.Provider, r["Order ID"],
        r["License Key"], r.Amount, r.Status].filter(Boolean).join(" | ")));
    }
    return lines.join("\n");
  }

  function fillName(text, info) {
    return String(text || "").replace(/\{name\}/g, info.name || "User");
  }

  async function runAction(ticket, info, result, btn, status) {
    const z = window.__ecZnuny;
    const label = `工单 ${info.subject.slice(0, 60)}`;
    const action = result.action;

    if (action === "open" || action === "manual_review") {
      window.open(info.href, "_blank");
      return;
    }
    if (!z) {
      setStatus(status, "插件脚本未加载，请刷新页面", "err");
      return;
    }

    btn.disabled = true;
    try {
      if (action === "transfer_julie") {
        setStatus(status, "读取订单…");
        const { rows, email } = await orderRows(ticket);
        const body = noteBody(result, email, rows);
        if (!window.confirm(`${label}\n\n转交给【${result.owner}】\n标题改为【${result.title}】\n备注：\n${body}\n\n确定执行吗？`)) {
          setStatus(status, "");
          return;
        }
        setStatus(status, "转交中…");
        const res = await z.changeOwner(info.id, { owner: result.owner, title: result.title, subject: result.title, body });
        if (!res.ok) throw new Error(res.error);
        setStatus(status, `✓ 已转交给 ${res.owner}`, "ok");
        ticket.dataset.ecTriageDone = "1";
        return;
      }

      if (action.startsWith("reply_ask_")) {
        // The agent's own reply window with the fixed text filled in; the
        // agent reviews and clicks Send there. Opened now, while the click
        // still counts as a user gesture.
        const win = window.open("about:blank", `ec-reply-${info.id}`, "width=1100,height=850");
        setStatus(status, "打开回复窗口…");
        try {
          await z.openReplyDraft(info.id, { text: fillName(result.reply_text, info), win });
        } catch (error) {
          win?.close();
          throw error;
        }
        setStatus(status, "已打开回复窗口，请确认后发送", "warn");
        return;
      }

      if (action === "draft_reply") {
        // Open the window now, while the click still counts as a user gesture.
        const win = window.open("about:blank", `ec-reply-${info.id}`, "width=1100,height=850");
        setStatus(status, "搜索知识库并生成回复…");
        const { rows } = await orderRows(ticket);
        const res = await backend("/queue-triage/draft", "POST", {
          ticket_id: info.id, subject: info.subject, text: info.text, customer_name: info.name, orders: rows
        });
        if (!res.ok || !res.data?.draft) {
          win?.close();
          throw new Error(errText(res));
        }
        await z.openReplyDraft(info.id, { text: res.data.draft, win });
        const kb = (res.data.knowledge || []).length ? `（参考：${res.data.knowledge.join("、")}）` : "（知识库无匹配）";
        setStatus(status, `已打开回复窗口，请确认后发送 ${kb}`, "warn");
        return;
      }
    } catch (error) {
      setStatus(status, `失败：${error?.message || error}`, "err");
    } finally {
      if (!ticket.dataset.ecTriageDone) btn.disabled = false;
    }
  }

  // ─── Triage run ─────────────────────────────────────────────────────────────

  async function triage(tickets) {
    const items = tickets.map((ticket) => ({ ticket, info: readTicket(ticket) })).filter((x) => x.info.id);
    if (!items.length) return;
    items.forEach(({ ticket }) => renderLoading(ticket));

    const payload = await Promise.all(items.map(async ({ info }) => ({
      ticket_id: info.id,
      subject: info.subject,
      text: info.text,
      has_images: CREDIT_HINT_RE.test(`${info.subject} ${info.text}`) && window.__ecZnuny
        ? await hasImageAttachments(info.id) : false
    })));

    const res = await backend("/queue-triage", "POST", { tickets: payload });
    if (!res.ok) {
      log("triage failed:", errText(res));
      notice(`后端调用失败：${errText(res)}`, true);
      items.forEach(({ ticket }) => {
        const td = rowFor(ticket);
        if (td) td.replaceChildren(el("span", "ec-tri-muted", `处理类型分析失败：${errText(res)}`));
      });
      return;
    }
    const byId = new Map((res.data?.results || []).map((r) => [String(r.ticket_id), r]));
    const noRow = items.filter(({ ticket }) => !ticket.querySelector(".ec-tri-row")).length;
    notice(`已分析 ${byId.size} 张工单` + (noRow ? `，${noRow} 张找不到插入位置` : ""), noRow > 0);
    items.forEach(({ ticket, info }) => {
      const r = byId.get(info.id);
      if (r) renderResult(ticket, info, r);
    });
  }

  function injectStyles() {
    if (document.getElementById("ec-tri-styles")) return;
    const style = document.createElement("style");
    style.id = "ec-tri-styles";
    style.textContent = `
      .ec-tri-row td { padding-top: 6px !important; }
      .ec-tri-box { max-width: 560px; }
      .ec-tri-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
      .ec-tri-type {
        display: inline-block; padding: 1px 7px; border-radius: 3px;
        font-size: 11px; font-weight: 700; color: #fff; background: #6b7280;
      }
      .ec-tri-cancel_renewal { background: #7c3aed; }
      .ec-tri-free_credit    { background: #0891b2; }
      .ec-tri-refund         { background: #dc2626; }
      .ec-tri-consult        { background: #16a34a; }
      .ec-tri-technical      { background: #ea580c; }
      .ec-tri-invoice        { background: #2563eb; }
      .ec-tri-summary { margin-top: 3px; font-size: 12px; line-height: 1.4; color: #374151; }
      .ec-tri-btn {
        padding: 1px 8px; font-size: 11px; font-weight: 600; line-height: 1.5;
        background: #fff; border: 1px solid currentColor; border-radius: 3px; cursor: pointer;
      }
      .ec-tri-btn:disabled { opacity: 0.5; cursor: default; }
      .ec-tri-btn-purple { color: #7c3aed; }
      .ec-tri-btn-blue   { color: #2563eb; }
      .ec-tri-btn-green  { color: #16a34a; }
      .ec-tri-btn-grey   { color: #6b7280; }
      .ec-tri-status { font-size: 11px; color: #6b7280; }
      .ec-tri-ok   { color: #16a34a; font-weight: 600; }
      .ec-tri-warn { color: #a16207; }
      .ec-tri-err  { color: #dc2626; }
      .ec-tri-muted { font-size: 11px; color: #9ca3af; }
    `;
    document.head.appendChild(style);
  }

  let started = false;

  function init() {
    if (started || !document.querySelector("li.MasterAction")) return;
    started = true;
    try {
      initInner();
    } catch (error) {
      console.error("[Email Copilot triage]", error);
      notice(`初始化出错：${error?.message || error}`, true);
    }
  }

  function initInner() {
    notice(`检测到 ${document.querySelectorAll("li.MasterAction").length} 张工单，分析中…`);
    log(`v${VERSION} queue page detected:`, document.querySelectorAll("li.MasterAction").length, "tickets");
    document.documentElement.dataset.ecTriageVersion = VERSION;
    injectStyles();
    const pending = () => Array.from(document.querySelectorAll("li.MasterAction:not([data-ec-triaged])"));
    const runNew = () => {
      const list = pending();
      list.forEach((t) => t.setAttribute("data-ec-triaged", "1"));
      if (list.length) triage(list).catch((error) => {
        console.error("[Email Copilot triage]", error);
        notice(`出错：${error?.message || error}`, true);
      });
    };
    runNew();
    const container = document.querySelector("li.MasterAction")?.parentElement;
    if (container) new MutationObserver(runNew).observe(container, { childList: true });
  }

  function start() {
    if (document.querySelector("li.MasterAction")) return init();
    if (!document.body) return;
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
