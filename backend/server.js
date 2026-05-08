const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { loadTemplates, readJsonBody, sendJson, sendText } = require("./lib/helpers");
const { analyzeThreadMock, extractFieldsMock, generateDraftMock, refineDraftMock } = require("./lib/mock-engine");
const { analyzeThreadDeepSeek, generateDraftDeepSeek, refineDraftDeepSeek } = require("./lib/deepseek-engine");
const { analyzeThreadOpenAI, generateDraftOpenAI, refineDraftOpenAI } = require("./lib/openai-engine");

function loadDotEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (!key || process.env[key]) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadDotEnv();

function resolvePort(value) {
  const parsed = Number(value || 8787);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed < 65536) {
    return parsed;
  }
  return 8787;
}

const PORT = resolvePort(process.env.PORT);
const REQUESTED_PROVIDER = String(process.env.AI_PROVIDER || "").trim().toLowerCase() || null;
const CONFIGURED_PROVIDERS = {
  deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
  openai: Boolean(process.env.OPENAI_API_KEY)
};
const PROVIDER = resolveProvider();
const MODEL = resolveModel(PROVIDER);
const templates = loadTemplates();

function resolveProvider() {
  const preferred = REQUESTED_PROVIDER;

  if (preferred === "deepseek" || preferred === "openai" || preferred === "mock") {
    if (preferred === "deepseek") {
      return CONFIGURED_PROVIDERS.deepseek ? "deepseek" : "mock";
    }

    if (preferred === "openai") {
      return CONFIGURED_PROVIDERS.openai ? "openai" : "mock";
    }

    return "mock";
  }

  if (CONFIGURED_PROVIDERS.deepseek) {
    return "deepseek";
  }

  if (CONFIGURED_PROVIDERS.openai) {
    return "openai";
  }

  return "mock";
}

function resolveModel(provider) {
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_MODEL || process.env.AI_MODEL || "deepseek-v4-flash";
  }

  if (provider === "openai") {
    return process.env.OPENAI_MODEL || process.env.AI_MODEL || "gpt-5-mini";
  }

  return "mock-engine";
}

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(endpoint, fields) {
  const parts = [`[${timestamp()}]`, endpoint];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${JSON.stringify(v)}`);
  }
  console.log(parts.join(" | "));
}

async function routeRequest(req, res) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      mode: PROVIDER,
      model: MODEL,
      templateCount: templates.length,
      requestedProvider: REQUESTED_PROVIDER,
      configuredProviders: CONFIGURED_PROVIDERS
    });
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 404, "Not found");
    return;
  }

  const body = await readJsonBody(req);
  const t0 = Date.now();

  if (requestUrl.pathname === "/extract-fields") {
    const result = extractFieldsMock(body);
    log("POST /extract-fields", {
      chars: String(body.threadText || "").length,
      ms: Date.now() - t0
    });
    sendJson(res, 200, result);
    return;
  }

  if (requestUrl.pathname === "/analyze-thread") {
    let usedEngine = PROVIDER;
    const result =
      PROVIDER === "deepseek"
        ? await analyzeThreadDeepSeek({ model: MODEL, body, templates })
            .catch((err) => { usedEngine = "mock(fallback:" + err.message.slice(0, 40) + ")"; return analyzeThreadMock(body, templates); })
        : PROVIDER === "openai"
          ? await analyzeThreadOpenAI({ model: MODEL, body, templates })
              .catch((err) => { usedEngine = "mock(fallback:" + err.message.slice(0, 40) + ")"; return analyzeThreadMock(body, templates); })
          : analyzeThreadMock(body, templates);
    log("POST /analyze-thread", {
      engine: usedEngine,
      subject: String(body.subject || "").slice(0, 60),
      chars: String(body.threadText || "").length,
      category: result.category || "?",
      ms: Date.now() - t0
    });
    sendJson(res, 200, result);
    return;
  }

  if (requestUrl.pathname === "/generate-draft") {
    let usedEngine = PROVIDER;
    const result =
      PROVIDER === "deepseek"
        ? await generateDraftDeepSeek({ model: MODEL, body, templates })
            .catch((err) => { usedEngine = "mock(fallback:" + err.message.slice(0, 40) + ")"; return generateDraftMock(body, templates); })
        : PROVIDER === "openai"
          ? await generateDraftOpenAI({ model: MODEL, body, templates })
              .catch((err) => { usedEngine = "mock(fallback:" + err.message.slice(0, 40) + ")"; return generateDraftMock(body, templates); })
          : generateDraftMock(body, templates);
    log("POST /generate-draft", {
      engine: usedEngine,
      category: body.category || "?",
      draft_chars: String(result.draft || "").length,
      ms: Date.now() - t0
    });
    sendJson(res, 200, result);
    return;
  }

  if (requestUrl.pathname === "/refine-draft") {
    let usedEngine = PROVIDER;
    const result =
      PROVIDER === "deepseek"
        ? await refineDraftDeepSeek({ model: MODEL, body, templates })
            .catch((err) => { usedEngine = "mock(fallback:" + err.message.slice(0, 40) + ")"; return refineDraftMock(body, templates); })
        : PROVIDER === "openai"
          ? await refineDraftOpenAI({ model: MODEL, body, templates })
              .catch((err) => { usedEngine = "mock(fallback:" + err.message.slice(0, 40) + ")"; return refineDraftMock(body, templates); })
          : refineDraftMock(body, templates);
    log("POST /refine-draft", {
      engine: usedEngine,
      category: body.category || "?",
      draft_chars: String(result.draft || "").length,
      ms: Date.now() - t0
    });
    sendJson(res, 200, result);
    return;
  }

  sendText(res, 404, "Not found");
}

const server = http.createServer(async (req, res) => {
  try {
    await routeRequest(req, res);
  } catch (error) {
    console.error(`[${timestamp()}] ERROR`, error instanceof Error ? error.message : String(error));
    sendJson(res, 500, {
      error: "Internal server error",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`Email Copilot backend listening on http://localhost:${PORT}`);
  console.log(`Mode: ${PROVIDER} (${MODEL})`);
});
