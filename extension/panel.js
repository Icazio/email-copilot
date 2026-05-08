const elements = {
  backendUrl: document.getElementById("backendUrl"),
  subjectSelectors: document.getElementById("subjectSelectors"),
  threadSelectors: document.getElementById("threadSelectors"),
  messageSelectors: document.getElementById("messageSelectors"),
  captureBtn: document.getElementById("captureBtn"),
  orderSearchBtn: document.getElementById("orderSearchBtn"),
  orderSearchDebugBtn: document.getElementById("orderSearchDebugBtn"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  generateBtn: document.getElementById("generateBtn"),
  clearBtn: document.getElementById("clearBtn"),
  refineBtn: document.getElementById("refineBtn"),
  copyBtn: document.getElementById("copyBtn"),
  subject: document.getElementById("subject"),
  threadText: document.getElementById("threadText"),
  manualLookup: document.getElementById("manualLookup"),
  replyInstructions: document.getElementById("replyInstructions"),
  summary: document.getElementById("summary"),
  fields: document.getElementById("fields"),
  questions: document.getElementById("questions"),
  nextStep: document.getElementById("nextStep"),
  draftReply: document.getElementById("draftReply"),
  debugInfo: document.getElementById("debugInfo"),
  status: document.getElementById("status")
};

let lastCategory = null;
let lastSuggestedTemplateId = null;
let lastThreadStructured = null;
let orderSearchContextCache = null;
let orderSearchContextPromise = null;
const orderSearchResultCache = new Map();
let activeOperation = null;
let autoOrderSearchEnabled = true;
const ORDERSEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const ORDERSEARCH_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const BUTTON_DEFAULT_LABELS = new Map();
const DEFAULTS = {
  backendUrl: "http://localhost:8787",
  subjectSelectors: [
    ".MainBox.TicketZoom .Headline.NoMargin h1",
    ".TicketZoom .Headline h1",
    "[data-testid='mail-subject']",
    "[data-testid='ticket-subject']",
    "[data-subject]",
    ".mail-subject",
    ".ticket-subject",
    ".subject",
    "h1",
    "title"
  ].join("\n"),
  threadSelectors: [
    "#ArticleTableBody",
    "#ArticleTree",
    ".MainBox.TicketZoom",
    "[data-testid='mail-thread']",
    "[data-testid='conversation-thread']",
    "[data-testid='ticket-thread']",
    ".mail-thread",
    ".message-thread",
    ".conversation-thread",
    ".conversation",
    ".thread",
    "[role='main']",
    "main",
    "article",
    "body"
  ].join("\n"),
  messageSelectors: [
    "#ArticleTableBody tbody tr",
    "#ArticleTable tbody tr",
    "[data-testid='message-item']",
    "[data-testid='mail-message']",
    ".message-item",
    ".mail-message",
    ".thread-message",
    ".message",
    ".email-message"
  ].join("\n")
};

function setStatus(text) {
  elements.status.textContent = text;
}

function setButtonsDisabled(disabled) {
  [
    elements.captureBtn,
    elements.orderSearchBtn,
    elements.orderSearchDebugBtn,
    elements.analyzeBtn,
    elements.generateBtn,
    elements.clearBtn,
    elements.refineBtn,
    elements.copyBtn
  ].forEach((button) => {
    if (button) {
      button.disabled = disabled;
    }
  });
}

function ensureButtonLabelsCaptured() {
  if (BUTTON_DEFAULT_LABELS.size) {
    return;
  }

  [
    elements.captureBtn,
    elements.orderSearchBtn,
    elements.orderSearchDebugBtn,
    elements.analyzeBtn,
    elements.generateBtn,
    elements.clearBtn,
    elements.refineBtn,
    elements.copyBtn
  ].forEach((button) => {
    if (button) {
      BUTTON_DEFAULT_LABELS.set(button, button.textContent);
    }
  });
}

function restoreButtonLabels() {
  BUTTON_DEFAULT_LABELS.forEach((label, button) => {
    if (button) {
      button.textContent = label;
    }
  });
}

function shouldAutoSearchOrders() {
  return autoOrderSearchEnabled && Boolean(getCandidateCustomerEmail());
}

async function runWithBusyState(statusText, button, busyLabel, work) {
  if (activeOperation) {
    throw new Error(`Another action is still running: ${activeOperation}.`);
  }

  ensureButtonLabelsCaptured();
  activeOperation = statusText;
  setButtonsDisabled(true);
  if (button && busyLabel) {
    button.textContent = busyLabel;
  }
  setStatus(statusText);

  try {
    return await work();
  } finally {
    activeOperation = null;
    restoreButtonLabels();
    setButtonsDisabled(false);
  }
}

function getBackendUrl() {
  return elements.backendUrl.value.replace(/\/+$/, "");
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "backendUrl",
    "subjectSelectors",
    "threadSelectors",
    "messageSelectors"
  ]);

  elements.backendUrl.value = stored.backendUrl || DEFAULTS.backendUrl;
  elements.subjectSelectors.value = stored.subjectSelectors || DEFAULTS.subjectSelectors;
  elements.threadSelectors.value = stored.threadSelectors || DEFAULTS.threadSelectors;
  elements.messageSelectors.value = stored.messageSelectors || DEFAULTS.messageSelectors;
}

async function saveSettings() {
  await chrome.storage.local.set({
    backendUrl: elements.backendUrl.value,
    subjectSelectors: elements.subjectSelectors.value,
    threadSelectors: elements.threadSelectors.value,
    messageSelectors: elements.messageSelectors.value
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendExtractMessage(tabId, frameId) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "EMAIL_COPILOT_EXTRACT",
      subject_selectors: elements.subjectSelectors.value,
      thread_selectors: elements.threadSelectors.value,
      message_selectors: elements.messageSelectors.value
    }, frameId === undefined ? undefined : { frameId });
  } catch (error) {
    return {
      error: error?.message || String(error),
      frameId
    };
  }
}

function scoreCapture(response) {
  if (!response || response.error) {
    return -1;
  }

  const bodyLength = response.debug?.znuny_article_body_length || 0;
  const panelCount = response.debug?.znuny_visible_panel_count || 0;
  const threadLength = (response.thread_text || "").length;
  const structuredBodyLength = (response.thread_structured?.active_article_body || "").length;

  return bodyLength * 10 + structuredBodyLength * 5 + panelCount * 100 + threadLength;
}

function pickBestCapture(responses) {
  return responses
    .filter(Boolean)
    .sort((a, b) => scoreCapture(b) - scoreCapture(a))[0] || null;
}

async function captureThread() {
  return runWithBusyState("capturing", elements.captureBtn, "Capturing...", async () => {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const frameIds = frames?.map((item) => item.frameId).filter((id) => typeof id === "number") || [0];
    const responses = [];

    for (const frameId of frameIds) {
      responses.push(await sendExtractMessage(tab.id, frameId));
    }

    if (!responses.length) {
      responses.push(await sendExtractMessage(tab.id));
    }

    const response = pickBestCapture(responses);
    if (!response || response.error) {
      throw new Error(response?.error || "No content script response received.");
    }

    elements.subject.value = response.subject || "";
    elements.threadText.value = response.thread_text || "";
    lastThreadStructured = response.thread_structured || null;
    elements.debugInfo.textContent = JSON.stringify(
      {
        ...(response.debug || {}),
        selected_frame_url: response.frame_url || response.url || "",
        selected_frame_context: response.frame_context || "",
        frame_candidates: responses.map((item) => ({
          frame_url: item?.frame_url || "",
          frame_context: item?.frame_context || "",
          score: scoreCapture(item),
          error: item?.error || null,
          article_body_length: item?.debug?.znuny_article_body_length || 0,
          visible_panel_count: item?.debug?.znuny_visible_panel_count || 0,
          thread_length: (item?.thread_text || "").length
        }))
      },
      null,
      2
    );
    await saveSettings();
    setStatus("captured");

    const origin = getBaseOrigin(tab.url || "");
    if (origin) {
      prefetchOrderSearchContext(origin).catch(() => {});
    }
  });
}

async function autoSearchOrdersAfterCapture() {
  if (!shouldAutoSearchOrders()) {
    return;
  }

  if (elements.manualLookup.value.trim()) {
    return;
  }

  try {
    await runOrderSearch({ silent: true });
  } catch (_error) {
    // Ignore auto-search failures; manual search/debug remains available.
  }
}

function getBaseOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (_error) {
    return "";
  }
}

function extractFirstEmail(text) {
  const match = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function extractLabeledCustomerEmail(text) {
  const match = String(text || "").match(
    /\bcustomer\s*email(?:\s*address)?\s*[:：]\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i
  );
  return match ? match[1] : "";
}

function getCandidateCustomerEmail() {
  const labeledFromThread = extractLabeledCustomerEmail(elements.threadText.value);
  if (labeledFromThread) {
    return labeledFromThread;
  }

  const labeledFromBodies = lastThreadStructured?.articles
    ?.map((item) => extractLabeledCustomerEmail(item?.body || ""))
    .find(Boolean);
  if (labeledFromBodies) {
    return labeledFromBodies;
  }

  const structuredCandidate = extractFirstEmail(lastThreadStructured?.customer_email || "");
  if (structuredCandidate) {
    return structuredCandidate;
  }

  const candidateList = Array.isArray(lastThreadStructured?.customer_email_candidates)
    ? lastThreadStructured.customer_email_candidates
    : [];
  const pageCandidate = candidateList
    .map((item) => extractFirstEmail(item))
    .find(Boolean);
  if (pageCandidate) {
    return pageCandidate;
  }

  const articleSenderEmail = lastThreadStructured?.articles
    ?.map((item) => extractFirstEmail(item?.sender || ""))
    .find(Boolean);

  if (articleSenderEmail) {
    return articleSenderEmail;
  }

  const articleBodyEmail = lastThreadStructured?.articles
    ?.map((item) => extractFirstEmail(item?.body || ""))
    .find(Boolean);
  if (articleBodyEmail) {
    return articleBodyEmail;
  }

  return extractFirstEmail(elements.threadText.value);
}

function parseOrderSearchForms(doc) {
  return Array.from(doc.querySelectorAll("form")).map((form) => ({
    action: form.getAttribute("action") || "",
    method: (form.getAttribute("method") || "get").toLowerCase(),
    field_names: Array.from(form.querySelectorAll("input, select, textarea"))
      .map((node) => node.getAttribute("name") || node.getAttribute("id") || "")
      .filter(Boolean)
      .slice(0, 40)
  }));
}

function getHeadings(doc) {
  return Array.from(doc.querySelectorAll("h1, h2, title"))
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function buildAbsoluteUrl(origin, action) {
  try {
    return new URL(action || "/otrs/index.pl", `${origin}/`).toString();
  } catch (_error) {
    return `${origin}/otrs/index.pl`;
  }
}

function isValidOrderSearchCache(origin) {
  return Boolean(
    orderSearchContextCache &&
    orderSearchContextCache.origin === origin &&
    orderSearchContextCache.payloadBase?.ChallengeToken &&
    Date.now() - orderSearchContextCache.fetchedAt < ORDERSEARCH_CACHE_TTL_MS
  );
}

function buildOrderSearchResultCacheKey(origin, customerEmail) {
  return `${origin}::${String(customerEmail || "").toLowerCase()}`;
}

function getCachedOrderSearchResult(origin, customerEmail) {
  const key = buildOrderSearchResultCacheKey(origin, customerEmail);
  const cached = orderSearchResultCache.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.cachedAt > ORDERSEARCH_RESULT_CACHE_TTL_MS) {
    orderSearchResultCache.delete(key);
    return null;
  }

  return cached;
}

function setCachedOrderSearchResult(origin, customerEmail, value) {
  orderSearchResultCache.set(buildOrderSearchResultCacheKey(origin, customerEmail), {
    ...value,
    cachedAt: Date.now()
  });
}

function pickOrderSearchForm(doc) {
  return Array.from(doc.querySelectorAll("form")).find((form) => {
    const fieldNames = Array.from(form.querySelectorAll("input, select, textarea"))
      .map((node) => node.getAttribute("name") || "")
      .filter(Boolean);

    return fieldNames.includes("Email") && fieldNames.includes("ChallengeToken");
  }) || null;
}

async function fetchOrderSearchContext(origin, options = {}) {
  const { forceRefresh = false } = options;
  if (!forceRefresh && isValidOrderSearchCache(origin)) {
    return orderSearchContextCache;
  }

  if (!forceRefresh && orderSearchContextPromise) {
    return orderSearchContextPromise;
  }

  orderSearchContextPromise = (async () => {
    const requestStartedAt = performance.now();
    const targetUrl = `${origin}/otrs/index.pl?Action=AgentOrderSearch`;
    const response = await fetch(targetUrl, {
      credentials: "include"
    });

    const html = await response.text();
    const responseLoadedAt = performance.now();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const forms = parseOrderSearchForms(doc);
    const headings = getHeadings(doc);
    const orderSearchForm = pickOrderSearchForm(doc);

    if (!orderSearchForm) {
      throw new Error("Order search form not found.");
    }

    const payloadBase = collectFieldMap(orderSearchForm);
    payloadBase.Action = payloadBase.Action || "AgentOrderSearch";
    payloadBase.Subaction = payloadBase.Subaction || "Search";

    orderSearchContextCache = {
      origin,
      fetchedAt: Date.now(),
      targetUrl,
      submitUrl: buildAbsoluteUrl(origin, orderSearchForm.getAttribute("action")),
      payloadBase,
      responseStatus: response.status,
      responseTitle: doc.title || "",
      headings,
      formCount: forms.length,
      forms,
      timings: {
        request_ms: Math.round(responseLoadedAt - requestStartedAt),
        parse_ms: Math.round(performance.now() - responseLoadedAt)
      }
    };

    return orderSearchContextCache;
  })();

  try {
    return await orderSearchContextPromise;
  } finally {
    orderSearchContextPromise = null;
  }
}

async function prefetchOrderSearchContext(origin) {
  try {
    await fetchOrderSearchContext(origin);
  } catch (_error) {
    // Best-effort warm cache only.
  }
}

function collectFieldMap(root) {
  const map = {};
  Array.from(root.querySelectorAll("input, select, textarea")).forEach((node) => {
    const name = node.getAttribute("name");
    if (!name || map[name] !== undefined) {
      return;
    }

    if (node.tagName === "SELECT") {
      map[name] = node.value || "";
      return;
    }

    const type = (node.getAttribute("type") || "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (node.checked) {
        map[name] = node.value || "1";
      }
      return;
    }

    map[name] = node.value || "";
  });
  return map;
}

function textFromCell(cell) {
  return (cell?.textContent || "").replace(/\s+/g, " ").trim();
}

function parseOrderRows(doc) {
  const tables = Array.from(doc.querySelectorAll("table"));
  const results = [];

  for (const table of tables) {
    const headers = Array.from(table.querySelectorAll("thead th, tr th"))
      .map((cell) => textFromCell(cell))
      .filter(Boolean);

    const normalizedHeaders = headers.map((header) => header.toLowerCase());
    const looksLikeOrderTable = normalizedHeaders.some((header) =>
      /(email|order|product|license|status|date|invoice|payment)/.test(header)
    );

    if (!looksLikeOrderTable) {
      continue;
    }

    const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter((row) => row.querySelectorAll("td").length);
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td")).map((cell) => textFromCell(cell));
      if (!cells.some(Boolean)) {
        continue;
      }

      const record = {};
      if (headers.length && headers.length === cells.length) {
        headers.forEach((header, index) => {
          record[header] = cells[index] || "";
        });
      } else {
        cells.forEach((value, index) => {
          record[`col_${index + 1}`] = value;
        });
      }

      results.push(record);
    }

    if (results.length) {
      break;
    }
  }

  return results;
}

function summarizeTables(doc) {
  return Array.from(doc.querySelectorAll("table"))
    .slice(0, 10)
    .map((table, index) => {
      const headers = Array.from(table.querySelectorAll("thead th, tr th"))
        .map((cell) => textFromCell(cell))
        .filter(Boolean)
        .slice(0, 12);
      const sampleRows = Array.from(table.querySelectorAll("tbody tr, tr"))
        .filter((row) => row.querySelectorAll("td").length)
        .slice(0, 3)
        .map((row) => Array.from(row.querySelectorAll("td")).map((cell) => textFromCell(cell)).filter(Boolean));

      return {
        table_index: index,
        class_name: table.className || "",
        id: table.id || "",
        headers,
        row_count: Array.from(table.querySelectorAll("tbody tr, tr")).filter((row) => row.querySelectorAll("td").length).length,
        sample_rows: sampleRows
      };
    });
}

function summarizeDetailsBlocks(doc) {
  const blocks = [];
  const detailHeading = Array.from(doc.querySelectorAll("h1, h2, h3, legend, strong, b"))
    .find((node) => /details of order/i.test(node.textContent || ""));

  if (detailHeading) {
    let cursor = detailHeading.parentElement;
    let hops = 0;
    while (cursor && hops < 4) {
      const text = (cursor.textContent || "").replace(/\s+/g, " ").trim();
      if (text) {
        blocks.push({
          source: cursor.tagName.toLowerCase(),
          class_name: cursor.className || "",
          id: cursor.id || "",
          text_preview: text.slice(0, 1200),
          text_full: text.slice(0, 12000)
        });
      }
      cursor = cursor.parentElement;
      hops += 1;
    }
  }

  return blocks.slice(0, 4);
}

function getPrimaryDetailText(doc) {
  const detailHeading = Array.from(doc.querySelectorAll("h1, h2, h3, legend, strong, b"))
    .find((node) => /details of order/i.test(node.textContent || ""));

  if (!detailHeading) {
    return "";
  }

  let bestText = "";
  let cursor = detailHeading.parentElement;
  let hops = 0;
  while (cursor && hops < 4) {
    const text = (cursor.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > bestText.length) {
      bestText = text;
    }
    cursor = cursor.parentElement;
    hops += 1;
  }

  return bestText.slice(0, 12000);
}

function parseDefinitionPairs(doc) {
  const pairs = [];

  Array.from(doc.querySelectorAll("dl")).forEach((dl) => {
    const dts = Array.from(dl.querySelectorAll("dt"));
    const dds = Array.from(dl.querySelectorAll("dd"));
    dts.forEach((dt, index) => {
      const key = textFromCell(dt);
      const value = textFromCell(dds[index]);
      if (key && value) {
        pairs.push({ key, value });
      }
    });
  });

  Array.from(doc.querySelectorAll("table")).forEach((table) => {
    Array.from(table.querySelectorAll("tr")).forEach((row) => {
      const cells = Array.from(row.querySelectorAll("th, td"));
      if (cells.length === 2) {
        const key = textFromCell(cells[0]);
        const value = textFromCell(cells[1]);
        if (key && value && key.length < 80) {
          pairs.push({ key, value });
        }
      }
    });
  });

  return pairs.slice(0, 40);
}

function normalizeOrderRows(orderRows, definitionPairs) {
  if (orderRows.length) {
    return orderRows;
  }

  if (!definitionPairs.length) {
    return [];
  }

  const record = {};
  definitionPairs.forEach(({ key, value }) => {
    record[key] = value;
  });

  return Object.keys(record).length ? [record] : [];
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeMatchValue(match, index) {
  return String(match?.[index] || "").trim();
}

function buildRawOrderEntry(row) {
  const leading = row.Customer ? `${row.Customer} <${row.Email}>` : `<${row.Email}>`;
  return `${leading} ${row.Country} [${row.Product}]\n${row["Purchase Date"]} - ${row.Provider} - ${row["Order ID"]} - ${row["License Key"]} - ${row.Amount} - ${row.Status}`.trim();
}

function parseOrderRowsFromDetailBlocks(detailBlocks, customerEmail) {
  const emailPattern = escapeRegExp(customerEmail);
  const entryRegex = new RegExp(
    `(?:([^<\\n]+?)\\s*)?<${emailPattern}>\\s+([A-Z]{2})\\s+\\[([^\\]]+)\\]\\s+([\\s\\S]*?)(?=(?:(?:[^<\\n]+?)\\s*)?<${emailPattern}>\\s+[A-Z]{2}\\s+\\[|$)`,
    "gi"
  );

  for (const block of detailBlocks) {
    const text = String(block?.text_full || block?.text_preview || "")
      .replace(/\s+/g, " ")
      .replace(/^.*?Details of Order\s*/i, "")
      .trim();

    const matches = Array.from(text.matchAll(entryRegex));
    if (!matches.length) {
      continue;
    }

    return matches.map((match) => {
      const customer = safeMatchValue(match, 1);
      const country = safeMatchValue(match, 2);
      const product = safeMatchValue(match, 3);
      const tail = safeMatchValue(match, 4).replace(/\s+/g, " ").trim();
      const parts = tail.split(/\s+-\s+/).map((item) => item.trim()).filter(Boolean);

      const row = {
        Customer: customer,
        Email: customerEmail,
        Country: country,
        Product: product,
        "Purchase Date": parts[0] || "",
        Provider: parts[1] || "",
        "Order ID": parts[2] || "",
        "License Key": parts[3] || "",
        Amount: parts[4] || "",
        Status: parts.slice(5).join(" - ") || parts[5] || ""
      };

      row["Raw Entry"] = buildRawOrderEntry(row);
      return row;
    }).filter((row) => row.Product || row["Order ID"] || row["License Key"] || row.Amount);
  }

  return [];
}

function formatOrderLookupResult(customerEmail, rows) {
  if (!rows.length) {
    return `Customer email: ${customerEmail}\nOrder search: no results found`;
  }

  const lines = [
    `Customer email: ${customerEmail}`,
    `Order search results: ${rows.length}`
  ];

  rows.slice(0, 10).forEach((row, index) => {
    lines.push("");
    lines.push(`Result ${index + 1}:`);
    Object.entries(row).forEach(([key, value]) => {
      if (value) {
        if (key === "Raw Entry") {
          lines.push(`${key}:`);
          lines.push(String(value));
        } else {
          lines.push(`${key}: ${value}`);
        }
      }
    });
  });

  if (rows.length > 10) {
    lines.push("");
    lines.push(`Additional results omitted: ${rows.length - 10}`);
  }

  return lines.join("\n");
}

async function runOrderSearch(options = {}) {
  const { includeDebug = false, silent = false } = options;
  return runWithBusyState(
    includeDebug ? "ordersearch-debug" : "ordersearch",
    includeDebug ? elements.orderSearchDebugBtn : elements.orderSearchBtn,
    includeDebug ? "Debugging..." : "Searching...",
    async () => {
    const tab = await getActiveTab();
    if (!tab?.id || !tab.url) {
      throw new Error("No active tab found.");
    }

    const origin = getBaseOrigin(tab.url);
    if (!origin) {
      throw new Error("Unable to determine current origin.");
    }

    const customerEmail = getCandidateCustomerEmail();
    if (!customerEmail) {
      throw new Error("No customer email found in the current thread.");
    }
    const totalStartedAt = performance.now();

    const cachedResult = getCachedOrderSearchResult(origin, customerEmail);
    if (cachedResult && !includeDebug) {
      elements.manualLookup.value = cachedResult.manualLookup;
      if (!silent) {
        elements.debugInfo.textContent = JSON.stringify(
          {
            ordersearch: true,
            cache_hit: true,
            result_cache_hit: true,
            cached_at: new Date(cachedResult.cachedAt).toISOString(),
            timings: {
              total_ms: 0,
              cache_return_ms: Math.round(performance.now() - totalStartedAt)
            },
            candidate_customer_email: customerEmail,
            search_title: cachedResult.searchTitle || "",
            result_count: cachedResult.resultCount || 0
          },
          null,
          2
        );
      }
      setStatus("ordersearch-ready");
      return;
    }

    const usedCachedContext = isValidOrderSearchCache(origin);
    let context = await fetchOrderSearchContext(origin);
    const parser = new DOMParser();
    const payload = { ...context.payloadBase };
    payload.Email = customerEmail;
    const postStartedAt = performance.now();
    let submitResponse = await fetch(context.submitUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(payload).toString()
    });

    let resultHtml = await submitResponse.text();
    const postLoadedAt = performance.now();
    let resultDoc = parser.parseFromString(resultHtml, "text/html");

    if (/login\s*-\s*znuny/i.test(resultDoc.title || "")) {
      context = await fetchOrderSearchContext(origin, { forceRefresh: true });
      const retryPayload = { ...context.payloadBase, Email: customerEmail };
      submitResponse = await fetch(context.submitUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(retryPayload).toString()
      });
      resultHtml = await submitResponse.text();
      resultDoc = parser.parseFromString(resultHtml, "text/html");
    }

    const parseStartedAt = performance.now();
    const detailText = getPrimaryDetailText(resultDoc);
    const textBlockRows = parseOrderRowsFromDetailBlocks(
      detailText ? [{ text_full: detailText }] : [],
      customerEmail
    );
    let orderRows = textBlockRows;

    if (!orderRows.length) {
      const rawOrderRows = parseOrderRows(resultDoc);
      const definitionPairs = parseDefinitionPairs(resultDoc);
      orderRows = rawOrderRows.length
        ? rawOrderRows
        : normalizeOrderRows(rawOrderRows, definitionPairs);
    }
    const parseFinishedAt = performance.now();

    elements.manualLookup.value = formatOrderLookupResult(customerEmail, orderRows);
    setCachedOrderSearchResult(origin, customerEmail, {
      manualLookup: elements.manualLookup.value,
      searchTitle: resultDoc.title || "",
      resultCount: orderRows.length
    });

    if (includeDebug) {
      const rawOrderRows = parseOrderRows(resultDoc);
      const resultHeadings = getHeadings(resultDoc);
      const resultForms = parseOrderSearchForms(resultDoc);
      const resultTables = summarizeTables(resultDoc);
      const detailBlocks = summarizeDetailsBlocks(resultDoc);
      const definitionPairs = parseDefinitionPairs(resultDoc);

      elements.debugInfo.textContent = JSON.stringify(
        {
          ordersearch_debug: true,
          cache_hit: usedCachedContext,
          request_url: context.targetUrl,
          submit_url: context.submitUrl,
          cached_at: new Date(context.fetchedAt).toISOString(),
          timings: {
            form_request_ms: context.timings?.request_ms || 0,
            form_parse_ms: context.timings?.parse_ms || 0,
            post_request_ms: Math.round(postLoadedAt - postStartedAt),
            result_parse_ms: Math.round(parseFinishedAt - parseStartedAt),
            total_ms: Math.round(performance.now() - totalStartedAt)
          },
          response_status: context.responseStatus,
          response_title: context.responseTitle,
          search_status: submitResponse.status,
          search_title: resultDoc.title || "",
          candidate_customer_email: customerEmail,
          headings: context.headings,
          result_headings: resultHeadings,
          form_count: context.formCount,
          forms: context.forms,
          submit_payload_keys: Object.keys(payload),
          result_form_count: resultForms.length,
          detail_text_length: detailText.length,
          result_tables: resultTables,
          detail_blocks: detailBlocks,
          definition_pairs_preview: definitionPairs.slice(0, 15),
          raw_result_count: rawOrderRows.length,
          text_block_result_count: textBlockRows.length,
          result_count: orderRows.length,
          result_preview: orderRows.slice(0, 5)
        },
        null,
        2
      );
    } else if (!silent) {
      elements.debugInfo.textContent = JSON.stringify(
        {
          ordersearch: true,
          cache_hit: usedCachedContext,
          result_cache_hit: false,
          cached_at: new Date(context.fetchedAt).toISOString(),
          timings: {
            form_request_ms: context.timings?.request_ms || 0,
            form_parse_ms: context.timings?.parse_ms || 0,
            post_request_ms: Math.round(postLoadedAt - postStartedAt),
            result_parse_ms: Math.round(parseFinishedAt - parseStartedAt),
            total_ms: Math.round(performance.now() - totalStartedAt)
          },
          candidate_customer_email: customerEmail,
          search_title: resultDoc.title || "",
          result_count: orderRows.length
        },
        null,
        2
      );
    }

    setStatus(includeDebug ? "ordersearch-debug-ready" : "ordersearch-ready");
    }
  );
}

async function postJson(path, payload) {
  const url = `${getBackendUrl()}${path}`;
  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Cannot reach backend at ${getBackendUrl()}. Start run-backend.cmd and confirm /health is reachable.`
      );
    }
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }

  return response.json();
}

function renderAnalysis(data) {
  lastCategory = data.category || null;
  lastSuggestedTemplateId = data.suggested_template_id || data.template_id || null;
  elements.summary.textContent = data.summary || "";
  elements.fields.textContent = JSON.stringify(data.extracted_fields || {}, null, 2);
  elements.questions.textContent = (data.clarification_questions || []).map((item) => `- ${item}`).join("\n");
  elements.nextStep.textContent = data.next_step || "";
}

function renderDraft(data) {
  renderAnalysis(data);
  elements.draftReply.value = data.draft_reply || "";
}

async function analyzeThread() {
  return runWithBusyState("analyzing", elements.analyzeBtn, "Analyzing...", async () => {
    const data = await postJson("/analyze-thread", {
      subject: elements.subject.value,
      thread_text: elements.threadText.value,
      thread_structured: lastThreadStructured,
      language: "en"
    });
    renderAnalysis(data);
    setStatus("analyzed");
  });
}

async function generateDraft() {
  return runWithBusyState("drafting", elements.generateBtn, "Generating...", async () => {
    const data = await postJson("/generate-draft", {
      category: lastCategory,
      subject: elements.subject.value,
      thread_text: elements.threadText.value,
      thread_structured: lastThreadStructured,
      manual_notes: elements.replyInstructions.value,
      template_ids: lastSuggestedTemplateId ? [lastSuggestedTemplateId] : []
    });
    renderDraft(data);
    setStatus("draft-ready");
  });
}

async function refineDraft() {
  return runWithBusyState("refining", elements.refineBtn, "Refining...", async () => {
    const data = await postJson("/refine-draft", {
      category: lastCategory,
      thread_text: elements.threadText.value,
      thread_structured: lastThreadStructured,
      manual_lookup_result: elements.manualLookup.value,
      previous_draft: elements.draftReply.value,
      manual_notes: elements.replyInstructions.value,
      template_ids: lastSuggestedTemplateId ? [lastSuggestedTemplateId] : []
    });
    renderDraft(data);
    setStatus("refined");
  });
}

async function copyDraft() {
  return runWithBusyState("copying", elements.copyBtn, "Copying...", async () => {
    await navigator.clipboard.writeText(elements.draftReply.value);
    setStatus("copied");
  });
}

function clearPanel() {
  lastCategory = null;
  lastSuggestedTemplateId = null;
  lastThreadStructured = null;
  orderSearchContextCache = null;
  orderSearchContextPromise = null;
  orderSearchResultCache.clear();

  elements.subject.value = "";
  elements.threadText.value = "";
  elements.manualLookup.value = "";
  elements.replyInstructions.value = "";
  elements.summary.textContent = "";
  elements.fields.textContent = "";
  elements.questions.textContent = "";
  elements.nextStep.textContent = "";
  elements.draftReply.value = "";
  elements.debugInfo.textContent = "";
  setStatus("cleared");
}

function handleError(error) {
  console.error(error);
  setStatus("error");
  elements.nextStep.textContent = error.message || String(error);
}

loadSettings().catch(handleError);
elements.captureBtn.addEventListener("click", () => {
  captureThread()
    .then(() => autoSearchOrdersAfterCapture())
    .catch(handleError);
});
elements.orderSearchBtn.addEventListener("click", () => runOrderSearch().catch(handleError));
elements.orderSearchDebugBtn.addEventListener("click", () => runOrderSearch({ includeDebug: true }).catch(handleError));
elements.analyzeBtn.addEventListener("click", () => analyzeThread().catch(handleError));
elements.generateBtn.addEventListener("click", () => generateDraft().catch(handleError));
elements.clearBtn.addEventListener("click", clearPanel);
elements.refineBtn.addEventListener("click", () => refineDraft().catch(handleError));
elements.copyBtn.addEventListener("click", () => copyDraft().catch(handleError));
