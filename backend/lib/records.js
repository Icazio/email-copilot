// Refund and free-credit records.
//   Refund  → Feishu sheet/bitable (via feishu.js), columns matched by header name.
//   Credit  → Tencent Docs has no simple API, so the backend only builds the
//             row (TSV) for the agent to paste, and keeps a local log to warn
//             about duplicates.
const fs = require("fs");
const path = require("path");
const feishu = require("./feishu");

const DEFAULT_REFUND_WIKI_TOKEN = "NDRywHduAiR9gIkY2gvcOvKmnFd";
const REFUND_SHEET_URL = "https://ncnjsna81j37.feishu.cn/wiki/NDRywHduAiR9gIkY2gvcOvKmnFd?from=navigation";
const STATE_DIR = path.join(__dirname, "../state");
// Overridable so tests do not touch the real log.
const logFile = () => process.env.EC_RECORDS_LOG || path.join(STATE_DIR, "records.jsonl");

// Our field keys → patterns that recognise a header. Order matters: more
// specific keys first ("购买日期" must not be taken as the record date).
const FIELD_PATTERNS = [
  ["purchase_date", /购买|下单|purchase/i],
  ["date", /日期|时间|date|time/i],
  ["ticket", /工单|ticket/i],
  ["email", /邮箱|邮件地址|e-?mail/i],
  ["order_id", /订单|order/i],
  ["product", /产品|软件|product/i],
  ["amount", /金额|价格|amount|price|usd/i],
  ["provider", /平台|渠道|支付|provider|payment|gateway/i],
  ["reason", /原因|reason/i],
  ["agent", /客服|处理人|经手|agent|handler/i],
  ["status", /状态|status/i],
  ["note", /备注|说明|note|remark/i]
];

const FIELD_LABELS = {
  date: "记录日期", purchase_date: "购买日期", ticket: "工单号", email: "客户邮箱", order_id: "订单号",
  product: "产品", amount: "金额", provider: "支付平台", reason: "退款原因", agent: "客服", status: "状态", note: "备注"
};

function mapHeaders(headers) {
  const used = new Set();
  return headers.map((header) => {
    const hit = FIELD_PATTERNS.find(([key, re]) => !used.has(key) && re.test(header));
    if (!hit) return { header, key: null };
    used.add(hit[0]);
    return { header, key: hit[0], label: FIELD_LABELS[hit[0]] };
  });
}

function today(sep = "-") {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join(sep);
}

// ─── Local log (dedupe) ───────────────────────────────────────────────────────

function appendLog(entry) {
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  fs.appendFileSync(logFile(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

function readLog() {
  try {
    return fs.readFileSync(logFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (_error) {
    return [];
  }
}

function findPrevious(type, predicate) {
  return readLog().filter((e) => e.type === type && predicate(e)).slice(-3);
}

// ─── Refund target (Feishu) ───────────────────────────────────────────────────

let targetCache = null;

// FEISHU_REFUND_URL may point at the table itself (…/sheets/<token>,
// …/base/<token>?table=tbl…) — no wiki lookup needed, which matters for pages
// in a personal "我的文档库" where the wiki node API is not open to apps.
function parseRefundUrl(url) {
  const text = String(url || "");
  const sheet = text.match(/\/sheets\/([A-Za-z0-9]+)/);
  if (sheet) return { type: "sheet", objToken: sheet[1], sheetId: (text.match(/[?&]sheet=([A-Za-z0-9]+)/) || [])[1] };
  const base = text.match(/\/base\/([A-Za-z0-9]+)/);
  if (base) return { type: "bitable", objToken: base[1], tableId: (text.match(/[?&]table=(tbl[A-Za-z0-9]+)/) || [])[1] };
  const wiki = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wiki) return { type: "wiki", wikiToken: wiki[1] };
  return null;
}

async function refundTarget() {
  if (targetCache) return targetCache;
  const direct = parseRefundUrl(process.env.FEISHU_REFUND_URL);
  let node;
  if (direct && direct.type !== "wiki") {
    node = { ...direct, title: "" };
  } else {
    const wikiToken = direct?.wikiToken || process.env.FEISHU_REFUND_WIKI_TOKEN || DEFAULT_REFUND_WIKI_TOKEN;
    node = await feishu.resolveWikiNode(wikiToken);
  }
  if (node.type === "sheet") {
    const sheetId = await feishu.firstSheetId(node.objToken, node.sheetId || process.env.FEISHU_REFUND_SHEET_ID);
    const headers = await feishu.sheetHeaders(node.objToken, sheetId);
    targetCache = { kind: "sheet", title: node.title, token: node.objToken, sheetId, columns: mapHeaders(headers) };
  } else if (node.type === "bitable") {
    const tableId = await feishu.firstTableId(node.objToken, node.tableId || process.env.FEISHU_REFUND_TABLE_ID);
    const fields = await feishu.bitableFields(node.objToken, tableId);
    const columns = mapHeaders(fields.map((f) => f.name)).map((c, i) => ({ ...c, type: fields[i].type }));
    targetCache = { kind: "bitable", title: node.title, token: node.objToken, tableId, columns };
  } else {
    const error = new Error(`退款记录页面类型是「${node.type || "未知"}」，目前只支持飞书电子表格和多维表格`);
    error.status = 400;
    throw error;
  }
  return targetCache;
}

async function refundSchema({ refresh } = {}) {
  // Automatic writing only when a direct table link is configured (a wiki page
  // in a personal library is not reachable by apps). Otherwise: copy & paste.
  if (!feishu.isConfigured() || !process.env.FEISHU_REFUND_URL) {
    return { configured: false, columns: REFUND_COLUMNS, sheet_url: REFUND_SHEET_URL };
  }
  if (refresh) targetCache = null;
  const t = await refundTarget();
  return { configured: true, kind: t.kind, title: t.title, columns: t.columns };
}

async function writeRefund(values = {}) {
  const t = await refundTarget();
  const filled = t.columns.filter((c) => c.key && String(values[c.key] ?? "").trim());
  if (!filled.length) {
    const error = new Error("没有任何字段能对应到退款表的列");
    error.status = 400;
    throw error;
  }
  if (t.kind === "sheet") {
    await feishu.sheetAppend(t.token, t.sheetId, t.columns.map((c) => (c.key ? String(values[c.key] ?? "") : "")));
  } else {
    const fields = {};
    t.columns.forEach((c) => {
      if (!c.key) return;
      const v = feishu.bitableValue(c.type, values[c.key]);
      if (v !== undefined) fields[c.header] = v;
    });
    await feishu.bitableCreate(t.token, t.tableId, fields);
  }
  appendLog({ type: "refund", order_id: values.order_id || "", email: values.email || "", ticket: values.ticket || "" });
  return { ok: true, written: filled.map((c) => c.header) };
}

// ─── Refund row (copy & paste into the Feishu sheet) ──────────────────────────
// The refund table sits in a personal "我的文档库" that apps cannot reach, so the
// agent pastes the row. These are the sheet's columns, in order.

const REFUND_COLUMNS = [
  { header: "日期", key: "date" },
  { header: "Number", key: "ticket" }, // ticket number, e.g. #2026111610000285
  { header: "邮箱", key: "email" },
  { header: "产品", key: "product" },
  { header: "退款原因", key: "reason" },
  { header: "退款类型", key: "refund_type" },
  { header: "记录人", key: "agent" },
  { header: "备注", key: "note" }
];

function cleanCell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function refundRow(values = {}) {
  return REFUND_COLUMNS.map((c) => cleanCell(values[c.key])).join("\t");
}

// ─── Credit row (Tencent Docs, pasted by the agent) ───────────────────────────

const CREDIT_COLUMNS = ["日期", "客户邮箱", "有效渠道", "积分", "预留", "链接"];

function creditRow(values = {}) {
  const cells = [
    values.date || today("."),
    values.email || "",
    values.channels || "",
    values.credits || "",
    values.reserved || "",
    // A pasted cell can't contain a raw newline without quoting; keep links on one line.
    String(values.links || "").split(/\s+/).filter(Boolean).join(" ")
  ].map((v) => String(v).replace(/[\t\r\n]+/g, " ").trim());
  return cells.join("\t");
}

module.exports = {
  parseRefundUrl,
  mapHeaders,
  refundSchema,
  writeRefund,
  creditRow,
  refundRow,
  REFUND_COLUMNS,
  CREDIT_COLUMNS,
  findPrevious,
  appendLog,
  today,
  _resetTarget: () => { targetCache = null; }
};
