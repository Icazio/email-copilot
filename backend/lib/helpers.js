const fs = require("fs");
const path = require("path");

function templatesDir() {
  return path.resolve(__dirname, "../../templates");
}

function loadTemplates() {
  const dir = templatesDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      return JSON.parse(raw);
    });
}

function sendJson(res, statusCode, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanArray(items) {
  return Array.isArray(items) ? items.filter(Boolean) : [];
}

function normalizeStructuredThread(thread) {
  if (!thread || typeof thread !== "object") {
    return null;
  }

  return {
    page_type: normalizeText(thread.page_type || ""),
    ticket_subject: normalizeText(thread.ticket_subject || ""),
    active_article_body: normalizeText(thread.active_article_body || ""),
    customer_email: normalizeText(thread.customer_email || ""),
    customer_id_email: normalizeText(thread.customer_id_email || ""),
    customer_email_candidates: cleanArray(thread.customer_email_candidates).map((e) => normalizeText(e)),
    articles: cleanArray(thread.articles).map((article) => ({
      number: normalizeText(article?.number || ""),
      direction: normalizeText(article?.direction || ""),
      sender: normalizeText(article?.sender || ""),
      subject: normalizeText(article?.subject || ""),
      created: normalizeText(article?.created || ""),
      status: normalizeText(article?.status || ""),
      attachments: cleanArray(article?.attachments)
    }))
  };
}

function buildStructuredThreadText(thread) {
  const normalized = normalizeStructuredThread(thread);
  if (!normalized) {
    return "";
  }

  const lines = [];

  if (normalized.ticket_subject) {
    lines.push(`Ticket subject: ${normalized.ticket_subject}`);
  }

  if (normalized.articles.length) {
    lines.push("Articles:");
    normalized.articles.forEach((article) => {
      lines.push(
        [
          `Article ${article.number || "?"}`,
          article.direction,
          article.created ? `created ${article.created}` : "",
          article.sender ? `from ${article.sender}` : "",
          article.subject ? `subject ${article.subject}` : "",
          article.status ? `status ${article.status}` : ""
        ]
          .filter(Boolean)
          .join(" | ")
      );
    });
  }

  if (normalized.active_article_body) {
    lines.push("Active article body:");
    lines.push(normalized.active_article_body);
  }

  return normalizeText(lines.join("\n"));
}

function buildCombinedThreadText(body, extraParts = []) {
  const parts = [
    normalizeText(body?.subject || ""),
    normalizeText(body?.thread_text || ""),
    buildStructuredThreadText(body?.thread_structured),
    ...cleanArray(extraParts).map((item) => normalizeText(item))
  ].filter(Boolean);

  return normalizeText(parts.join("\n\n"));
}

// Order search text from the ticket system looks like:
//   James Somerset <a@b.com> US [AL PhotoPro AI 3000 Credits / AL_PHOTO_PRO_3KC]
//   2026-10-31 17:59:18 - PADDLE - 82765308 - <license keys> - USD56.83 - PAID
// Customer name and country are optional; license keys may be empty or comma-separated.
const ORDER_HEADER_RE = /^(?:(.+?)\s+)?<([^>\s]+@[^>\s]+)>\s*(?:([A-Z]{2})\s+)?\[([^\]]+)\]\s*$/;
const ORDER_DETAIL_RE = /^(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)\s*-\s*(\S+)\s*-\s*(\S*)\s*-\s*(.*?)\s*-\s*([A-Z]{3}\s?[\d.,]+)\s*-\s*([A-Z_]+)\s*$/;

function parseOrderLookupText(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const orders = [];
  let header = null;

  for (const line of lines) {
    const h = line.match(ORDER_HEADER_RE);
    if (h) {
      header = { customer: h[1] || "", email: h[2], country: h[3] || "", product: h[4] };
      continue;
    }
    const d = line.match(ORDER_DETAIL_RE);
    if (d && header) {
      const [productName, sku] = header.product.split(/\s+\/\s+/);
      orders.push({
        customer: header.customer,
        email: header.email,
        country: header.country,
        product: (productName || header.product).trim(),
        sku: (sku || "").trim(),
        date: d[1],
        provider: d[2],
        order_id: d[3],
        license_keys: d[4].split(",").map((k) => k.trim()).filter((k) => k && k !== "-"),
        amount: d[5].replace(/\s+/g, ""),
        status: d[6]
      });
      header = null;
    }
  }

  return orders.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function formatOrdersForPrompt(text) {
  const orders = parseOrderLookupText(text);
  if (!orders.length) return null;

  const emails = [...new Set(orders.map((o) => o.email))];
  const names = [...new Set(orders.map((o) => o.customer).filter(Boolean))];
  const lines = [
    `Orders found: ${orders.length} (newest first)`,
    `Purchase email: ${emails.join(", ")}${names.length ? ` | Name: ${names.join(", ")}` : ""}`
  ];

  orders.forEach((o, i) => {
    lines.push("");
    lines.push(`${i + 1}. ${o.product}${o.sku ? ` (${o.sku})` : ""}`);
    lines.push(`   Date: ${o.date} | Amount: ${o.amount} | Status: ${o.status} | Payment: ${o.provider}${o.country ? ` | Country: ${o.country}` : ""}`);
    lines.push(`   Order ID: ${o.order_id || "(none)"}`);
    lines.push(o.license_keys.length
      ? `   License key${o.license_keys.length > 1 ? "s" : ""} (${o.license_keys.length}): ${o.license_keys.join(", ")}`
      : "   License key: (none)");
  });

  return lines.join("\n");
}

function pickTemplate(category, templates) {
  return templates.find((item) => item.scene === category) || templates[0] || null;
}

function findTemplateById(templateId, templates) {
  return templates.find((item) => item.id === templateId) || null;
}

module.exports = {
  loadTemplates,
  sendJson,
  sendText,
  readJsonBody,
  normalizeText,
  normalizeStructuredThread,
  buildStructuredThreadText,
  buildCombinedThreadText,
  pickTemplate,
  findTemplateById,
  parseOrderLookupText,
  formatOrdersForPrompt
};
