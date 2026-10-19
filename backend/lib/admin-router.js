const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AdminStore, fail } = require('./admin-store');
const { ManagedEngine } = require('./managed-engine');
const { sendJson, readJsonBody } = require('./helpers');

function createAdminRouter({ directory, provider, model, completion } = {}) {
  const store = new AdminStore(directory || process.env.ADMIN_DATA_DIR || path.resolve(__dirname, '../data'));
  store.bootstrap(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
  const engine = new ManagedEngine(store, { provider, model, completion });
  const sessions = new Map(), attempts = new Map();
  const assets = path.resolve(__dirname, '../admin');
  const token = process.env.COPILOT_ACCESS_TOKEN || '';
  const hash = value => crypto.createHash('sha256').update(value).digest();
  const secure = process.env.ADMIN_SECURE_COOKIE === 'true';
  const host = process.env.HOST || '127.0.0.1';
  const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.ADMIN_ORIGIN && !secure && process.env.NODE_ENV !== 'production';
  if (!token && !localOnly) throw new Error('公司服务器部署须配置 COPILOT_ACCESS_TOKEN');
  function session(req) {
    const cookie = String(req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('copilot_admin='));
    const key = cookie?.slice('copilot_admin='.length);
    const found = key && sessions.get(key);
    if (!found || found.expires < Date.now() || !store.data.users.some(u => u.id === found.user.id && u.enabled)) {
      if (key) sessions.delete(key);
      return null;
    }
    return found;
  }
  function cookie(res, value, age = 28800) {
    res.setHeader('Set-Cookie', `copilot_admin=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`);
  }
  function checkOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') fail('不允许跨站后台操作', 403);
    if (req.headers.origin) {
      const expected = process.env.ADMIN_ORIGIN;
      const origin = new URL(req.headers.origin);
      if (expected ? origin.origin !== new URL(expected).origin : origin.host !== req.headers.host) fail('请求来源不允许', 403);
    }
  }
  function requireCopilot(req) {
    const extensionOrigin = /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(String(req.headers.origin || ''));
    const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
    // Explicit plugin credentials take precedence; an incidental browser cookie
    // must neither trigger admin origin checks nor bypass an invalid access key.
    if (token && req.headers.authorization) {
      if (!crypto.timingSafeEqual(hash(supplied), hash(token))) fail('助手访问密钥无效，请在插件 Config 中配置', 401);
      return;
    }
    if (!extensionOrigin && session(req)) { checkOrigin(req); return; }
    if (token) {
      fail('助手访问密钥无效，请在插件 Config 中配置', 401);
    } else {
      if (!localOnly) fail('助手访问密钥未配置', 503);
      const remote = req.socket.remoteAddress;
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)) fail('公司服务器须配置 COPILOT_ACCESS_TOKEN', 503);
      if (req.headers.origin && !extensionOrigin) checkOrigin(req);
    }
  }
  async function handle(req, res, url) {
    const pathname = url.pathname;
    const isAdmin = pathname.startsWith('/api/admin/');
    const isCopilot = pathname.startsWith('/api/copilot/');
    const isAI = ['/chat','/analyze-thread','/generate-draft','/refine-draft','/extract-fields'].includes(pathname);
    if (!pathname.startsWith('/admin') && !isAdmin && !isCopilot && !isAI) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (isCopilot || isAI) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    }
    try {
      if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/app.js' || pathname === '/admin/style.css') {
        if (req.method !== 'GET') fail('不支持的请求方法', 405);
        const file = pathname.endsWith('app.js') ? 'app.js' : pathname.endsWith('style.css') ? 'style.css' : 'index.html';
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(assets,file))); return true;
      }
      if (isAdmin) {
        const current = session(req);
        if (req.method === 'GET' && pathname === '/api/admin/session') {
          sendJson(res, 200, { user: current?.user || null, csrf: current?.csrf || null, needsSetup: !store.data.users.length, mode: provider, model }); return true;
        }
        if (req.method === 'POST') checkOrigin(req);
        if (req.method === 'POST' && pathname === '/api/admin/login') {
          const key = req.socket.remoteAddress;
          // One bounded entry per remote address, with periodic expiry cleanup.
          for (const [k,v] of attempts) if (v.until < Date.now()) attempts.delete(k);
          const attempt = attempts.get(key) || { count: 0, until: Date.now() + 15 * 60000 };
          if (attempt.count >= 10) fail('尝试次数过多，请 15 分钟后重试', 429);
          const input = await readJsonBody(req);
          attempt.count++; attempts.set(key, attempt);
          const user = store.authenticate(input.username, input.password);
          if (!user) fail('账号或密码不正确', 401);
          attempts.delete(key);
          for (const [k,s] of sessions) if (s.expires < Date.now()) sessions.delete(k);
          const keyValue = crypto.randomBytes(32).toString('hex');
          const csrf = crypto.randomBytes(24).toString('hex');
          sessions.set(keyValue, { user, csrf, expires: Date.now() + 8 * 3600000 }); cookie(res, keyValue);
          sendJson(res, 200, { user, csrf }); return true;
        }
        if (!current) fail('请先登录管理后台', 401);
        if (!['GET', 'POST'].includes(req.method)) fail('不支持的请求方法', 405);
        if (req.method === 'POST' && req.headers['x-csrf-token'] !== current.csrf) fail('页面凭证已失效，请刷新', 403);
        const actor = current.user.username;
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        let result;
        if (pathname === '/api/admin/logout' && req.method === 'POST') {
          for (const [k,s] of sessions) if (s === current) sessions.delete(k);
          cookie(res, '', 0); result = { ok: true };
        } else if (pathname === '/api/admin/products') result = req.method === 'GET' ? store.products() : store.saveProduct(body, actor);
        else if (pathname === '/api/admin/import-legacy' && req.method === 'POST') result = store.importLegacy(path.resolve(__dirname,'../..'), actor);
        else if (pathname === '/api/admin/content' && req.method === 'GET') result = store.content(url.searchParams.get('product'));
        else if (pathname === '/api/admin/version' && req.method === 'GET') {
          const p = store.product(url.searchParams.get('product'));
          const release = p.history.find(h => h.version === Number(url.searchParams.get('version')));
          if (!release) fail('版本不存在', 404);
          result = release;
        }
        else if (pathname === '/api/admin/entry' && req.method === 'POST') result = store.saveEntry(body.product, body.kind, body.entry, body.revision, actor);
        else if (pathname === '/api/admin/delete-entry' && req.method === 'POST') result = store.deleteEntry(body.product, body.kind, body.id, body.revision, actor);
        else if (pathname === '/api/admin/publish' && req.method === 'POST') result = store.publish(body.product, body, actor);
        else if (pathname === '/api/admin/restore' && req.method === 'POST') result = store.restore(body.product, body, actor);
        else if (pathname === '/api/admin/dashboard' && req.method === 'GET') result = store.dashboard({ days: url.searchParams.get('days') || 7, product: url.searchParams.get('product') || '' });
        else if (pathname === '/api/admin/feedback' && req.method === 'GET') result = store.feedbackDetail(url.searchParams.get('id'));
        else if (pathname === '/api/admin/users') {
          result = req.method === 'GET' ? store.users() : body.id ? store.updateUser(body.id, body, actor) : store.createUser(body, actor);
          if (req.method === 'POST' && body.id) for (const [k,s] of sessions) if (s.user.id === body.id) sessions.delete(k);
        } else if (pathname === '/api/admin/audit' && req.method === 'GET') result = store.data.audit.slice(-200).reverse();
        else if (pathname === '/api/admin/test' && req.method === 'POST') {
          if (!String(body.thread_text || '').trim()) fail('请粘贴邮件内容');
          result = await engine.run(body.action || 'generate-draft', body, { preview: true, draft: body.draft === true });
        } else fail('接口不存在', 404);
        sendJson(res, 200, result); return true;
      }
      requireCopilot(req);
      if (pathname === '/api/copilot/products' && req.method === 'GET') { sendJson(res, 200, store.catalog()); return true; }
      if (req.method !== 'POST') fail('接口不存在', 404);
      const body = await readJsonBody(req);
      if (pathname === '/api/copilot/resolve-product') sendJson(res, 200, store.resolveProduct(body));
      else if (pathname === '/api/copilot/feedback') sendJson(res, 200, store.recordFeedback(body));
      else if (isAI && pathname !== '/extract-fields') sendJson(res, 200, await engine.run(pathname.slice(1), body));
      else if (pathname === '/extract-fields') {
        const { extractFieldsMock } = require('./mock-engine');
        sendJson(res, 200, extractFieldsMock(body));
      } else fail('接口不存在', 404);
      return true;
    } catch (error) {
      if (!error.status && !(error instanceof SyntaxError)) console.error('Admin/Copilot request failed:', error.message);
      const status = error.status || (error instanceof SyntaxError ? 400 : error.name === 'TimeoutError' ? 504 : 500);
      sendJson(res, status, { error: status === 500 ? '服务处理失败，请检查服务器日志' : error instanceof SyntaxError ? 'JSON 格式不正确' : error.message });
      return true;
    }
  }
  return { handle, store, engine };
}
module.exports = { createAdminRouter };
