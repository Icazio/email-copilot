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
    available_standard_responses: cleanArray(thread.available_standard_responses).map((item) =>
      normalizeText(item)
    ),
    articles: cleanArray(thread.articles).map((article) => ({
      number: normalizeText(article?.number || ""),
      direction: normalizeText(article?.direction || ""),
      sender: normalizeText(article?.sender || ""),
      subject: normalizeText(article?.subject || ""),
      created: normalizeText(article?.created || ""),
      status: normalizeText(article?.status || "")
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

  if (normalized.available_standard_responses.length) {
    lines.push("Available standard responses:");
    lines.push(normalized.available_standard_responses.join(" | "));
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
  findTemplateById
};
