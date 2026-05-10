(function () {
  // Shared with content.js via same page context — only run on queue pages.

  const ORDER_CONTEXT_TTL = 10 * 60 * 1000;
  const ORDER_RESULT_TTL  =  5 * 60 * 1000;
  const CONCURRENCY       = 3;

  let contextCache   = null;
  let contextPromise = null;
  const resultCache  = new Map();

  // ─── Helpers (ported from panel.js) ────────────────────────────────────────

  function cellText(cell) {
    return (cell?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function buildAbsoluteUrl(origin, action) {
    try { return new URL(action || "/otrs/index.pl", `${origin}/`).toString(); }
    catch (_) { return `${origin}/otrs/index.pl`; }
  }

  function collectFieldMap(root) {
    const map = {};
    Array.from(root.querySelectorAll("input, select, textarea")).forEach((node) => {
      const name = node.getAttribute("name");
      if (!name || map[name] !== undefined) return;
      if (node.tagName === "SELECT") { map[name] = node.value || ""; return; }
      const type = (node.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (node.checked) map[name] = node.value || "1";
        return;
      }
      map[name] = node.value || "";
    });
    return map;
  }

  function pickOrderSearchForm(doc) {
    return Array.from(doc.querySelectorAll("form")).find((form) => {
      const names = Array.from(form.querySelectorAll("input, select, textarea"))
        .map((n) => n.getAttribute("name") || "").filter(Boolean);
      return names.includes("Email") && names.includes("ChallengeToken");
    }) || null;
  }

  function parseOrderRows(doc) {
    const results = [];
    for (const table of Array.from(doc.querySelectorAll("table"))) {
      const headers = Array.from(table.querySelectorAll("thead th, tr th"))
        .map(cellText).filter(Boolean);
      const norm = headers.map((h) => h.toLowerCase());
      if (!norm.some((h) => /(email|order|product|license|status|date|invoice|payment)/.test(h))) continue;
      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter((r) => r.querySelectorAll("td").length);
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td")).map(cellText);
        if (!cells.some(Boolean)) continue;
        const record = {};
        if (headers.length === cells.length) headers.forEach((h, i) => { record[h] = cells[i] || ""; });
        else cells.forEach((v, i) => { record[`col_${i + 1}`] = v; });
        results.push(record);
      }
      if (results.length) break;
    }
    return results;
  }

  function getPrimaryDetailText(doc) {
    const heading = Array.from(doc.querySelectorAll("h1, h2, h3, legend, strong, b"))
      .find((n) => /details of order/i.test(n.textContent || ""));
    if (!heading) return "";
    let best = "", cursor = heading.parentElement, hops = 0;
    while (cursor && hops < 4) {
      const t = (cursor.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > best.length) best = t;
      cursor = cursor.parentElement; hops++;
    }
    return best.slice(0, 12000);
  }

  function parseDefinitionPairs(doc) {
    const pairs = [];
    Array.from(doc.querySelectorAll("dl")).forEach((dl) => {
      const dts = Array.from(dl.querySelectorAll("dt"));
      const dds = Array.from(dl.querySelectorAll("dd"));
      dts.forEach((dt, i) => {
        const k = cellText(dt), v = cellText(dds[i]);
        if (k && v) pairs.push({ key: k, value: v });
      });
    });
    Array.from(doc.querySelectorAll("table")).forEach((table) => {
      Array.from(table.querySelectorAll("tr")).forEach((row) => {
        const cells = Array.from(row.querySelectorAll("th, td"));
        if (cells.length === 2) {
          const k = cellText(cells[0]), v = cellText(cells[1]);
          if (k && v && k.length < 80) pairs.push({ key: k, value: v });
        }
      });
    });
    return pairs.slice(0, 40);
  }

  function normalizeOrderRows(orderRows, definitionPairs) {
    if (orderRows.length) return orderRows;
    if (!definitionPairs.length) return [];
    const record = {};
    definitionPairs.forEach(({ key, value }) => { record[key] = value; });
    return Object.keys(record).length ? [record] : [];
  }

  function parseOrderRowsFromDetailBlocks(detailBlocks, email) {
    const ep = String(email || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(?:([^<\\n]+?)\\s*)?<${ep}>\\s+([A-Z]{2})\\s+\\[([^\\]]+)\\]\\s+([\\s\\S]*?)(?=(?:(?:[^<\\n]+?)\\s*)?<${ep}>\\s+[A-Z]{2}\\s+\\[|$)`,
      "gi"
    );
    for (const block of detailBlocks) {
      const text = String(block?.text_full || block?.text_preview || "")
        .replace(/\s+/g, " ").replace(/^.*?Details of Order\s*/i, "").trim();
      const matches = Array.from(text.matchAll(re));
      if (!matches.length) continue;
      return matches.map((m) => {
        const tail  = String(m[4] || "").replace(/\s+/g, " ").trim();
        const parts = tail.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
        return {
          Customer:        String(m[1] || "").trim(),
          Email:           email,
          Country:         String(m[2] || "").trim(),
          Product:         String(m[3] || "").trim(),
          "Purchase Date": parts[0] || "",
          Provider:        parts[1] || "",
          "Order ID":      parts[2] || "",
          "License Key":   parts[3] || "",
          Amount:          parts[4] || "",
          Status:          parts.slice(5).join(" - ") || ""
        };
      }).filter((r) => r.Product || r["Order ID"] || r.Amount);
    }
    return [];
  }

  // ─── Context fetch (shared, cached) ─────────────────────────────────────────

  async function fetchContext(origin) {
    if (
      contextCache &&
      contextCache.origin === origin &&
      contextCache.payloadBase?.ChallengeToken &&
      Date.now() - contextCache.fetchedAt < ORDER_CONTEXT_TTL
    ) return contextCache;

    if (contextPromise) return contextPromise;

    contextPromise = (async () => {
      const res  = await fetch(`${origin}/otrs/index.pl?Action=AgentOrderSearch`, { credentials: "include" });
      const html = await res.text();
      const doc  = new DOMParser().parseFromString(html, "text/html");
      const form = pickOrderSearchForm(doc);
      if (!form) throw new Error("AgentOrderSearch form not found");
      const payloadBase = collectFieldMap(form);
      payloadBase.Action    = payloadBase.Action    || "AgentOrderSearch";
      payloadBase.Subaction = payloadBase.Subaction || "Search";
      contextCache = {
        origin,
        fetchedAt:  Date.now(),
        submitUrl:  buildAbsoluteUrl(origin, form.getAttribute("action")),
        payloadBase
      };
      return contextCache;
    })();

    try { return await contextPromise; }
    finally { contextPromise = null; }
  }

  // Direct DOM parser for h4 + p.FieldExplanation structure
  function parseOrderRowsDom(doc) {
    const heading = Array.from(doc.querySelectorAll("h2, h3, label"))
      .find((n) => /details of order/i.test(n.textContent || ""));
    if (!heading) return [];

    const widget  = heading.closest(".WidgetSimple, .Widget, .Content") || heading.parentElement;
    const content = widget?.querySelector(".Content") || widget;
    if (!content) return [];

    const results = [];
    const h4s = Array.from(content.querySelectorAll("h4"));

    for (const h4 of h4s) {
      const headerText = h4.textContent.replace(/\s+/g, " ").trim();
      const m = headerText.match(/<([^>]+)>\s+([A-Z]{2})\s+\[([^\]]+)\]/);
      if (!m) continue;

      let next = h4.nextElementSibling;
      while (next && next.tagName !== "P" && next.tagName !== "H4") {
        next = next.nextElementSibling;
      }

      const financial = (next?.tagName === "P")
        ? next.textContent.replace(/\s+/g, " ").trim()
        : "";
      const parts = financial.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);

      results.push({
        Email:           m[1],
        Country:         m[2],
        Product:         m[3],
        "Purchase Date": parts[0] || "",
        Provider:        parts[1] || "",
        "Order ID":      parts[2] || "",
        "License Key":   parts[3] || "",
        Amount:          parts[4] || "",
        Status:          parts.slice(5).join(" - ") || ""
      });
    }

    return results.filter((r) => r.Product || r["Order ID"] || r.Amount);
  }

  // ─── Per-email search ────────────────────────────────────────────────────────

  async function searchOrders(origin, email) {
    const key    = `${origin}::${email.toLowerCase()}`;
    const cached = resultCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < ORDER_RESULT_TTL) return cached.rows;

    const ctx     = await fetchContext(origin);
    const payload = { ...ctx.payloadBase, Email: email };
    let res = await fetch(ctx.submitUrl, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload).toString()
    });
    let html = await res.text();
    let doc  = new DOMParser().parseFromString(html, "text/html");

    if (/login\s*-\s*znuny/i.test(doc.title || "")) {
      const ctx2    = await fetchContext(origin, { forceRefresh: true });
      const payload2 = { ...ctx2.payloadBase, Email: email };
      res  = await fetch(ctx2.submitUrl, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(payload2).toString()
      });
      html = await res.text();
      doc  = new DOMParser().parseFromString(html, "text/html");
    }

    let rows = parseOrderRowsDom(doc);
    if (!rows.length) {
      const detailText = getPrimaryDetailText(doc);
      rows = parseOrderRowsFromDetailBlocks(
        detailText ? [{ text_full: detailText }] : [], email
      );
    }
    if (!rows.length) {
      const raw   = parseOrderRows(doc);
      const pairs = parseDefinitionPairs(doc);
      rows = normalizeOrderRows(raw, pairs);
    }

    resultCache.set(key, { rows, fetchedAt: Date.now() });
    return rows;
  }

  // ─── UI rendering ────────────────────────────────────────────────────────────

  function injectOrderStyles() {
    if (document.getElementById("ec-order-styles")) return;
    const style = document.createElement("style");
    style.id = "ec-order-styles";
    style.textContent = `
      .ec-order-row td {
        padding-top: 4px !important;
      }
      .ec-order-info {
        display: block;
        max-width: 340px;
        margin-top: 2px;
      }
      .ec-order-info:first-child {
        margin-top: 0;
      }
      .ec-order-product {
        font-weight: 600;
        font-size: 12px;
        color: #1d4ed8;
        display: block;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 340px;
      }
      .ec-order-meta {
        font-size: 11px;
        color: #6b7280;
      }
      .ec-order-meta .ec-order-status-refunded { color: #dc2626; }
      .ec-order-meta .ec-order-status-active   { color: #16a34a; }
      .ec-order-loading {
        font-size: 11px;
        color: #9ca3af;
      }
      .ec-order-none {
        font-size: 11px;
        color: #d1d5db;
      }
    `;
    document.head.appendChild(style);
  }

  function statusClass(status) {
    const s = (status || "").toLowerCase();
    if (/refund|cancel|chargeback/.test(s)) return "ec-order-status-refunded";
    if (/active|complete|paid|success/.test(s)) return "ec-order-status-active";
    return "";
  }

  function insertOrderRow(ticket, content) {
    const table = ticket.querySelector("div.Infos table tbody");
    if (!table) return;
    if (ticket.querySelector(".ec-order-row")) return;
    const tr = document.createElement("tr");
    tr.className = "ec-order-row";
    tr.innerHTML = `<td colspan="2">${content}</td>`;
    table.appendChild(tr);
  }

  function renderOrderRow(row) {
    const product   = row.Product || row["col_1"] || "—";
    const date      = row["Purchase Date"] || "";
    const amount    = row.Amount || "";
    const status    = row.Status || "";
    const sc        = statusClass(status);
    const metaParts = [date, amount, status].filter(Boolean);
    const metaHtml  = metaParts
      .map((p, i) => i === metaParts.length - 1 && sc && status === p
        ? `<span class="${sc}">${p}</span>` : p)
      .join(" · ");
    return `<div class="ec-order-info">
      <span class="ec-order-product" title="${product}">${product}</span>
      ${metaHtml ? `<span class="ec-order-meta">${metaHtml}</span>` : ""}
    </div>`;
  }

  function renderOrderResult(ticket, rows) {
    const existing = ticket.querySelector(".ec-order-row td");
    if (!existing) return;
    if (!rows.length) {
      existing.innerHTML = `<span class="ec-order-none">无订单记录</span>`;
      return;
    }
    const sorted = [...rows].sort((a, b) =>
      (b["Purchase Date"] || "").localeCompare(a["Purchase Date"] || "")
    );
    const best = sorted.find((r) => r["Purchase Date"] || r.Amount || r.Status) || sorted[0];
    const extra = rows.length - 1;
    existing.innerHTML =
      renderOrderRow(best) +
      (extra > 0 ? `<span class="ec-order-meta" style="display:block;margin-top:2px">(+${extra} more)</span>` : "");
  }

  // Emails that are intermediaries — real customer email must come from body
  const RELAY_EMAILS = /^(assist@paddle\.com)$/i;

  const SYSTEM_EMAILS = /assist@paddle\.com|support@avclabs\.com|noreply@/i;

  function extractEmailFromBody(ticket) {
    const text = ticket.querySelector("div.Preview .Content.ArticleBody")?.innerText || "";
    const matches = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
    return matches.find((e) => !SYSTEM_EMAILS.test(e)) || "";
  }

  function resolveCustomerEmail(ticket) {
    const label = Array.from(ticket.querySelectorAll("label"))
      .find((el) => el.textContent.trim() === "客户ID");
    const raw = (
      label?.nextElementSibling?.getAttribute("title") ||
      label?.nextElementSibling?.textContent || ""
    ).trim();
    if (!raw) return "";
    if (RELAY_EMAILS.test(raw)) return extractEmailFromBody(ticket);
    return raw;
  }

  // ─── Throttled queue init ────────────────────────────────────────────────────

  async function initQueueOrderLookup() {
    if (!document.querySelector("li.MasterAction")) return;
    injectOrderStyles();

    const origin  = `${location.protocol}//${location.host}`;
    const tickets = Array.from(document.querySelectorAll("li.MasterAction"));

    // Collect tickets that have a customer email
    const work = tickets.map((ticket) => {
      const email = resolveCustomerEmail(ticket);
      return email ? { ticket, email } : null;
    }).filter(Boolean);

    if (!work.length) return;

    // Show loading placeholders
    work.forEach(({ ticket }) => {
      insertOrderRow(ticket, `<span class="ec-order-loading">查询中…</span>`);
    });

    // Throttled execution
    let index = 0;
    async function runNext() {
      if (index >= work.length) return;
      const { ticket, email } = work[index++];
      try {
        const rows = await searchOrders(origin, email);
        renderOrderResult(ticket, rows);
      } catch (_) {
        const cell = ticket.querySelector(".ec-order-row td");
        if (cell) cell.innerHTML = "";
      }
      await runNext();
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, work.length) }, runNext);
    await Promise.allSettled(workers);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initQueueOrderLookup);
  } else {
    initQueueOrderLookup();
  }
})();
