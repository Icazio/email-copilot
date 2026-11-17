// Side-panel UI for Znuny ticket actions (see znuny-actions.js).
// Loaded after panel.js. Every write action asks for confirmation first.

(function () {
  // Escalation presets from backend/prompts/guidance.json (cancel_renewal.has_active).
  const ESCALATIONS = [
    { id: "cancel_renewal", label: "取消续订 → Julie Cai", owner: "Julie Cai", title: "取消续订", subject: "取消续订" }
  ];
  const PENDING_REPLY_KEY = "ec-pending-reply";

  const $ = (id) => document.getElementById(id);
  const statusEl = $("taStatus");

  function setStatus(text, kind = "") {
    statusEl.textContent = text;
    statusEl.className = `ta-status ${kind}`.trim();
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // Ask the page directly instead of trusting tab.url: the content script
  // knows best whether it is on a ticket zoom page.
  async function send(action, params = {}) {
    const tab = await activeTab();
    if (!tab?.id) return { ok: false, error: "没有找到当前标签页" };
    const pageAction = (String(tab.url || "").match(/[?;&]Action=([A-Za-z]+)/) || [])[1] || "";
    if (pageAction && pageAction !== "AgentTicketZoom") {
      return { ok: false, error: `当前页面不是工单详情页（${pageAction}），请先点开一张工单` };
    }
    const message = { type: "EC_ZNUNY_ACTION", action, params };
    const ask = () => chrome.tabs.sendMessage(tab.id, message, { frameId: 0 }).catch(() => undefined);

    let res = await ask();
    if (res) return res;

    // The manifest content script isn't always present (e.g. tabs opened before
    // an extension update). Inject it on demand and ask again.
    try {
      await injectActions(tab.id);
    } catch (error) {
      return { ok: false, error: `无法在工单页加载插件脚本：${error?.message || error}` };
    }
    res = await ask();
    return res || { ok: false, error: "插件脚本已注入，但页面没有响应。请确认当前页面是工单详情页" };
  }

  function injectActions(tabId) {
    return chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["znuny-actions.js"] });
  }

  // Wait for a newly opened tab to finish loading.
  function waitForTabComplete(tabId, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
      const timer = setTimeout(done, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }).catch(done);
    });
  }

  async function reloadTicketTab() {
    const tab = await activeTab();
    if (tab?.id) chrome.tabs.reload(tab.id);
  }

  async function ticketLabel() {
    const info = await send("info");
    return info.ok ? `工单 ${info.ticketNumber || "#" + info.ticketId}` : "";
  }

  async function runWrite(confirmText, action, params, describe) {
    const label = await ticketLabel();
    if (!label) {
      setStatus("请先打开一张工单的详情页", "err");
      return;
    }
    if (!window.confirm(`${label}\n\n${confirmText}\n\n确定执行吗？`)) return;
    setStatus("执行中…");
    const res = await send(action, params);
    if (!res.ok) {
      setStatus(`失败：${res.error}`, "err");
      return;
    }
    const warn = (res.warnings || []).length ? `\n注意：${res.warnings.join("；")}` : "";
    setStatus(`✓ ${describe(res)}${warn}`, "ok");
    reloadTicketTab();
  }

  // ─── Note ──────────────────────────────────────────────────────────────────

  $("taNoteBtn").addEventListener("click", () => {
    const subject = $("taNoteSubject").value.trim();
    const body = $("taNoteBody").value.trim();
    if (!body) {
      setStatus("请先填写备注内容", "err");
      return;
    }
    runWrite(`添加一条【内部备注】（客户看不到）：\n${subject ? "标题：" + subject + "\n" : ""}${body.slice(0, 300)}`,
      "note", { subject, body }, () => {
        $("taNoteSubject").value = "";
        $("taNoteBody").value = "";
        return "已添加内部备注";
      });
  });

  // ─── Escalations ───────────────────────────────────────────────────────────

  function orderContext() {
    return ($("manualLookup")?.value || "").trim();
  }

  ESCALATIONS.forEach((preset) => {
    const btn = document.createElement("button");
    btn.className = "btn-ghost-sm";
    btn.textContent = preset.label;
    btn.addEventListener("click", () => {
      const body = orderContext();
      if (!body && !window.confirm("「订单查询结果」框是空的，转交备注里将没有订单信息。仍然继续吗？")) return;
      runWrite(
        `转交给【${preset.owner}】\n标题改为【${preset.title}】\n备注：${body ? body.slice(0, 200) + (body.length > 200 ? "…" : "") : "（无订单信息）"}`,
        "owner",
        { owner: preset.owner, title: preset.title, subject: preset.subject, body: body || preset.subject },
        (res) => `已转交给 ${res.owner}`
      );
    });
    $("taEscalations").appendChild(btn);
  });

  // ─── Lock / close ──────────────────────────────────────────────────────────

  $("taLockBtn").addEventListener("click", () =>
    runWrite("锁定工单（锁定给你自己）", "lock", {}, () => "已锁定"));
  $("taUnlockBtn").addEventListener("click", () =>
    runWrite("解锁工单", "unlock", {}, () => "已解锁"));
  $("taCloseBtn").addEventListener("click", () =>
    runWrite("把工单状态改为【成功关闭】", "close", { state: "successful" }, (res) => `已关闭（${res.state}）`));

  // ─── Inspect (read-only) ───────────────────────────────────────────────────

  document.querySelectorAll(".ta-inspect").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const out = $("taInspectOut");
      out.textContent = "读取中…";
      const res = await send("inspect", { action: btn.dataset.action });
      if (!res.ok) {
        out.textContent = `失败：${res.error}`;
        return;
      }
      out.textContent = [`${res.action}  RichText=${res.richText}`]
        .concat(res.fields.map((f) =>
          `${f.required ? "*" : " "} ${f.name} [${f.type}] ${f.label}${f.value ? " " + f.value : ""}` +
          (f.options ? `\n     选项: ${f.options.slice(0, 15).join(" | ")}${f.options.length > 15 ? " …" : ""}` : "")))
        .join("\n");
    });
  });

  // ─── Records: refund (Feishu) / credit (Tencent Docs) ──────────────────────

  const CREDIT_SHEET_URL = "https://docs.qq.com/sheet/DWmVpcVpqWGRiTUVK?tab=BB08J2";
  const form = {
    box: $("taRecordForm"), title: $("taRecordTitle"), hint: $("taRecordHint"),
    fields: $("taRecordFields"), submit: $("taRecordSubmitBtn"), cancel: $("taRecordCancelBtn")
  };
  let onRecordSubmit = null;

  async function backendCall(path, method = "GET", body) {
    try {
      const res = await fetch(`${getBackendUrl()}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      return { ok: false, status: 0, data: { detail: `连不上后端：${error?.message || error}` } };
    }
  }

  function errText(res) {
    return res.data?.detail || res.data?.error || `HTTP ${res.status}`;
  }

  function closeRecordForm() {
    form.box.style.display = "none";
    form.fields.replaceChildren();
    onRecordSubmit = null;
  }

  // fields: [{ key, label, value, options?: [{value,label}], onChange? }]
  function openRecordForm(title, hint, fields, submit) {
    form.title.textContent = title;
    form.hint.innerHTML = "";
    (Array.isArray(hint) ? hint : [hint]).filter(Boolean).forEach((h) => {
      const div = document.createElement("div");
      div.className = h.warn ? "ta-warn" : "ta-hint";
      div.textContent = h.text || h;
      form.hint.appendChild(div);
    });
    form.fields.replaceChildren(...fields.map((f) => {
      const row = document.createElement("div");
      row.className = "ta-field";
      const label = document.createElement("label");
      label.textContent = f.label;
      let input;
      if (f.options) {
        input = document.createElement("select");
        f.options.forEach((o) => {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          input.appendChild(opt);
        });
        input.value = f.value || "";
      } else {
        input = document.createElement("input");
        input.type = f.checkbox ? "checkbox" : "text";
        if (f.checkbox) input.checked = Boolean(f.value);
        else input.value = f.value || "";
      }
      input.dataset.key = f.key;
      if (f.onChange) input.addEventListener("change", () => f.onChange(input.value));
      row.append(label, input);
      return row;
    }));
    onRecordSubmit = submit;
    form.box.style.display = "";
  }

  function recordValues() {
    const values = {};
    form.fields.querySelectorAll("[data-key]").forEach((el) => {
      values[el.dataset.key] = el.type === "checkbox" ? (el.checked ? "1" : "") : el.value.trim();
    });
    return values;
  }

  function setRecordValue(key, value) {
    const el = form.fields.querySelector(`[data-key='${key}']`);
    if (el) el.value = value || "";
  }

  form.cancel.addEventListener("click", closeRecordForm);
  form.submit.addEventListener("click", async () => {
    if (!onRecordSubmit) return;
    form.submit.disabled = true;
    try {
      await onRecordSubmit(recordValues());
    } finally {
      form.submit.disabled = false;
    }
  });

  function todayStr(sep) {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join(sep);
  }

  function orderLabel(row) {
    return [row["Order ID"], row.Product, row.Amount, row.Status].filter(Boolean).join(" · ");
  }

  function orderValues(row = {}) {
    return {
      order_id: row["Order ID"] || "",
      product: row.Product || "",
      amount: row.Amount || "",
      provider: row.Provider || "",
      purchase_date: (row["Purchase Date"] || "").slice(0, 10)
    };
  }

  // Copy & paste mode: the refund sheet lives in a personal Feishu library that
  // apps can't write to, so we build the row in the sheet's column order, copy
  // it, and open the sheet for the agent to paste.
  // Agents write an internal note titled "退款" before refunding:
  //   退款原因：重复购买
  //   mike phillips <a@b.com> US [AVCLabs Video Enhancer AI Win 1M / CODE]
  //    2026-11-12 01:20:22 - PADDLE - 75690737-172286972
  function parseRefundNote(text) {
    const reason = (String(text).match(/退款原因\s*[:：]\s*([^\n]+)/) || [])[1] || "";
    const m = String(text).match(/([^\n<]*?)\s*<([^>\s]+@[^>\s]+)>\s*([A-Z]{2})?\s*\[([^\]]+)\]\s*\n?\s*(\d{4}-\d{2}-\d{2}[\d: ]*?)\s+-\s+([A-Za-z]+)\s+-\s+([A-Za-z0-9-]+)/);
    if (!reason && !m) return null;
    return {
      reason: reason.trim(),
      email: m?.[2] || "",
      product: m?.[4]?.trim() || "",
      purchase_date: m?.[5]?.trim() || "",
      provider: m?.[6] || "",
      order_id: m?.[7] || ""
    };
  }

  function findRefundNote() {
    const articles = (typeof lastThreadStructured !== "undefined" && lastThreadStructured?.articles) || [];
    const candidates = articles
      .filter((a) => /退款/.test(a.subject || "") || /退款原因/.test(a.body || ""))
      .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
    for (const a of candidates) {
      const parsed = parseRefundNote(a.body || "");
      if (parsed) return parsed;
    }
    return parseRefundNote($("threadText")?.value || "");
  }

  // "AVCLabs Video Enhancer AI Win 1M / AVCLABS_VIDEO_ENHANCER_AI_WIN_1M" → name only.
  function productName(product) {
    return String(product || "").replace(/\s*\/\s*[A-Z0-9_]+\s*$/, "").trim();
  }

  // Same format as the agents' own "退款" note.
  function refundNoteBody(reason, row) {
    const who = [row.Customer, row.Email ? `<${row.Email}>` : "", row.Country].filter(Boolean).join(" ");
    const orderLine = [row["Purchase Date"], row.Provider, row["Order ID"]].filter(Boolean).join(" - ");
    return [`退款原因：${reason}`, "", `${who} [${row.Product || ""}]`, ` ${orderLine}`].join("\n");
  }

  async function openRefundPasteForm({ columns, sheet_url: sheetUrl }) {
    setStatus("");
    const info = await send("info");
    const orders = (window.ecLastOrderRows || []).filter((r) => r["Order ID"] || r.Product);
    const existingNote = findRefundNote();
    const best = (existingNote?.order_id && orders.find((r) => r["Order ID"] === existingNote.order_id)) ||
      orders.find((r) => /paid|completed|active/i.test(r.Status || "")) || orders[0] || {};
    const { agentName = "" } = await chrome.storage.local.get("agentName");
    const ticket = info.ok ? info.ticketNumber || "" : "";

    // Order details: order lookup first, the agent's existing "退款" note as fallback.
    const fromNote = existingNote || {};
    const prefill = {
      date: todayStr("."),
      ticket: ticket ? `#${ticket}` : "", // sheet format: #2026111610000285
      order_id: best["Order ID"] || fromNote.order_id || "",
      // The purchase email (order / refund note) beats the ticket's contact address.
      email: best.Email || fromNote.email || $("customerEmailInput")?.value.trim() || "",
      product: productName(best.Product || fromNote.product),
      reason: fromNote.reason || "",
      refund_type: "", // left blank on purpose
      agent: agentName,
      note: "" // 备注 is left for the agent; not prefilled
    };

    const fields = [];
    if (orders.length > 1) {
      fields.push({
        key: "_order", label: "选择订单", value: String(orders.indexOf(best)),
        options: orders.map((r, i) => ({ value: String(i), label: orderLabel(r) })),
        onChange: (i) => {
          const row = orders[Number(i)] || {};
          setRecordValue("order_id", row["Order ID"] || "");
          setRecordValue("product", productName(row.Product));
        }
      });
    }
    columns.forEach((c) => fields.push({ key: c.key, label: c.header, value: prefill[c.key] }));
    // Not a sheet column (it goes into 备注) but needed to catch duplicate records.
    if (!columns.some((c) => c.key === "order_id")) {
      fields.push({ key: "order_id", label: "订单号（查重用）", value: prefill.order_id });
    }
    // Offer to write the agents' usual "退款" note when the ticket has none yet.
    const canAddNote = info.ok && !existingNote && orders.length > 0;
    if (canAddNote) fields.push({ key: "_addNote", label: "工单备注", checkbox: true, value: true });

    openRecordForm(
      "记录退款 → 飞书退款表",
      [
        existingNote ? `已从工单里的「退款」备注读取：${existingNote.reason ? "退款原因、" : ""}订单信息。` : "",
        orders.length || existingNote ? "" : { text: "没有订单查询结果，订单信息需要手动填写。", warn: true },
        canAddNote ? "勾选「工单备注」会同时在工单里添加一条「退款」内部备注（退款原因 + 订单信息）。" : "",
        "确认后会复制这一行并打开退款表，在第一个空行的第一格按 Ctrl+V 粘贴。"
      ],
      fields,
      async (values) => {
        const orderIndex = values._order;
        const addNote = values._addNote === "1";
        delete values._order;
        delete values._addNote;
        if (addNote && !values.reason) {
          setStatus("要添加工单备注，请先填写退款原因", "err");
          return;
        }
        if (!values.order_id && !window.confirm("没有填订单号，无法检查是否重复记录。仍然记录吗？")) return;
        chrome.storage.local.set({ agentName: values.agent || "" });
        const payload = { values };
        let res = await backendCall("/records/refund/row", "POST", payload);
        if (res.status === 409 && res.data?.duplicate) {
          if (!window.confirm(`${res.data.error}。仍然再记录一次吗？`)) return;
          res = await backendCall("/records/refund/row", "POST", { ...payload, force: true });
        }
        if (!res.ok) {
          setStatus(`生成退款行失败：${errText(res)}`, "err");
          return;
        }
        await navigator.clipboard.writeText(res.data.row);

        let noteMsg = "";
        if (addNote) {
          const row = orders[Number(orderIndex ?? orders.indexOf(best))] || best;
          const noteRes = await send("note", { subject: "退款", body: refundNoteBody(values.reason, row) });
          noteMsg = noteRes.ok ? "\n✓ 已在工单里添加「退款」备注" : `\n⚠ 工单备注没加上：${noteRes.error}`;
        }

        await chrome.tabs.create({ url: sheetUrl });
        setStatus(`✓ 已复制退款行并打开退款表：在第一个空行的第一格（日期列）按 Ctrl+V 粘贴。${noteMsg}`,
          noteMsg.includes("⚠") ? "err" : "ok");
        closeRecordForm();
      }
    );
  }

  $("taRefundOpenBtn").addEventListener("click", async () => {
    setStatus("读取退款表结构…");
    const schema = await backendCall("/records/refund/schema");
    if (!schema.ok) {
      setStatus(`无法读取退款表：${errText(schema)}`, "err");
      return;
    }
    if (!schema.data.configured) {
      openRefundPasteForm(schema.data);
      return;
    }
    setStatus("");
    const info = await send("info");
    const orders = (window.ecLastOrderRows || []).filter((r) => r["Order ID"] || r.Product);
    const best = orders.find((r) => /paid|completed|active/i.test(r.Status || "")) || orders[0] || {};
    const { agentName = "" } = await chrome.storage.local.get("agentName");

    const prefill = {
      date: todayStr("-"),
      ticket: info.ok ? info.ticketNumber || "" : "",
      email: $("customerEmailInput")?.value.trim() || "",
      reason: "",
      agent: agentName,
      status: "",
      note: "",
      ...orderValues(best)
    };

    const mapped = schema.data.columns.filter((c) => c.key);
    const unmapped = schema.data.columns.filter((c) => !c.key && c.header).map((c) => c.header);
    const fields = [];
    if (orders.length > 1) {
      fields.push({
        key: "_order", label: "选择订单", value: String(orders.indexOf(best)),
        options: orders.map((r, i) => ({ value: String(i), label: orderLabel(r) })),
        onChange: (i) => Object.entries(orderValues(orders[Number(i)])).forEach(([k, v]) => setRecordValue(k, v))
      });
    }
    mapped.forEach((c) => fields.push({ key: c.key, label: c.header, value: prefill[c.key] }));

    openRecordForm(
      `记录退款 → ${schema.data.title || "飞书退款表"}`,
      [
        orders.length ? "" : { text: "没有订单查询结果，订单信息需要手动填写。", warn: true },
        unmapped.length ? `这些列没认出来，会留空：${unmapped.join("、")}` : ""
      ],
      fields,
      async (values) => {
        delete values._order;
        if (!values.order_id && !window.confirm("没有填订单号，仍然记录吗？")) return;
        if (values.agent) chrome.storage.local.set({ agentName: values.agent });
        let res = await backendCall("/records/refund", "POST", { values });
        if (res.status === 409 && res.data?.duplicate) {
          if (!window.confirm(`${res.data.error}。仍然再记录一次吗？`)) return;
          res = await backendCall("/records/refund", "POST", { values, force: true });
        }
        if (!res.ok) {
          setStatus(`记录退款失败：${errText(res)}`, "err");
          return;
        }
        setStatus(`✓ 已写入飞书退款表（${(res.data.written || []).join("、")}）`, "ok");
        closeRecordForm();
      }
    );
  });

  $("taCreditOpenBtn").addEventListener("click", async () => {
    setStatus("提取积分信息…");
    const pre = await backendCall("/records/credit/prefill", "POST", {
      subject: $("subject")?.value || "",
      thread_text: $("threadText")?.value || "",
      thread_structured: typeof lastThreadStructured !== "undefined" ? lastThreadStructured : null
    });
    if (!pre.ok) {
      setStatus(`无法提取积分信息：${errText(pre)}`, "err");
      return;
    }
    setStatus("");
    const v = pre.data.values;
    const info = await send("info");
    const hints = [];
    if (!$("threadText")?.value.trim()) hints.push({ text: "还没抓取邮件（Capture），下面的内容需要手动填写。", warn: true });
    if (pre.data.youtube_pending) hints.push({ text: "YouTube 还在等客户发截图，确认后再记录。", warn: true });
    if (pre.data.needs_check) hints.push({ text: "有截图需要人工核实渠道。", warn: true });
    (pre.data.previous || []).forEach((p) => hints.push({ text: `该邮箱 ${p.ts.slice(0, 10)} 已记录过 ${p.credits || "?"} 积分`, warn: true }));
    hints.push("确认后会复制这一行并打开积分表，在第一个空行按 Ctrl+V 粘贴。");

    openRecordForm("记录积分 → 腾讯文档", hints, [
      { key: "date", label: "日期", value: v.date },
      { key: "email", label: "客户邮箱", value: v.email },
      { key: "channels", label: "有效渠道", value: v.channels },
      { key: "credits", label: "积分", value: v.credits },
      { key: "reserved", label: "预留", value: v.reserved },
      { key: "links", label: "链接", value: v.links }
    ], async (values) => {
      if (!values.email || !values.credits) {
        setStatus("客户邮箱和积分不能为空", "err");
        return;
      }
      const res = await backendCall("/records/credit", "POST", { values: { ...values, ticket: info.ok ? info.ticketNumber : "" } });
      if (!res.ok) {
        setStatus(`生成积分行失败：${errText(res)}`, "err");
        return;
      }
      await navigator.clipboard.writeText(res.data.row);
      await chrome.tabs.create({ url: CREDIT_SHEET_URL });
      setStatus("✓ 已复制积分行并打开积分表：在第一个空行的第一格按 Ctrl+V 粘贴。", "ok");
      closeRecordForm();
    });
  });

  // ─── "填入回复框" on AI drafts ─────────────────────────────────────────────

  async function fillReply(text, btn) {
    const res = await send("replyUrl");
    if (!res.ok) {
      setStatus(`无法打开回复：${res.error}`, "err");
      btn.textContent = "填入回复框";
      return;
    }
    await chrome.storage.local.set({ [PENDING_REPLY_KEY]: { ticketId: res.ticketId, text, ts: Date.now() } });
    const win = await chrome.windows.create({ url: res.url, type: "popup", width: 1000, height: 820 });
    // Make sure the fill script runs in the reply window even if the manifest
    // injection didn't happen (it only runs once per page either way).
    const replyTabId = win?.tabs?.[0]?.id;
    if (replyTabId) {
      await waitForTabComplete(replyTabId);
      await injectActions(replyTabId).catch(() => {});
    }
    btn.textContent = "✓ 已打开";
    setTimeout(() => { btn.textContent = "填入回复框"; }, 2000);
  }

  function addFillButton(wrap) {
    if (!wrap.dataset.draft || wrap.querySelector(".chat-fill-btn")) return;
    const btn = document.createElement("button");
    btn.className = "chat-copy-btn chat-fill-btn";
    btn.textContent = "填入回复框";
    btn.title = "打开 Znuny 回复窗口并填入这段英文邮件（不含中文翻译和备注），检查后自己点发送";
    btn.addEventListener("click", () => {
      btn.textContent = "打开中…";
      fillReply(wrap.dataset.draft, btn);
    });
    wrap.querySelector(".chat-copy-btn")?.after(btn);
  }

  const chat = $("chatMessages");
  chat.querySelectorAll(".chat-message-assistant").forEach(addFillButton);
  new MutationObserver((mutations) => {
    mutations.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType === 1 && n.classList.contains("chat-message-assistant")) addFillButton(n);
    }));
  }).observe(chat, { childList: true });
})();
