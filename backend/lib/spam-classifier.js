const fs = require("fs");
const path = require("path");

const PROMPT_FILE = path.join(__dirname, "../prompts/spam-classify.json");
const DEFAULT_CACHE_FILE = path.join(__dirname, "../state/spam-classify-cache.json");
const CACHE_LIMIT = 2000;
const PREVIEW_LIMIT = 500;
const VERDICTS = new Set(["spam", "ham", "unsure"]);

// Read on every call so prompt edits apply without restarting the backend.
function loadPrompt() {
  const raw = JSON.parse(fs.readFileSync(PROMPT_FILE, "utf8"));
  const system = (raw.system || []).join("\n");
  const examples = (raw.examples || [])
    .map((ex) => `Input: ${JSON.stringify({ sender: ex.sender, subject: ex.subject, preview: ex.preview })}\nOutput: ${JSON.stringify(ex.output)}`)
    .join("\n\n");
  return examples ? `${system}\n\nExamples:\n\n${examples}` : system;
}

function buildInput({ sender, subject, preview }) {
  return JSON.stringify({
    sender: String(sender || "").trim().slice(0, 200),
    subject: String(subject || "").replace(/\s+/g, " ").trim().slice(0, 300),
    preview: String(preview || "").replace(/\s+/g, " ").trim().slice(0, PREVIEW_LIMIT)
  });
}

// Never trust model output blindly: anything malformed becomes "unsure".
function parseVerdict(text) {
  let data;
  try {
    data = JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch (_error) {
    return { verdict: "unsure", confidence: 0, reason: "AI 返回格式无法解析" };
  }
  const verdict = VERDICTS.has(data?.verdict) ? data.verdict : "unsure";
  const confidence = Number(data?.confidence);
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    reason: String(data?.reason || "").slice(0, 120)
  };
}

function createSpamClassifier({ provider, model, callModel, cacheFile = DEFAULT_CACHE_FILE } = {}) {
  let cache = null;

  function loadCache() {
    if (cache) return cache;
    try {
      cache = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile, "utf8"))));
    } catch (_error) {
      cache = new Map();
    }
    return cache;
  }

  function saveCache() {
    const entries = [...loadCache().entries()].slice(-CACHE_LIMIT);
    cache = new Map(entries);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(entries)), "utf8");
  }

  async function classify({ ticket_id, sender, subject, preview } = {}) {
    const key = ticket_id ? String(ticket_id) : "";
    if (key && loadCache().has(key)) {
      return { ...loadCache().get(key), cached: true };
    }

    if (provider === "mock" || typeof callModel !== "function") {
      // No AI available: leave the decision to a human rather than guessing.
      return { verdict: "unsure", confidence: 0, reason: "未配置 AI，需人工判断", engine: "mock" };
    }

    let result;
    try {
      const text = await callModel({
        model,
        instructions: loadPrompt(),
        input: buildInput({ sender, subject, preview }),
        // V4.1 Flash may spend tokens on hidden reasoning before the JSON;
        // 120 was observed to truncate to empty output on ambiguous emails.
        maxTokens: 800
      });
      result = { ...parseVerdict(text), engine: provider };
    } catch (error) {
      // Engine failure must not mark anything as spam, and must not be cached
      // so the next page load retries.
      return { verdict: "unsure", confidence: 0, reason: "AI 调用失败，需人工判断", engine: `error:${String(error.message).slice(0, 40)}` };
    }

    if (key) {
      loadCache().set(key, { ...result, at: new Date().toISOString() });
      saveCache();
    }
    return result;
  }

  // A human decision on a single ticket wins over any AI verdict.
  function override(ticketId, verdict, reason) {
    if (!ticketId) return;
    loadCache().set(String(ticketId), { verdict, confidence: 1, reason, engine: "human", at: new Date().toISOString() });
    saveCache();
  }

  return { classify, override };
}

module.exports = { createSpamClassifier, parseVerdict, buildInput, loadPrompt };
