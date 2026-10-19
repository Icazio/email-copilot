const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { sendJson, sendText } = require('./lib/helpers');

function loadDotEnv() {
  const file = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (!key || process.env[key]) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}
loadDotEnv();

function resolveProvider() {
  const requested = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (requested === 'mock') return 'mock';
  if (requested === 'deepseek') return process.env.DEEPSEEK_API_KEY ? requested : 'mock';
  if (requested === 'openai') return process.env.OPENAI_API_KEY ? requested : 'mock';
  return process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.OPENAI_API_KEY ? 'openai' : 'mock';
}
const provider = resolveProvider();
const model = provider === 'deepseek' ? process.env.DEEPSEEK_MODEL || process.env.AI_MODEL || 'deepseek-v4-flash' :
  provider === 'openai' ? process.env.OPENAI_MODEL || process.env.AI_MODEL || 'gpt-5-mini' : 'mock-engine';
const { createAdminRouter } = require('./lib/admin-router');
const admin = createAdminRouter({ provider, model });
const parsedPort = Number(process.env.PORT || 8787);
const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort < 65536 ? parsedPort : 8787;
const host = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (await admin.handle(req, res, url)) return;
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, mode: provider, model,
        productCount: admin.store.catalog().length,
        templateCount: admin.store.data.products.reduce((sum,p) => sum + p.published.templates.length, 0),
        requestedProvider: process.env.AI_PROVIDER || null,
        configuredProviders: { deepseek: Boolean(process.env.DEEPSEEK_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY) }
      });
    } else if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, { Location: '/admin/' }); res.end();
    } else sendText(res, 404, 'Not found');
  } catch (error) {
    console.error('Request failed:', error.message);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: '服务处理失败，请检查服务器日志' });
    else res.end();
  }
});
server.headersTimeout = 15000;
server.requestTimeout = 60000;
server.listen(port, host, () => {
  const address = server.address();
  console.log(`Email Copilot backend listening on http://${host}:${address.port}`);
  console.log(`Admin console: http://localhost:${address.port}/admin/`);
  console.log(`Mode: ${provider} (${model})`);
});
