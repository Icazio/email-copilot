const elements = {
  backendUrl: document.getElementById("backendUrl"),
  subjectSelectors: document.getElementById("subjectSelectors"),
  threadSelectors: document.getElementById("threadSelectors"),
  messageSelectors: document.getElementById("messageSelectors"),
  captureBtn: document.getElementById("captureBtn"),
  customerEmailInput: document.getElementById("customerEmailInput"),
  orderSearchBtn: document.getElementById("orderSearchBtn"),
  orderSearchDebugBtn: document.getElementById("orderSearchDebugBtn"),
  clearBtn: document.getElementById("clearBtn"),
  subject: document.getElementById("subject"),
  threadText: document.getElementById("threadText"),
  manualLookup: document.getElementById("manualLookup"),
  orderResultsDisplay: document.getElementById("orderResultsDisplay"),
  lookupToggleBtn: document.getElementById("lookupToggleBtn"),
  chatMessages: document.getElementById("chatMessages"),
  chatInput: document.getElementById("chatInput"),
  chatSendBtn: document.getElementById("chatSendBtn"),
  chatQuickActions: document.getElementById("chatQuickActions"),
  chatClearBtn: document.getElementById("chatClearBtn"),
  copyTicketBtn: document.getElementById("copyTicketBtn"),
  copyEmailBtn: document.getElementById("copyEmailBtn"),
  debugInfo: document.getElementById("debugInfo"),
  status: document.getElementById("status")
};

let lastThreadStructured = null;
let orderSearchContextPromise = null;
let activeOperation = null;
let autoOrderSearchEnabled = true;
const chatHistory = [];
let currentTicketId = '';
let currentTicketUrl = '';
let currentQueue = '';
let manualProduct = false;
let productCatalog = [];
const productSelect = document.getElementById('productSelect');
const productReason = document.getElementById('productReason');

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

function setCaptureBusy(disabled) {
  [elements.captureBtn, elements.orderSearchBtn, elements.orderSearchDebugBtn, elements.clearBtn]
    .forEach((btn) => { if (btn) btn.disabled = disabled; });
}

function shouldAutoSearchOrders() {
  return autoOrderSearchEnabled && Boolean(getCandidateCustomerEmail());
}

async function runWithBusyState(statusText, button, busyLabel, work) {
  if (activeOperation) {
    throw new Error(`Another action is still running: ${activeOperation}.`);
  }

  const origLabel = button?.textContent;
  activeOperation = statusText;
  setCaptureBusy(true);
  if (button && busyLabel) button.textContent = busyLabel;
  setStatus(statusText);

  try {
    return await work();
  } finally {
    activeOperation = null;
    if (button && origLabel) button.textContent = origLabel;
    setCaptureBusy(false);
  }
}

function getBackendUrl() {
  return elements.backendUrl.value.replace(/\/+$/, "");
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "backendUrl",
    "copilotToken",
    "subjectSelectors",
    "threadSelectors",
    "messageSelectors"
  ]);

  elements.backendUrl.value = stored.backendUrl || DEFAULTS.backendUrl;
  document.getElementById('copilotToken').value = stored.copilotToken || '';
  elements.subjectSelectors.value = stored.subjectSelectors || DEFAULTS.subjectSelectors;
  elements.threadSelectors.value = stored.threadSelectors || DEFAULTS.threadSelectors;
  elements.messageSelectors.value = stored.messageSelectors || DEFAULTS.messageSelectors;
}

async function saveSettings() {
  await chrome.storage.local.set({
    backendUrl: elements.backendUrl.value,
    copilotToken: document.getElementById('copilotToken').value,
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
    const ticketIdentity = resolveCapturedTicket(response, responses, tab);
    const nextTicketId = ticketIdentity.id;
    if (nextTicketId !== currentTicketId || !nextTicketId) {
      manualProduct = false;
      productSelect.value = '';
      chatHistory.length = 0;
      elements.chatMessages.innerHTML = '';
      elements.chatQuickActions.style.display = '';
      elements.manualLookup.value = '';
      elements.orderResultsDisplay.innerHTML = '';
      elements.orderResultsDisplay.style.display = 'none';
      elements.manualLookup.style.display = '';
      elements.customerEmailInput.value = '';
    }
    currentTicketId = nextTicketId;
    currentTicketUrl = ticketIdentity.url;
    currentQueue = response.queue || responses.find(item => item?.queue)?.queue || '';
    lastThreadStructured = response.thread_structured || null;
    elements.debugInfo.textContent = JSON.stringify(
      {
        ...(response.debug || {}),
        ticket_id: currentTicketId,
        ticket_source_url: currentTicketUrl,
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

    const detectedEmail = getCandidateCustomerEmail();
    if (detectedEmail) {
      elements.customerEmailInput.value = detectedEmail;
    }
  });
}

function resolveCapturedTicket(response, responses, tab) {
  const urls = [tab.url, response.source_url, response.url, response.frame_url, ...responses.flatMap(item => [item?.source_url, item?.url, item?.frame_url])].filter(Boolean);
  const urlIdentity = value => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      const match = url.search.match(/(?:[?;&])TicketID=([^;#&]+)/i);
      const number = match && decodeURIComponent(match[1]);
      return number && /^\d{1,32}$/.test(number) ? { id: url.host + ':' + number, url: value } : null;
    } catch { return null; }
  };
  // Prefer the top-level ticket URL over whichever article iframe has the most text.
  for (const value of urls) { const match = urlIdentity(value); if (match) return match; }
  const explicit = response.ticket_id || response.thread_structured?.ticket_id || responses.find(item => item?.ticket_id)?.ticket_id;
  if (explicit) return { id: explicit, url: urls[0] || '' };
  const subjects = [response.subject, response.thread_structured?.ticket_subject, ...responses.map(item => item?.subject)];
  for (const value of subjects) {
    const match = String(value || '').match(/^\s*(?:\[\s*)?(?:Ticket\s*#\s*|工单(?:号)?\s*[:：#]\s*)(\d{5,32})(?!\d)/i);
    if (match) return { id: 'ticket-number:' + match[1], url: urls[0] || '' };
  }
  return { id: '', url: urls[0] || '' };
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
    // Ignore auto-search failures.
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

function pickOrderSearchForm(doc) {
  return Array.from(doc.querySelectorAll("form")).find((form) => {
    const fieldNames = Array.from(form.querySelectorAll("input, select, textarea"))
      .map((node) => node.getAttribute("name") || "")
      .filter(Boolean);

    return fieldNames.includes("Email") && fieldNames.includes("ChallengeToken");
  }) || null;
}

async function fetchOrderSearchContext(origin) {
  if (orderSearchContextPromise) {
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

    return {
      origin,
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
  })();

  try {
    return await orderSearchContextPromise;
  } finally {
    orderSearchContextPromise = null;
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

function extractTextWithLineBreaks(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  clone.querySelectorAll("p, div, li, td, tr, h1, h2, h3, h4, h5, h6").forEach((el) => {
    if (!el.textContent.endsWith("\n")) el.append("\n");
  });
  return clone.textContent.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
    const text = extractTextWithLineBreaks(cursor);
    if (text.length > bestText.length) {
      bestText = text;
    }
    cursor = cursor.parentElement;
    hops += 1;
  }

  const afterHeading = bestText
    .replace(/^[\s\S]*?Details of Order\s*/i, "")
    .trimStart()
    .replace(/\n{2,}/g, "\n")
    .replace(/(^\s*\d{4}-\d{2}-\d{2}\s.+$)/gm, "$1\n\n")
    .trimEnd();
  return afterHeading.slice(0, 12000);
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

function buildRawOrderEntry(row) {
  const leading = row.Customer ? `${row.Customer} <${row.Email}>` : `<${row.Email}>`;
  return `${leading} ${row.Country} [${row.Product}]\n${row["Purchase Date"]} - ${row.Provider} - ${row["Order ID"]} - ${row["License Key"]} - ${row.Amount} - ${row.Status}`.trim();
}

function parseOrderRowsFromDetailBlocks(detailBlocks, customerEmail) {
  const emailPattern = escapeRegExp(customerEmail);
  const headerRegex = new RegExp(
    `^(?:(.+?)\\s+)?<${emailPattern}>\\s+([A-Z]{2})\\s+\\[([^\\]]+)\\]\\s*$`,
    "i"
  );

  for (const block of detailBlocks) {
    const lines = String(block?.text_full || block?.text_preview || "")
      .replace(/[ \t]+/g, " ")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const headerMatch = lines[i].match(headerRegex);
      if (!headerMatch) continue;

      const customer = (headerMatch[1] || "").trim();
      const country = headerMatch[2];
      const product = headerMatch[3];
      const dataLine = lines[i + 1] || "";
      const parts = dataLine.split(/\s+-\s+/).map((p) => p.trim());

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
        Status: parts[5] || ""
      };

      if (row.Product || row["Order ID"] || row.Amount) {
        row["Raw Entry"] = buildRawOrderEntry(row);
        results.push(row);
        i++;
      }
    }

    if (results.length) return results;
  }

  return [];
}

function renderOrderResults(rows, customerEmail) {
  const display = elements.orderResultsDisplay;
  const textarea = elements.manualLookup;
  const toggle = elements.lookupToggleBtn;
  if (!display) return;

  if (!rows.length) {
    display.innerHTML = `<div class="order-empty">未找到订单记录</div>`;
  } else {
    const customerName = rows.find((r) => r.Customer)?.Customer || "";
    const headerText = customerName
      ? `${customerName} · ${customerEmail} · ${rows.length} 条订单`
      : `${customerEmail} · ${rows.length} 条订单`;

    const cards = rows.slice(0, 10).map((row) => {
      const status = row.Status || "";
      const statusClass = /PAID/i.test(status) ? "status-paid"
        : /CANCEL/i.test(status) ? "status-cancelled"
        : /REFUND/i.test(status) ? "status-other"
        : "status-other";
      const cardClass = /PAID/i.test(status) ? "card-paid"
        : /CANCEL/i.test(status) ? "card-cancel"
        : /REFUND/i.test(status) ? "card-refund"
        : "";
      const date = (row["Purchase Date"] || "").slice(0, 10);
      const meta = [date, row.Provider, row.Amount, row["Order ID"]]
        .filter(Boolean).join(" · ");

      const licenseField = row["License Key"] ? `
        <div class="order-field">
          <span class="order-field-label">License</span>
          <span class="order-field-value" title="${row["License Key"]}">${row["License Key"]}</span>
          <button class="copy-chip" data-copy="${row["License Key"]}">Copy</button>
        </div>` : "";

      return `
        <div class="order-card ${cardClass}">
          <div class="order-card-top">
            <div class="order-product">${row.Product || "?"}</div>
            <span class="status-badge ${statusClass}">${status || "?"}</span>
          </div>
          ${meta ? `<div class="order-meta">${meta}</div>` : ""}
          ${licenseField}
        </div>`;
    });

    const collapseBtn = cards.length > 1
      ? `<button class="order-collapse-btn">收起</button>`
      : "";
    const extraHtml = cards.length > 1
      ? `<div class="order-extra-cards">${cards.slice(1).join("")}</div>`
      : "";

    display.innerHTML = `<div class="order-customer-line"><span>${headerText}</span>${collapseBtn}</div>${cards[0]}${extraHtml}`;
  }

  display.style.display = "";
  textarea.style.display = "none";
  if (toggle) {
    toggle.style.display = "";
    toggle.textContent = "原始数据";
  }
}

function formatOrderLookupResult(customerEmail, rows) {
  if (!rows.length) {
    return `Customer email: ${customerEmail}\nOrder search: no results found`;
  }

  const customerName = rows.find((r) => r.Customer)?.Customer || "";
  const header = customerName ? `${customerName} <${customerEmail}>` : customerEmail;
  const lines = [`Customer: ${header}`, `Orders: ${rows.length}`, ""];

  rows.slice(0, 10).forEach((row, index) => {
    const date = (row["Purchase Date"] || "").slice(0, 10);
    const statusPart = [date, row.Provider, row.Amount, row.Status].filter(Boolean).join("  ");
    lines.push(`[${index + 1}] ${row.Product || "?"}`);
    if (statusPart) lines.push(`    ${statusPart}`);
    if (row["Order ID"]) lines.push(`    Order: ${row["Order ID"]}`);
    if (row["License Key"]) lines.push(`    License: ${row["License Key"]}`);
    if (row["Raw Entry"]) lines.push(`    ---\n    ${row["Raw Entry"].replace(/\n/g, "\n    ")}`);
    lines.push("");
  });

  if (rows.length > 10) {
    lines.push(`(${rows.length - 10} more results omitted)`);
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

      const customerEmail = elements.customerEmailInput.value.trim() || getCandidateCustomerEmail();
      if (!customerEmail) {
        throw new Error("No customer email found. Please enter the customer email manually.");
      }
      const totalStartedAt = performance.now();

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
        context = await fetchOrderSearchContext(origin);
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

      elements.manualLookup.value = detailText || formatOrderLookupResult(customerEmail, orderRows);
      renderOrderResults(orderRows, customerEmail);

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
            request_url: context.targetUrl,
            submit_url: context.submitUrl,
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
      credentials: "omit",
      headers: { "Content-Type": "application/json", ...copilotHeaders() },
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

function copilotHeaders() {
  const token = document.getElementById('copilotToken').value.trim();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

async function loadProductCatalog() {
  const response = await fetch(getBackendUrl() + '/api/copilot/products', { credentials: 'omit', headers: copilotHeaders() });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取产品列表');
  productCatalog = data;
  const selected = productSelect.value;
  productSelect.replaceChildren(new Option('自动识别 / 请选择', ''));
  productCatalog.forEach(p => productSelect.add(new Option(p.name, p.id)));
  if (productCatalog.some(p => p.id === selected)) productSelect.value = selected;
  productReason.textContent = productCatalog.length ? '根据工单队列、邮件和订单识别，可手动纠正。' : '请先在管理后台创建产品并发布内容。';
}

function clearProductConversation() {
  chatHistory.length = 0;
  elements.chatMessages.innerHTML = '';
  elements.chatQuickActions.style.display = '';
}

async function resolveCurrentProduct() {
  if (manualProduct) return;
  const result = await postJson('/api/copilot/resolve-product', {
    subject: elements.subject.value, thread_text: elements.threadText.value,
    order_context: elements.manualLookup.value, queue: currentQueue
  });
  const next = result.product?.id || '';
  if (next && !productCatalog.some(p => p.id === next)) await loadProductCatalog();
  if (productSelect.value !== next) clearProductConversation();
  productSelect.value = next;
  productReason.textContent = result.reason;
}

function appendFeedback(container, result) {
  const form = document.createElement('form'); form.className = 'assistant-feedback';
  const title = document.createElement('small');
  title.textContent = result.product_name + ' · v' + result.version + (result.mode === 'mock' ? ' · 演示模式' : '') + ' · 自愿评价';
  form.appendChild(title);
  const makeSelect = (name, label, values) => {
    const select = document.createElement('select'); select.name = name; select.setAttribute('aria-label', label);
    select.add(new Option(label + '（选填）', ''));
    values.forEach(([value,text]) => select.add(new Option(text,value)));
    form.appendChild(select); return select;
  };
  const satisfaction = makeSelect('satisfaction','是否有帮助', [['satisfied','满意'],['neutral','一般'],['unsatisfied','不满意']]);
  const accuracy = makeSelect('accuracy','内容是否准确', [['accurate','准确'],['partial','部分准确'],['inaccurate','不准确'],['unknown','无法判断']]);
  const reason = makeSelect('reason','问题原因', [['产品识别错误','产品识别错误'],['政策错误','政策错误'],['信息遗漏','信息遗漏'],['英文表达问题','英文表达问题'],['其他','其他']]);
  const note = document.createElement('input'); note.name='note'; note.placeholder='补充说明（选填）'; note.maxLength=2000; note.setAttribute('aria-label','评价补充说明'); form.appendChild(note);
  const submit = document.createElement('button'); submit.textContent='提交评价'; submit.className='btn-secondary'; form.appendChild(submit);
  const status = document.createElement('small'); status.setAttribute('role','status'); form.appendChild(status);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled=true;
    try {
      await postJson('/api/copilot/feedback', { event_id: result.event_id, feedback_key: result.feedback_key, satisfaction:satisfaction.value, accuracy:accuracy.value, reason:reason.value, note:note.value });
      status.textContent='已评价，感谢反馈'; submit.textContent='更新评价';
    } catch (error) { status.textContent=error.message; }
    finally { submit.disabled=false; }
  });
  container.appendChild(form);
}

productSelect.addEventListener('change', () => {
  manualProduct = Boolean(productSelect.value);
  clearProductConversation();
  productReason.textContent = manualProduct ? '客服手动选择，仅影响当前工单；已清除旧产品对话，请重新生成。' : '发送前将重新自动识别产品。';
});
document.getElementById('resolveProductBtn').addEventListener('click', async () => {
  manualProduct=false;
  try { await loadProductCatalog(); await resolveCurrentProduct(); } catch(error) { showStatusBanner(error.message); }
});
document.getElementById('saveConnectionBtn').addEventListener('click', async () => {
  try { await saveSettings(); manualProduct=false; productSelect.value=''; clearProductConversation(); await loadProductCatalog(); showStatusBanner('连接设置已保存'); }
  catch(error) { showStatusBanner(error.message); }
});

// ── Chat ─────────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function applyInlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdown(raw) {
  const lines = escapeHtml(raw).split("\n");
  const out = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${applyInlineMarkdown(trimmed.replace(/^[-*]\s+/, ""))}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      if (trimmed === "") {
        out.push("<br>");
      } else if (/^#{1,3}\s+/.test(trimmed)) {
        out.push(`<strong>${applyInlineMarkdown(trimmed.replace(/^#{1,3}\s+/, ""))}</strong><br>`);
      } else {
        out.push(applyInlineMarkdown(trimmed) + "<br>");
      }
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

function appendChatMessage(role, content, result) {
  const wrap = document.createElement("div");
  wrap.className = `chat-message chat-message-${role}`;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }
  wrap.appendChild(bubble);

  if (result?.warnings?.length) {
    const warning = document.createElement('small'); warning.className = 'assistant-warning';
    warning.textContent = result.warnings.join(' '); wrap.appendChild(warning);
  }

  if (role === "assistant") {
    const copyBtn = document.createElement("button");
    copyBtn.className = "chat-copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(content).then(() => {
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });
    });
    wrap.appendChild(copyBtn);
    if (result?.event_id) appendFeedback(wrap, result);
  }

  elements.chatMessages.appendChild(wrap);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  return wrap;
}

function appendChatThinking() {
  const wrap = document.createElement("div");
  wrap.className = "chat-message chat-message-assistant";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-thinking";
  bubble.textContent = "Thinking…";
  wrap.appendChild(bubble);
  elements.chatMessages.appendChild(wrap);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  return wrap;
}

async function sendChatMessage(userText, task = 'chat') {
  const text = userText.trim();
  if (!text) return;
  if (activeOperation) return;
  if (!currentTicketId) {
    const recovered = resolveCapturedTicket({ subject: elements.subject.value, thread_structured: lastThreadStructured }, [], { url: currentTicketUrl });
    currentTicketId = recovered.id;
    if (!currentTicketId) { showStatusBanner('未识别到工单编号，请在工单页面重新 Capture。'); return; }
  }
  activeOperation = 'chat';
  setCaptureBusy(true);
  productSelect.disabled = true;
  document.getElementById('resolveProductBtn').disabled = true;
  elements.chatSendBtn.disabled = true;
  elements.chatClearBtn.disabled = true;
  try {
    if (!manualProduct) await resolveCurrentProduct();
    if (!productSelect.value) throw new Error('请先选择一个主要产品。');
  } catch (error) {
    showStatusBanner(error.message);
    activeOperation = null; setCaptureBusy(false); productSelect.disabled = false;
    document.getElementById('resolveProductBtn').disabled = false;
    elements.chatSendBtn.disabled = false; elements.chatClearBtn.disabled = false;
    return;
  }

  appendChatMessage("user", text);
  chatHistory.push({ role: "user", content: text });
  elements.chatInput.value = "";
  elements.chatQuickActions.style.display = "";

  const thinkingEl = appendChatThinking();
  elements.chatSendBtn.disabled = true;
  setStatus("thinking…");

  try {
    const data = await postJson("/chat", {
      task,
      product_id: productSelect.value,
      ticket_id: currentTicketId,
      source_url: currentTicketUrl,
      queue: currentQueue,
      messages: chatHistory.slice(-20),
      thread_context: {
        ticket_id: currentTicketId,
        source_url: currentTicketUrl,
        subject: elements.subject.value,
        thread_text: elements.threadText.value,
        thread_structured: lastThreadStructured
      },
      order_context: elements.manualLookup.value
    });

    thinkingEl.remove();
    const reply = data.reply || "(no response)";
    chatHistory.push({ role: "assistant", content: reply });
    appendChatMessage("assistant", reply, data);
    setStatus("ready");
  } catch (error) {
    if (chatHistory.at(-1)?.role === 'user') chatHistory.pop();
    thinkingEl.remove();
    appendChatMessage("assistant", `Error: ${error.message}`);
    setStatus("error");
  } finally {
    activeOperation = null;
    setCaptureBusy(false);
    productSelect.disabled = false;
    document.getElementById('resolveProductBtn').disabled = false;
    elements.chatClearBtn.disabled = false;
    elements.chatSendBtn.disabled = false;
  }
}

function clearPanel() {
  currentTicketId = '';
  currentTicketUrl = '';
  currentQueue = '';
  manualProduct = false;
  productSelect.value = '';
  productReason.textContent = '根据工单队列、邮件和订单识别，可手动纠正。';
  lastThreadStructured = null;
  orderSearchContextPromise = null;
  chatHistory.length = 0;

  elements.subject.value = "";
  elements.threadText.value = "";
  elements.customerEmailInput.value = "";
  elements.orderResultsDisplay.style.display = "none";
  elements.orderResultsDisplay.innerHTML = "";
  elements.manualLookup.style.display = "";
  if (elements.lookupToggleBtn) elements.lookupToggleBtn.style.display = "none";
  elements.manualLookup.value = "";
  elements.chatMessages.innerHTML = "";
  elements.chatInput.value = "";
  elements.chatQuickActions.style.display = "";
  elements.debugInfo.textContent = "";
  setStatus("cleared");
}

function friendlyErrorMessage(error) {
  const msg = error?.message || String(error);
  if (/could not establish connection|receiving end does not exist/i.test(msg)) {
    return "Content script not reachable. Please reload the Znuny ticket page, then try Capture again.";
  }
  if (/no active tab/i.test(msg)) {
    return "No active tab found. Open a ticket page and try again.";
  }
  if (/no content script response/i.test(msg)) {
    return "Could not extract content. Reload the ticket page and try again.";
  }
  return msg;
}

function handleError(error) {
  console.error(error);
  setStatus("error: " + friendlyErrorMessage(error).slice(0, 60));
}

function handleCaptureError(error) {
  console.error(error);
  const msg = friendlyErrorMessage(error);
  setStatus("error");
  showStatusBanner(msg);
}

let bannerTimeout = null;
function showStatusBanner(msg) {
  let banner = document.getElementById("statusBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "statusBanner";
    banner.className = "status-banner";
    document.querySelector(".app").insertBefore(banner, document.querySelector(".action-bar"));
  }
  banner.textContent = msg;
  banner.style.display = "";
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => { banner.style.display = "none"; }, 6000);
}

// ── Event listeners ───────────────────────────────────────────────────────────

function addRipple(btn) {
  btn.addEventListener("click", (e) => {
    const r = document.createElement("span");
    r.className = "ripple";
    const rect = btn.getBoundingClientRect();
    r.style.left = (e.clientX - rect.left) + "px";
    r.style.top  = (e.clientY - rect.top)  + "px";
    btn.appendChild(r);
    r.addEventListener("animationend", () => r.remove());
  });
}
addRipple(elements.captureBtn);
addRipple(elements.chatSendBtn);

loadSettings().then(loadProductCatalog).catch(error => { productReason.textContent = error.message; });

elements.lookupToggleBtn.addEventListener("click", () => {
  const showing = elements.orderResultsDisplay.style.display !== "none";
  elements.orderResultsDisplay.style.display = showing ? "none" : "";
  elements.manualLookup.style.display = showing ? "" : "none";
  elements.lookupToggleBtn.textContent = showing ? "原始数据" : "结构化视图";
});

elements.orderResultsDisplay.addEventListener("click", (e) => {
  const copyBtn = e.target.closest(".copy-chip");
  if (copyBtn) {
    navigator.clipboard.writeText(copyBtn.dataset.copy || "").then(() => {
      copyBtn.classList.add("copied");
      const orig = copyBtn.textContent;
      copyBtn.textContent = "✓";
      setTimeout(() => { copyBtn.textContent = orig; copyBtn.classList.remove("copied"); }, 1500);
    });
    return;
  }

  const collapseBtn = e.target.closest(".order-collapse-btn");
  if (collapseBtn) {
    const extra = elements.orderResultsDisplay.querySelector(".order-extra-cards");
    if (!extra) return;
    const collapsed = extra.classList.toggle("collapsed");
    const total = extra.querySelectorAll(".order-card").length + 1;
    collapseBtn.textContent = collapsed ? `展开全部 (${total}条)` : "收起";
  }
});

elements.captureBtn.addEventListener("click", () => {
  captureThread()
    .then(() => autoSearchOrdersAfterCapture())
    .then(() => resolveCurrentProduct())
    .catch(handleCaptureError);
});

elements.orderSearchBtn.addEventListener("click", () => runOrderSearch().catch(handleCaptureError));
elements.orderSearchDebugBtn.addEventListener("click", () => runOrderSearch({ includeDebug: true }).catch(handleCaptureError));
elements.clearBtn.addEventListener("click", clearPanel);

elements.chatSendBtn.addEventListener("click", () => sendChatMessage(elements.chatInput.value));

function flashCopied(btn) {
  const orig = btn.textContent;
  btn.textContent = "✓";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1500);
}

elements.copyTicketBtn.addEventListener("click", () => {
  const subject = elements.subject.value;
  const match = subject.match(/Ticket#?\s*([A-Z0-9-]+)/i);
  const text = match ? match[1] : subject;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => flashCopied(elements.copyTicketBtn));
});

elements.copyEmailBtn.addEventListener("click", () => {
  const email = elements.customerEmailInput.value.trim() || getCandidateCustomerEmail();
  if (!email) return;
  navigator.clipboard.writeText(email).then(() => flashCopied(elements.copyEmailBtn));
});

elements.chatClearBtn.addEventListener("click", () => {
  chatHistory.length = 0;
  elements.chatMessages.innerHTML = "";
  elements.chatQuickActions.style.display = "";
});

elements.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage(elements.chatInput.value);
  }
});

elements.chatQuickActions.addEventListener("click", (e) => {
  const chip = e.target.closest(".chat-chip");
  if (chip) {
    sendChatMessage(chip.dataset.msg || chip.textContent, chip.dataset.task || 'chat');
  }
});
