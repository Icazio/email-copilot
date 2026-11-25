const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { retrieve, buildContextBlock } = require("./knowledge-retriever");

// Queue-page triage: "处理类型" (category + case + one-line summary) and the
// one-click action for each ticket card. The model only classifies and
// summarises; which action a category/case gets is decided here, by rules.

const CONFIG_FILE = path.join(__dirname, "../prompts/queue-triage.json");
const CATEGORIES = ["cancel_renewal", "free_credit", "refund", "consult", "technical", "invoice", "other"];
const REFUND_CASES = ["auto_renewal", "effect_unsatisfied", "program_issue"];
const TEXT_LIMIT = 1500;
const BATCH_SIZE = 8;
const CACHE_LIMIT = 1000;

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function clean(text, limit) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

// ─── Rules (fallback, and the deterministic parts) ────────────────────────────

const RE = {
  freeCredit: /\bfree\s+credits?\b|\bcredits?\b[^.]{0,80}\b(youtube|twitter|facebook|instagram|tiktok|follow|subscri)/i,
  youtube: /youtube|youtu\.be|channel\s*id/i,
  refund: /\brefund|money\s+back|charge\s*back|unauthori[sz]ed\s+(charge|payment)|charged\s+(again|twice)|apply\s+(my\s+)?payment/i,
  autoRenewal: /auto(matic(ally)?)?[\s-]*renew|renewed|renewal|second\s+(month|charge)|recurring|charged\s+again/i,
  unsatisfied: /not\s+(satisf|happy)|unsatisf|disappoint|quality|blurr|result|effect|not\s+(as\s+)?expected|worse|no\s+(improvement|difference)|didn'?t\s+(improve|enhance)/i,
  programIssue: /crash|error|freez|bug|not\s+work|doesn'?t\s+work|won'?t\s+(open|start|launch|run)|fail|stuck|black\s+screen/i,
  cancel: /cancel|stop\s+(the\s+)?(auto[\s-]*)?renew|turn\s+off\s+(auto|renew)|unsubscribe\s+from\s+(the\s+)?(plan|subscription)/i,
  invoice: /invoice|receipt|\bvat\b/i
};

function ruleCategory(text) {
  if (RE.freeCredit.test(text)) return "free_credit";
  if (RE.refund.test(text)) return "refund";
  if (RE.cancel.test(text) && /renew|subscri|plan/i.test(text)) return "cancel_renewal";
  if (RE.invoice.test(text)) return "invoice";
  if (RE.programIssue.test(text)) return "technical";
  return "consult";
}

function ruleRefundCase(text) {
  if (RE.autoRenewal.test(text)) return "auto_renewal";
  if (RE.unsatisfied.test(text)) return "effect_unsatisfied";
  if (RE.programIssue.test(text)) return "program_issue";
  return "";
}

// Free-credit cases depend only on facts the page reports (attachments) and
// the text, never on the model.
function freeCreditCase(ticket) {
  if (ticket.has_images) return "has_images";
  if (RE.youtube.test(ticket.text)) return "youtube_no_screenshot";
  return "";
}

const ACTIONS = {
  cancel_renewal: () => "transfer_julie",
  free_credit: (c) => (c === "youtube_no_screenshot" ? "reply_ask_screenshot" : c === "has_images" ? "manual_review" : "open"),
  refund: (c) => ({ auto_renewal: "transfer_julie", effect_unsatisfied: "reply_ask_comparison", program_issue: "reply_ask_log" }[c] || "open"),
  consult: () => "draft_reply"
};

function decorate(ticket, category, kase, summary, engine, config) {
  const action = (ACTIONS[category] || (() => "open"))(kase);
  const result = {
    ticket_id: ticket.id,
    category,
    category_label: config.labels[category] || category,
    case: kase,
    case_label: config.case_labels[kase] || "",
    summary,
    action,
    engine
  };
  if (action === "transfer_julie") {
    result.owner = config.julie.owner;
    result.title = config.julie.titles[kase === "auto_renewal" ? "auto_renewal" : "cancel_renewal"];
  }
  const replyKey = { reply_ask_screenshot: "ask_screenshot", reply_ask_comparison: "ask_comparison", reply_ask_log: "ask_log" }[action];
  if (replyKey) result.reply_text = config.replies[replyKey];
  return result;
}

function finalize(ticket, raw, engine, config) {
  let category = CATEGORIES.includes(raw?.category) ? raw.category : ruleCategory(ticket.text);
  let kase = "";
  if (category === "free_credit") kase = freeCreditCase(ticket);
  if (category === "refund") kase = REFUND_CASES.includes(raw?.case) ? raw.case : ruleRefundCase(ticket.text);
  const summary = clean(raw?.summary, 80) || `（规则判断）${clean(ticket.subject, 60)}`;
  return decorate(ticket, category, kase, summary, engine, config);
}

// ─── Model ───────────────────────────────────────────────────────────────────

function parseJson(text) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("no JSON");
  return JSON.parse(s.slice(a, b + 1));
}

function hashTicket(t) {
  return crypto.createHash("sha1").update(`${t.subject}\n${t.text}\n${t.has_images ? 1 : 0}`).digest("hex").slice(0, 16);
}

function createQueueTriage({ provider, model, callModel }) {
  const cache = new Map(); // `${id}:${hash}` → result

  function remember(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  async function classifyBatch(batch, config) {
    if (provider === "mock" || typeof callModel !== "function") {
      return batch.map((t) => finalize(t, null, "rules", config));
    }
    try {
      const text = await callModel({
        model,
        instructions: config.system.join("\n"),
        input: JSON.stringify({
          tickets: batch.map((t) => ({ id: t.id, subject: t.subject, text: t.text, has_image_attachments: t.has_images }))
        }),
        maxTokens: 2500
      });
      const byId = new Map((parseJson(text).results || []).map((r) => [String(r.id), r]));
      return batch.map((t) => {
        const raw = byId.get(t.id);
        return finalize(t, raw, raw ? provider : "rules", config);
      });
    } catch (error) {
      const engine = `rules(fallback:${String(error.message).slice(0, 40)})`;
      return batch.map((t) => finalize(t, null, engine, config));
    }
  }

  async function triage({ tickets } = {}) {
    const config = loadConfig();
    const list = (Array.isArray(tickets) ? tickets : []).slice(0, 60).map((t) => ({
      id: String(t.ticket_id || ""),
      subject: clean(t.subject, 300),
      text: clean(`${t.subject || ""}\n${t.text || ""}`, TEXT_LIMIT),
      has_images: Boolean(t.has_images)
    })).filter((t) => t.id);

    const results = new Map();
    const todo = [];
    for (const t of list) {
      const key = `${t.id}:${hashTicket(t)}`;
      if (cache.has(key)) results.set(t.id, { ...cache.get(key), cached: true });
      else todo.push({ t, key });
    }

    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));
    // Two batches at a time: fast enough for a 20-ticket page, gentle on rate limits.
    for (let i = 0; i < batches.length; i += 2) {
      const done = await Promise.all(batches.slice(i, i + 2).map((b) => classifyBatch(b.map((x) => x.t), config)));
      done.flat().forEach((r, j) => {
        const { key } = batches.slice(i, i + 2).flat()[j];
        if (!String(r.engine).startsWith("rules(")) remember(key, r);
        results.set(r.ticket_id, r);
      });
    }

    return { results: list.map((t) => results.get(t.id)).filter(Boolean) };
  }

  // Consult tickets: knowledge-base search + model-written reply body.
  async function draft({ subject, text, customer_name, orders } = {}) {
    const config = loadConfig();
    const name = clean(customer_name, 60) || "User";
    const thread = clean(`${subject || ""}\n${text || ""}`, 4000);
    const entries = retrieve(thread);
    const knowledge = buildContextBlock(entries);
    const orderLines = (Array.isArray(orders) ? orders : []).slice(0, 5)
      .map((o) => `- ${[o.Product, o["Purchase Date"], o.Amount, o.Status].filter(Boolean).join(" | ")}`).join("\n");

    if (provider === "mock" || typeof callModel !== "function") {
      return {
        draft: `Dear ${name},\n\nThank you for contacting us. We have received your message and are checking it with the relevant team. We will get back to you as soon as possible.`,
        knowledge: entries.map((e) => e.title),
        engine: "mock"
      };
    }

    const input = [
      knowledge || "[COMPANY CONTEXT]\n(no matching knowledge entries)",
      orderLines ? `[ORDERS]\n${orderLines}` : "[ORDERS]\n(none found)",
      `[CUSTOMER NAME]\n${name}`,
      `[CUSTOMER MESSAGE]\n${thread}`
    ].join("\n\n");
    const out = parseJson(await callModel({ model, instructions: config.draft_system.join("\n"), input, maxTokens: 1500 }));
    const body = String(out.draft || "").trim();
    if (!body) throw new Error("模型没有返回回复内容");
    return { draft: body, knowledge: entries.map((e) => e.title), engine: provider };
  }

  return { triage, draft };
}

module.exports = { createQueueTriage, ruleCategory, ruleRefundCase };
