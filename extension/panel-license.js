// Side-panel UI for the tech-support "Online Check / Register Query" page
// (ipn.anvsoftware.com/query/onlinecheck.php): look up a license's activations
// and reset them (清空注册信息 = action=reg_init).
// Loaded after panel.js. Uses the agent's own login cookie for that site;
// the reset always asks for confirmation first.

(function () {
  const BASE = "https://ipn.anvsoftware.com/query/";
  const CHECK_URL = `${BASE}onlinecheck.php`;
  const LOGIN_URL = `${BASE}index.php`;

  const $ = (id) => document.getElementById(id);
  const els = {
    card: $("licenseCard"),
    product: $("licProduct"),
    email: $("licEmail"),
    code: $("licCode"),
    queryBtn: $("licQueryBtn"),
    result: $("licResult"),
    status: $("licStatus")
  };
  if (!els.card) return;

  let products = null;      // [{ value, label }]
  let productsPromise = null;
  let lastQuery = null;     // { ap, email, regcode, resetHref, info }

  function setStatus(text, kind = "") {
    els.status.textContent = text;
    els.status.className = `ta-status ${kind}`.trim();
  }

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  class NotLoggedInError extends Error {}

  async function fetchPage(url, init = {}) {
    const res = await fetch(url, { credentials: "include", cache: "no-store", ...init });
    if (!res.ok) throw new Error(`技术支持页面返回 HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc.querySelector('input[type="password"]') && !doc.querySelector('select[name="ap"]')) {
      throw new NotLoggedInError();
    }
    return doc;
  }

  // ─── Product list (app guid) ───────────────────────────────────────────────

  async function loadProducts() {
    if (products) return products;
    if (!productsPromise) {
      productsPromise = fetchPage(CHECK_URL).then((doc) => {
        const list = Array.from(doc.querySelectorAll('select[name="ap"] option'))
          .map((o) => ({ value: o.value, label: o.textContent.trim() }))
          .filter((o) => o.value);
        if (!list.length) throw new Error("没有在技术支持页面找到产品列表");
        products = list;
        renderProductOptions();
        return list;
      }).finally(() => { productsPromise = null; });
    }
    return productsPromise;
  }

  function renderProductOptions(selectedIndex = -1) {
    els.product.innerHTML = `<option value="">— 选择产品 —</option>` + products
      .map((p, i) => `<option value="${i}"${i === selectedIndex ? " selected" : ""}>${esc(p.label)}</option>`)
      .join("");
  }

  function tokens(text) {
    return String(text || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !["for", "the", "and", "ai"].includes(t));
  }

  // Order "Product" names look like "AVCLabs Video Enhancer AI (Windows)";
  // option labels look like "AVCLabs - VideoEnhancerAIWin". Score by shared words.
  function guessProductIndex(productName) {
    if (!products || !productName) return -1;
    const want = new Set(tokens(productName));
    const wantMac = /\bmac\b|macos|os x/i.test(productName);
    const wantWin = /\bwin(dows)?\b/i.test(productName);
    let best = -1, bestScore = 0;
    products.forEach((p, i) => {
      const have = tokens(p.label);
      let score = have.filter((t) => want.has(t)).length * 2 - have.length * 0.1;
      const isMac = /mac/i.test(p.label), isWin = /win/i.test(p.label);
      if (wantMac && isMac) score += 1;
      if (wantWin && isWin) score += 1;
      if (!wantMac && !wantWin && isWin) score += 0.5; // default to Windows
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return bestScore >= 2 ? best : -1;
  }

  // ─── Query + parse ─────────────────────────────────────────────────────────

  function parseResult(doc) {
    const tables = Array.from(doc.querySelectorAll("table"));
    const info = {};
    let resetHref = "";
    let machines = [];

    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      const firstCells = rows[0] ? Array.from(rows[0].querySelectorAll("td,th")).map((c) => c.textContent.trim()) : [];
      if (firstCells.includes("UID") || firstCells.includes("GUID")) {
        machines = rows.slice(1).map((r) => {
          const c = Array.from(r.querySelectorAll("td")).map((td) => td.textContent.trim());
          const rec = {};
          firstCells.forEach((h, i) => { rec[h] = c[i] || ""; });
          return rec;
        });
        continue;
      }
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length !== 2) continue;
        const key = cells[0].textContent.trim();
        if (key === "操作") {
          const a = Array.from(cells[1].querySelectorAll("a")).find((x) => /action=reg_init/.test(x.getAttribute("href") || ""));
          if (a) resetHref = new URL(a.getAttribute("href"), CHECK_URL).toString();
        } else if (key) {
          info[key] = cells[1].textContent.trim();
        }
      }
    }

    // Anything the page printed that isn't a table: useful when the code is not found.
    const message = Array.from(doc.body?.childNodes || [])
      .filter((n) => n.nodeType === 3 || (n.nodeType === 1 && /^(P|H3|B)$/.test(n.nodeName) && !n.getAttribute("style")))
      .map((n) => n.textContent.trim())
      .filter((t) => t && !/^-+/.test(t) && !/^(array|string|int)\(/.test(t))
      .join(" ")
      .slice(0, 300);

    return { info, machines, resetHref, message };
  }

  async function runQuery({ silentStatus = false } = {}) {
    const idx = els.product.value;
    const ap = idx !== "" && products ? products[Number(idx)].value : "";
    const email = els.email.value.trim();
    const regcode = els.code.value.trim();
    if (!ap) { setStatus("请先选择产品", "err"); return; }
    if (!email || !regcode) { setStatus("请填写邮箱和注册码", "err"); return; }

    if (!silentStatus) setStatus("查询中…");
    els.queryBtn.disabled = true;
    try {
      const body = new URLSearchParams({ ap, email, regcode, action: "query" });
      const doc = await fetchPage(CHECK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const parsed = parseResult(doc);
      lastQuery = { ap, email, regcode, ...parsed };
      renderResult(parsed);
      if (!silentStatus) setStatus(Object.keys(parsed.info).length ? "" : "没有查到注册码信息，请检查产品/邮箱/注册码", Object.keys(parsed.info).length ? "" : "err");
    } catch (err) {
      showError(err);
    } finally {
      els.queryBtn.disabled = false;
    }
  }

  function renderResult({ info, machines, resetHref, message }) {
    if (!Object.keys(info).length) {
      els.result.innerHTML = message ? `<div class="ta-hint">${esc(message)}</div>` : "";
      return;
    }
    const rows = Object.entries(info)
      .filter(([k]) => k !== "注册码")
      .map(([k, v]) => `<div class="ta-field"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
      .join("");
    const machineHtml = machines.length
      ? machines.map((m) => `<div class="ta-hint">${esc(m["注册日期"] || "")} · ${esc(m.IP || "")} · ${esc(m.UID || "")}${/当前/.test(m["是否当前有效注册"] || "") ? " · <b>当前注册</b>" : ""}</div>`).join("")
      : `<div class="ta-hint">没有注册过的机器</div>`;
    const resetBtn = resetHref
      ? `<button id="licResetBtn" class="btn-secondary">重置激活次数（清空注册信息）</button>`
      : `<div class="ta-warn">结果页里没有找到“清空注册信息”链接，无法重置</div>`;
    els.result.innerHTML = `
      <div class="ta-record">
        ${rows}
        <div class="ta-title">注册过的机器（${machines.length}）</div>
        ${machineHtml}
        ${resetBtn}
      </div>`;
  }

  async function runReset() {
    if (!lastQuery?.resetHref) return;
    const { email, regcode, info } = lastQuery;
    const ok = confirm(
      `确认重置激活次数？\n\n邮箱：${email}\n注册码：${regcode}\n` +
      `当前注册 PC 数：${info["注册状态pc数"] ?? "?"} / 允许 ${info["允许同时注册pc数"] ?? "?"}\n\n` +
      `这会清空该注册码的全部注册信息，无法撤销。`
    );
    if (!ok) return;

    const btn = $("licResetBtn");
    if (btn) btn.disabled = true;
    setStatus("正在重置…");
    try {
      await fetchPage(lastQuery.resetHref);
      await runQuery({ silentStatus: true });
      const after = lastQuery?.info?.["注册状态pc数"];
      setStatus(after === "0" ? "✓ 已重置，当前注册 PC 数为 0" : `已提交重置，当前注册 PC 数：${after ?? "?"}（请核对）`, after === "0" ? "ok" : "");
    } catch (err) {
      showError(err);
      if (btn) btn.disabled = false;
    }
  }

  function showError(err) {
    if (err instanceof NotLoggedInError) {
      els.status.className = "ta-status err";
      els.status.innerHTML = `技术支持系统未登录，请先 <a href="${LOGIN_URL}" target="_blank">打开登录页</a> 登录后再试`;
      return;
    }
    setStatus(`出错：${err?.message || err}`, "err");
  }

  // ─── Prefill from an order card (panel.js renders .lic-check-btn) ─────────

  async function prefillFromOrder({ email, code, product }) {
    els.card.open = true;
    els.email.value = email || els.email.value;
    els.code.value = code || "";
    els.result.innerHTML = "";
    els.card.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      setStatus("加载产品列表…");
      await loadProducts();
      const idx = guessProductIndex(product);
      renderProductOptions(idx);
      if (idx < 0) { setStatus(`没能自动匹配产品「${product || "?"}」，请手动选择后点查询`); return; }
      await runQuery();
    } catch (err) {
      showError(err);
    }
  }

  // ─── Wiring ────────────────────────────────────────────────────────────────

  els.card.addEventListener("toggle", () => {
    if (!els.card.open) return;
    if (!els.email.value) els.email.value = $("customerEmailInput")?.value || "";
    if (!products) loadProducts().then(() => setStatus("")).catch(showError);
  });

  els.queryBtn.addEventListener("click", async () => {
    try { await loadProducts(); } catch (err) { showError(err); return; }
    runQuery();
  });

  els.result.addEventListener("click", (e) => {
    if (e.target.closest("#licResetBtn")) runReset();
  });

  $("orderResultsDisplay")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".lic-check-btn");
    if (!btn) return;
    prefillFromOrder({
      email: $("customerEmailInput")?.value.trim(),
      code: btn.dataset.code,
      product: btn.dataset.product
    });
  });
})();
