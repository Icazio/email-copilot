const fs = require("fs");
const path = require("path");
const { readJsonBody, sendJson } = require("./helpers");

const LOG_DIR = path.join(__dirname, "../logs/spam");

function appendLog(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(LOG_DIR, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

function readTodayLog() {
  const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (_error) {
    return [];
  }
}

// Returns true when the request was a /spam/* route and has been answered.
async function handleSpamRoute(req, res, pathname, { lists, classifier, log }) {
  if (!pathname.startsWith("/spam/")) return false;
  const t0 = Date.now();

  if (req.method === "GET" && pathname === "/spam/lists") {
    sendJson(res, 200, { lists: lists.load(), filters: lists.exportFilterPatterns() });
    return true;
  }

  if (req.method === "GET" && pathname === "/spam/stats") {
    const entries = readTodayLog();
    const count = (pred) => entries.filter(pred).length;
    sendJson(res, 200, {
      date: new Date().toISOString().slice(0, 10),
      classified: count((e) => e.type === "classify"),
      list_spam: count((e) => e.type === "classify" && e.verdict === "spam" && e.engine === "list"),
      ai_spam: count((e) => e.type === "classify" && e.verdict === "spam" && !["list", "order", "human"].includes(e.engine)),
      unsure: count((e) => e.type === "classify" && e.verdict === "unsure"),
      corrections_to_ham: count((e) => e.type === "feedback" && e.correction === "ham"),
      corrections_to_spam: count((e) => e.type === "feedback" && e.correction === "spam")
    });
    return true;
  }

  if (req.method !== "POST") return false;
  const body = await readJsonBody(req);

  if (pathname === "/spam/lists") {
    const next = lists.apply(body);
    log("POST /spam/lists", { action: body.action, ms: Date.now() - t0 });
    sendJson(res, 200, { lists: next });
    return true;
  }

  if (pathname === "/spam/classify") {
    const status = lists.check(body.sender);
    let result;
    if (body.has_order) {
      result = { verdict: "ham", confidence: 1, reason: "查到该客户的订单", engine: "order" };
    } else if (status === "allowed") {
      result = { verdict: "ham", confidence: 1, reason: "发件人在白名单中", engine: "list" };
    } else if (status === "blocked") {
      result = { verdict: "spam", confidence: 1, reason: "发件人已被拉黑", engine: "list" };
    } else {
      result = await classifier.classify(body);
    }
    if (!result.cached) {
      appendLog({ type: "classify", ticket_id: body.ticket_id, verdict: result.verdict, confidence: result.confidence, engine: result.engine });
    }
    log("POST /spam/classify", { verdict: result.verdict, confidence: result.confidence, engine: result.engine, cached: Boolean(result.cached), ms: Date.now() - t0 });
    sendJson(res, 200, result);
    return true;
  }

  // Human correction from the queue page.
  // { ticket_id, sender, shown, correction: "ham" | "spam", scope: "ticket" | "sender" | "domain" }
  if (pathname === "/spam/feedback") {
    const { ticket_id, sender, shown, correction, scope } = body;
    if (correction !== "ham" && correction !== "spam") {
      sendJson(res, 400, { error: "correction must be ham or spam" });
      return true;
    }
    let next = null;
    if (correction === "ham" && sender) {
      next = lists.apply({ action: "allow", email: sender });
    } else if (correction === "spam" && scope === "sender") {
      next = lists.apply({ action: "block", email: sender });
    } else if (correction === "spam" && scope === "domain") {
      next = lists.apply({ action: "block_domain", email: sender });
    }
    // Sender/domain blocks live in the lists (so "unblock" can undo them);
    // only a single-ticket spam mark, or any "not spam" mark, pins the ticket itself.
    if (correction === "ham") classifier.override(ticket_id, "ham", "人工标记为正常");
    else if (!scope || scope === "ticket") classifier.override(ticket_id, "spam", "人工标记为垃圾");
    appendLog({ type: "feedback", ticket_id, shown, correction, scope: scope || "ticket" });
    log("POST /spam/feedback", { correction, scope: scope || "ticket", ms: Date.now() - t0 });
    sendJson(res, 200, { ok: true, lists: next || lists.load() });
    return true;
  }

  return false;
}

module.exports = { handleSpamRoute };
