const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

// Isolate the local record log.
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.EC_RECORDS_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ec-rec-")), "records.jsonl");
const records = require("../lib/records");
const feishu = require("../lib/feishu");

test("mapHeaders: matches Chinese/English headers, purchase date before date", () => {
  const cols = records.mapHeaders(["日期", "工单号", "客户邮箱", "订单号", "产品", "金额(USD)", "支付平台", "购买日期", "退款原因", "处理客服", "状态", "其他"]);
  assert.deepEqual(cols.map((c) => c.key), ["date", "ticket", "email", "order_id", "product", "amount", "provider", "purchase_date", "reason", "agent", "status", null]);
  const en = records.mapHeaders(["Purchase Date", "Date", "Order ID", "Email"]);
  assert.deepEqual(en.map((c) => c.key), ["purchase_date", "date", "order_id", "email"]);
});

test("creditRow: tab-separated, no stray tabs/newlines inside cells", () => {
  const row = records.creditRow({ date: "2026.11.17", email: "a@b.com", channels: "Facebook Twitter", credits: "120", links: "https://f.com/x\nhttps://t.com/y" });
  assert.equal(row, "2026.11.17\ta@b.com\tFacebook Twitter\t120\t\thttps://f.com/x https://t.com/y");
});

function startMock(kind) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
      const ok = (data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: 0, msg: "ok", ...data })); };
      if (req.url.startsWith("/open-apis/auth/")) return ok({ tenant_access_token: "T", expire: 7200 });
      if (req.url.startsWith("/open-apis/wiki/")) return ok({ data: { node: { obj_type: kind, obj_token: "OBJ", title: "退款记录" } } });
      if (req.url.includes("/sheets/query")) return ok({ data: { sheets: [{ sheet_id: "S1" }] } });
      if (req.url.includes("/values/")) return ok({ data: { valueRange: { values: [["日期", "订单号", "金额", "其他列X"]] } } });
      if (req.url.includes("values_append")) return ok({ data: {} });
      if (req.url.endsWith("/tables?page_size=20")) return ok({ data: { items: [{ table_id: "TB" }] } });
      if (req.url.includes("/fields")) return ok({ data: { items: [{ field_name: "日期", type: 5 }, { field_name: "订单号", type: 1 }, { field_name: "金额", type: 2 }] } });
      if (req.url.endsWith("/records")) return ok({ data: {} });
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` })));
}

async function withMock(kind, fn) {
  const mock = await startMock(kind);
  const saved = { ...process.env };
  process.env.FEISHU_API_BASE = mock.base;
  process.env.FEISHU_APP_ID = "id";
  process.env.FEISHU_APP_SECRET = "secret";
  process.env.FEISHU_REFUND_URL = "https://x.feishu.cn/wiki/WIKITOKEN";
  feishu._resetTokenCache();
  records._resetTarget();
  try {
    await fn(mock);
  } finally {
    Object.keys(process.env).forEach((k) => { if (!(k in saved)) delete process.env[k]; });
    Object.assign(process.env, saved);
    mock.server.close();
  }
}

test("refund → Feishu sheet: header order respected, unknown columns blank", async () => {
  await withMock("sheet", async ({ calls }) => {
    const schema = await records.refundSchema();
    assert.equal(schema.kind, "sheet");
    assert.deepEqual(schema.columns.map((c) => c.key), ["date", "order_id", "amount", null]);
    await records.writeRefund({ date: "2026-11-17", order_id: "A1", amount: "USD61.62" });
    const append = calls.find((c) => c.url.includes("values_append"));
    assert.deepEqual(append.body.valueRange.values, [["2026-11-17", "A1", "USD61.62", ""]]);
    assert.equal(append.auth, "Bearer T");
  });
});

test("refund → Feishu bitable: typed values (date ms, number)", async () => {
  await withMock("bitable", async ({ calls }) => {
    await records.writeRefund({ date: "2026-11-17", order_id: "A2", amount: "USD61.62" });
    const create = calls.find((c) => c.url.endsWith("/records"));
    assert.equal(create.body.fields["订单号"], "A2");
    assert.equal(create.body.fields["金额"], 61.62);
    assert.equal(typeof create.body.fields["日期"], "number");
  });
});

test("refund: no direct table link → copy & paste mode with the sheet columns", async () => {
  const saved = { ...process.env };
  process.env.FEISHU_APP_ID = "id";
  process.env.FEISHU_APP_SECRET = "secret";
  delete process.env.FEISHU_REFUND_URL;
  try {
    const schema = await records.refundSchema();
    assert.equal(schema.configured, false);
    assert.deepEqual(schema.columns.map((c) => c.header), ["日期", "Number", "邮箱", "产品", "退款原因", "退款类型", "记录人", "备注"]);
  } finally {
    process.env = saved;
  }
});

test("refundRow: sheet column order, cells cleaned", () => {
  const row = records.refundRow({ date: "2026.11.17", ticket: "Ticket#1", order_id: "A1", email: "a@b.com", reason: "line1\nline2", agent: "Riley", note: "A\t1 · PADDLE" });
  assert.equal(row, "2026.11.17\tTicket#1\ta@b.com\t\tline1 line2\t\tRiley\tA 1 · PADDLE");
});

test("parseRefundUrl: direct sheet/base links skip the wiki lookup", () => {
  assert.deepEqual(records.parseRefundUrl("https://x.feishu.cn/sheets/ShtAbc123?sheet=s9"), { type: "sheet", objToken: "ShtAbc123", sheetId: "s9" });
  assert.deepEqual(records.parseRefundUrl("https://x.feishu.cn/base/BasXyz?table=tblQ1&view=vew1"), { type: "bitable", objToken: "BasXyz", tableId: "tblQ1" });
  assert.deepEqual(records.parseRefundUrl("https://x.feishu.cn/wiki/NDRy?from=navigation"), { type: "wiki", wikiToken: "NDRy" });
  assert.equal(records.parseRefundUrl(""), null);
});

test("refund via direct base URL: no wiki call", async () => {
  await withMock("bitable", async ({ calls }) => {
    process.env.FEISHU_REFUND_URL = "https://x.feishu.cn/base/BasXyz?table=tblQ1";
    records._resetTarget();
    const schema = await records.refundSchema();
    assert.equal(schema.kind, "bitable");
    assert.ok(!calls.some((c) => c.url.includes("/wiki/")));
    assert.ok(calls.some((c) => c.url.includes("/apps/BasXyz/tables/tblQ1/fields")));
  });
});
