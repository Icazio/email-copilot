// Minimal Feishu (Lark) Open Platform client: append a row to a sheet or a
// record to a bitable that lives in a wiki page. Zero dependencies (fetch).
//
// Setup (Feishu Open Platform → 企业自建应用):
//   - permissions: wiki:wiki:readonly, sheets:spreadsheet, bitable:app
//   - publish a version, then add the app to the wiki page (… → 添加文档应用)
//   - .env: FEISHU_APP_ID, FEISHU_APP_SECRET

function config() {
  return {
    base: (process.env.FEISHU_API_BASE || "https://open.feishu.cn").replace(/\/+$/, ""),
    appId: process.env.FEISHU_APP_ID || "",
    appSecret: process.env.FEISHU_APP_SECRET || ""
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.appId && c.appSecret);
}

let tokenCache = { token: "", expiresAt: 0 };

async function call(method, path, { body, token } = {}) {
  const { base } = config();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code !== undefined && data.code !== 0)) {
    const error = new Error(`飞书接口出错（${path.split("?")[0]}）：${data.msg || res.statusText} [code ${data.code ?? res.status}]`);
    error.status = 502;
    throw error;
  }
  return data;
}

async function tenantToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const { appId, appSecret } = config();
  if (!appId || !appSecret) {
    const error = new Error("未配置飞书应用：请在 .env 中设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
    error.status = 400;
    throw error;
  }
  const data = await call("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
    body: { app_id: appId, app_secret: appSecret }
  });
  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + (Number(data.expire || 7200) - 300) * 1000 };
  return tokenCache.token;
}

// Wiki page → the underlying sheet / bitable.
async function resolveWikiNode(wikiToken) {
  const token = await tenantToken();
  const data = await call("GET", `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`, { token });
  const node = data.data?.node || {};
  return { type: node.obj_type, objToken: node.obj_token, title: node.title || "" };
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(cellText).join("");
  if (typeof value === "object") return String(value.text || value.name || "");
  return String(value);
}

// ─── Sheets ───────────────────────────────────────────────────────────────────

async function firstSheetId(spreadsheetToken, preferred) {
  if (preferred) return preferred;
  const token = await tenantToken();
  const data = await call("GET", `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`, { token });
  const sheet = (data.data?.sheets || [])[0];
  if (!sheet) throw new Error("飞书表格里没有工作表");
  return sheet.sheet_id;
}

async function sheetHeaders(spreadsheetToken, sheetId) {
  const token = await tenantToken();
  const range = encodeURIComponent(`${sheetId}!A1:Z1`);
  const data = await call("GET", `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`, { token });
  const row = data.data?.valueRange?.values?.[0] || [];
  return row.map((v) => cellText(v).trim());
}

async function sheetAppend(spreadsheetToken, sheetId, values) {
  const token = await tenantToken();
  const lastCol = String.fromCharCode(64 + Math.max(1, Math.min(26, values.length)));
  return call("POST", `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_append?insertDataOption=INSERT_ROWS`, {
    token,
    body: { valueRange: { range: `${sheetId}!A1:${lastCol}1`, values: [values] } }
  });
}

// ─── Bitable ──────────────────────────────────────────────────────────────────

async function firstTableId(appToken, preferred) {
  if (preferred) return preferred;
  const token = await tenantToken();
  const data = await call("GET", `/open-apis/bitable/v1/apps/${appToken}/tables?page_size=20`, { token });
  const table = (data.data?.items || [])[0];
  if (!table) throw new Error("飞书多维表格里没有数据表");
  return table.table_id;
}

async function bitableFields(appToken, tableId) {
  const token = await tenantToken();
  const data = await call("GET", `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`, { token });
  return (data.data?.items || []).map((f) => ({ name: f.field_name, type: f.type }));
}

// Bitable field types: 1 text, 2 number, 3 single select, 5 date, 11 person…
function bitableValue(type, value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (type === 2) {
    const n = Number(text.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 5) {
    const t = Date.parse(text.replace(/\./g, "-"));
    return Number.isFinite(t) ? t : undefined;
  }
  if (type === 4) return text.split(/[,，]/).map((s) => s.trim()).filter(Boolean); // multi select
  return text;
}

async function bitableCreate(appToken, tableId, fields) {
  const token = await tenantToken();
  return call("POST", `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, { token, body: { fields } });
}

module.exports = {
  isConfigured,
  resolveWikiNode,
  firstSheetId,
  sheetHeaders,
  sheetAppend,
  firstTableId,
  bitableFields,
  bitableValue,
  bitableCreate,
  _resetTokenCache: () => { tokenCache = { token: "", expiresAt: 0 }; }
};
