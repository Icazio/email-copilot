const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const kinds = ['knowledge', 'templates', 'rules'];
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, max = 60000) {
  if (typeof value !== 'string' || value.length > max) fail('字段格式不正确或内容过长');
  return value.trim();
}
function strings(value) {
  if (!Array.isArray(value) || value.length > 100) fail('请提供最多 100 项的列表');
  return [...new Set(value.map(v => text(v, 200)).filter(Boolean))];
}
function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) fail('密码长度须为 12–200 个字符');
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 200) return false;
  const [salt, key] = hash.split(':');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), crypto.scryptSync(password, salt, 64));
}
function emptyContent() { return { knowledge: [], templates: [], rules: [] }; }

class AdminStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'admin.json');
    fs.mkdirSync(directory, { recursive: true });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      schema: 1, products: [], users: [], events: [], feedback: [], audit: []
    };
    if (this.data.schema !== 1) throw new Error('Unsupported admin data schema');
  }
  // All writes are synchronous transactions in a single Node process. Rename prevents partial files.
  change(work) {
    const previous = this.data;
    this.data = clone(previous);
    try {
      const result = work(this.data);
      const temporary = this.file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      return clone(result ?? {});
    } catch (error) { this.data = previous; throw error; }
  }
  audit(data, actor, action, productId, detail) {
    data.audit.push({ id: id(), at: now(), actor, action, productId, detail });
  }
  bootstrap(username, password) {
    if (this.data.users.length || !username || !password) return;
    this.createUser({ username, password }, 'server-setup');
  }
  createUser(input, actor) {
    const username = text(input.username, 80);
    if (!/^[a-zA-Z0-9_.@-]{3,80}$/.test(username)) fail('账号须为 3–80 位字母、数字或 _.@-');
    const hash = passwordHash(input.password);
    return this.change(data => {
      if (data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) fail('账号已存在', 409);
      const user = { id: id(), username, hash, enabled: true, createdAt: now() };
      data.users.push(user);
      this.audit(data, actor, 'create-user', null, username);
      return { id: user.id, username };
    });
  }
  authenticate(username, password) {
    const user = this.data.users.find(u => u.username.toLowerCase() === String(username).toLowerCase() && u.enabled);
    // Run scrypt even for unknown users to avoid a fast username oracle.
    const valid = verifyPassword(password, user?.hash || '00000000000000000000000000000000:' + '00'.repeat(64));
    return valid && user ? { id: user.id, username: user.username } : null;
  }
  users() { return this.data.users.map(({ hash, ...u }) => clone(u)); }
  updateUser(userId, input, actor) {
    return this.change(data => {
      const user = data.users.find(u => u.id === userId);
      if (!user) fail('账号不存在', 404);
      if (input.enabled === false && data.users.filter(u => u.enabled).length <= 1 && user.enabled) fail('须保留至少一个管理员');
      if (typeof input.enabled === 'boolean') user.enabled = input.enabled;
      if (input.password) user.hash = passwordHash(input.password);
      this.audit(data, actor, 'update-user', null, user.username);
      return { ok: true };
    });
  }
  product(productId, data = this.data) {
    const p = data.products.find(p => p.id === productId);
    if (!p) fail('产品不存在', 404);
    return p;
  }
  catalog() {
    return this.data.products.filter(p => p.enabled).map(({ id, name, aliases, queues, orderNames }) => ({ id, name, aliases, queues, orderNames }));
  }
  products() {
    return this.data.products.map(p => ({
      id: p.id, name: p.name, aliases: p.aliases, queues: p.queues, orderNames: p.orderNames,
      enabled: p.enabled, revision: p.revision, version: p.version,
      pending: kinds.reduce((n, k) => n + this.pending(p, k).length, 0),
      counts: Object.fromEntries(kinds.map(k => [k, p.draft[k].length]))
    }));
  }
  pending(p, kind) {
    const a = p.draft[kind], b = p.published[kind];
    return [...new Set([...a, ...b].map(e => e.id))].filter(key =>
      JSON.stringify(a.find(e => e.id === key)) !== JSON.stringify(b.find(e => e.id === key))
    );
  }
  saveProduct(input, actor) {
    return this.change(data => {
      const existing = input.id ? this.product(input.id, data) : null;
      if (existing && Number(input.revision) !== existing.revision) fail('产品已被其他管理员修改，请刷新', 409);
      const name = text(input.name, 120);
      if (!name) fail('请填写产品名称');
      if (data.products.some(p => p.id !== input.id && p.name.toLowerCase() === name.toLowerCase())) fail('产品名称已存在', 409);
      const p = existing || { id: id(), revision: 0, version: 0, draft: emptyContent(), published: emptyContent(), history: [] };
      Object.assign(p, { name, enabled: input.enabled !== false, aliases: strings(input.aliases || []),
        queues: strings(input.queues || []), orderNames: strings(input.orderNames || []) });
      if (!existing) {
        if (input.copyFrom) p.draft = clone(this.product(input.copyFrom, data).published);
        data.products.push(p);
      }
      p.revision++;
      this.audit(data, actor, existing ? 'update-product' : 'create-product', p.id, name);
      return { id: p.id };
    });
  }
  content(productId) {
    const p = this.product(productId);
    return clone({ ...p, history: p.history.map(({ snapshot, ...h }) => h),
      pending: Object.fromEntries(kinds.map(k => [k, this.pending(p, k)])) });
  }
  validateEntry(kind, input) {
    if (!kinds.includes(kind)) fail('内容类型不存在');
    const title = text(input.title, 200);
    if (!title) fail('请填写标题');
    const entry = { id: input.id ? text(input.id, 100) : id(), title, category: text(input.category || 'general', 100),
      content: text(input.content || ''), tags: strings(input.tags || []), enabled: input.enabled !== false };
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.id)) fail('内容标识格式不正确');
    if (!entry.content) fail('请填写正文');
    if (kind === 'knowledge') entry.internal = text(input.internal || '');
    if (kind === 'templates') {
      entry.conditions = text(input.conditions || '', 2000);
      entry.fixed = strings(input.fixed || []);
      const variables = [...entry.content.matchAll(/\{\{([a-zA-Z_][\w]*)\}\}/g)].map(m => m[1]);
      entry.variables = [...new Set(variables)];
      if (entry.fixed.some(s => !entry.content.includes(s))) fail('固定表述必须包含在模板正文中');
    }
    if (kind === 'rules') {
      if (!['all', 'analyze-thread', 'generate-draft', 'refine-draft', 'chat'].includes(input.stage)) fail('请选择规则作用环节');
      entry.stage = input.stage;
    }
    return entry;
  }
  saveEntry(productId, kind, input, revision, actor) {
    const entry = this.validateEntry(kind, input);
    return this.change(data => {
      const p = this.product(productId, data);
      if (Number(revision) !== p.revision) fail('内容已被修改，请刷新后重试', 409);
      const index = p.draft[kind].findIndex(e => e.id === entry.id);
      entry.updatedAt = now(); entry.updatedBy = actor;
      if (index < 0) p.draft[kind].push(entry); else p.draft[kind][index] = entry;
      p.revision++;
      this.audit(data, actor, 'save-' + kind, p.id, entry.title);
      return { id: entry.id, revision: p.revision };
    });
  }
  deleteEntry(productId, kind, entryId, revision, actor) {
    if (!kinds.includes(kind)) fail('内容类型不存在');
    return this.change(data => {
      const p = this.product(productId, data);
      if (Number(revision) !== p.revision) fail('内容已被修改，请刷新后重试', 409);
      const entry = p.draft[kind].find(e => e.id === entryId);
      if (!entry) fail('内容不存在', 404);
      p.draft[kind] = p.draft[kind].filter(e => e.id !== entryId); p.revision++;
      this.audit(data, actor, 'delete-' + kind, p.id, entry.title);
      return { ok: true };
    });
  }
  publish(productId, input, actor) {
    return this.change(data => {
      const p = this.product(productId, data);
      if (Number(input.revision) !== p.revision) fail('内容已变化，请重新检查待发布修改', 409);
      if (!Array.isArray(input.items) || !input.items.length) fail('请选择待发布修改');
      const snapshot = clone(p.published);
      for (const item of input.items) {
        if (!kinds.includes(item.kind) || !this.pending(p, item.kind).includes(item.id)) fail('所选修改不存在或已发布');
        const source = p.draft[item.kind].find(e => e.id === item.id);
        snapshot[item.kind] = snapshot[item.kind].filter(e => e.id !== item.id);
        if (source) snapshot[item.kind].push(clone(source));
      }
      p.published = snapshot; p.version++; p.revision++;
      const release = { version: p.version, at: now(), actor, note: text(input.note || '', 1000), snapshot: clone(snapshot) };
      p.history.push(release);
      this.audit(data, actor, 'publish', p.id, '版本 ' + p.version + ' · ' + release.note);
      return { version: p.version };
    });
  }
  restore(productId, input, actor) {
    return this.change(data => {
      const p = this.product(productId, data);
      if (Number(input.revision) !== p.revision) fail('内容已变化，请刷新', 409);
      if (kinds.some(k => this.pending(p, k).length)) fail('有未发布草稿，请先处理草稿再恢复版本', 409);
      const release = p.history.find(h => h.version === Number(input.version));
      if (!release) fail('版本不存在', 404);
      p.draft = clone(release.snapshot); p.published = clone(release.snapshot); p.version++; p.revision++;
      p.history.push({ version: p.version, at: now(), actor, note: '恢复自版本 ' + release.version, snapshot: clone(p.published) });
      this.audit(data, actor, 'restore', p.id, '恢复自版本 ' + release.version);
      return { version: p.version };
    });
  }
  importLegacy(root, actor) {
    if (this.data.products.length) fail('已有产品，不能重复导入；请新建产品或复制内容', 409);
    const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    return this.change(data => {
      const content = emptyContent();
      for (const file of ['knowledge/products.json', 'knowledge/policies.json']) {
        for (const entry of read(file).entries) content.knowledge.push({ ...entry, category: 'general', internal: '', enabled: true });
      }
      for (const file of fs.readdirSync(path.join(root, 'templates')).filter(f => f.endsWith('.json'))) {
        const t = read('templates/' + file);
        content.templates.push({ id: t.id, title: t.id, category: t.scene, content: [t.opening, ...(t.body_guidance || []), t.closing].filter(Boolean).join('\n\n'), tags: [t.scene], enabled: true, conditions: t.sub_scene || '', fixed: [], variables: [] });
      }
      const prompt = read('backend/prompts/system-instructions.json');
      content.rules.push({ id: id(), title: '基础处理规则', category: 'general', content: [prompt.base.role, prompt.base.task, prompt.base.scope, ...prompt.base.constraints].join('\n'), stage: 'all', tags: [], enabled: true });
      content.rules.push({ id: id(), title: '问题分类规则', category: 'general', content: Object.entries(prompt.categories).map(([k,v]) => `${k}: ${v}`).join('\n'), stage: 'all', tags: [], enabled: true });
      for (const [file, title] of [
        ['guidance.json', '各问题类型处理指引'], ['questions.json', '补充信息与追问'],
        ['classification-rules.json', '分类匹配说明'], ['issue-types.json', '问题子类型说明'],
        ['free-credit-config.json', '社交平台积分与核验规则'], ['summaries.json', '摘要参考']
      ]) {
        content.rules.push({ id: id(), title, category: 'general', content: JSON.stringify(read('backend/prompts/' + file), null, 2), stage: 'all', tags: [], enabled: true });
      }
      const draftTemplates = read('backend/prompts/draft-templates.json');
      function importTemplates(value, keys = []) {
        if (typeof value === 'string') {
          if (keys[keys.length - 1] === 'customer_need') return;
          // Single-brace legacy variables become editable double-brace variables.
          const body = value.replace(/\{([a-zA-Z_][\w]*)\}/g, '{{$1}}');
          content.templates.push({ id: id(), title: '原有话术 · ' + keys.join(' / '), category: keys[0] === 'generic_support' ? 'general' : keys[0], content: body,
            tags: keys, enabled: true, conditions: keys.slice(1).join(' / '), fixed: [], variables: [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))] });
        } else for (const [key, child] of Object.entries(value)) importTemplates(child, [...keys, key]);
      }
      importTemplates(draftTemplates);
      const p = { id: id(), name: 'AVCLabs（原有内容，待细分）', aliases: [], queues: [], orderNames: [], enabled: true,
        revision: 1, version: 0, draft: content, published: emptyContent(), history: [] };
      data.products.push(p);
      this.audit(data, actor, 'import-legacy', p.id, '原有文件导入为草稿；须检查产品适用范围及内部说明后发布');
      return { id: p.id };
    });
  }
  resolveProduct(input) {
    const products = this.catalog();
    if (input.product_id) {
      const chosen = products.find(p => p.id === input.product_id);
      if (!chosen) fail('产品不存在或已停用', 400);
      return { product: chosen, source: 'manual', reason: '客服选择', candidates: [chosen.id] };
    }
    const thread = [input.subject, input.thread_text, input.thread_context?.subject, input.thread_context?.thread_text, input.thread_structured?.active_article_body].filter(Boolean).join('\n');
    const order = String(input.order_context || input.manual_lookup_result || '');
    const includes = (haystack, needle) => {
      const value = needle.trim().toLowerCase();
      if (!value) return false;
      const source = haystack.toLowerCase();
      if (/^[a-z0-9 _.-]+$/i.test(value)) {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp('(^|[^a-z0-9])' + escaped + '($|[^a-z0-9])', 'i').test(source);
      }
      return source.includes(value);
    };
    const byThread = products.filter(p => [p.name, ...p.aliases].some(n => includes(thread, n)));
    const byOrder = products.filter(p => [p.name, ...p.aliases, ...p.orderNames].some(n => includes(order, n)));
    const mentioned = [...new Set([...byThread, ...byOrder].map(p => p.id))];
    if (mentioned.length === 1) {
      return { product: products.find(p => p.id === mentioned[0]), source: byOrder.length ? 'order' : 'email',
        reason: byOrder.length ? '根据订单商品识别' : '根据邮件内容识别', candidates: mentioned };
    }
    if (mentioned.length > 1) return { product: null, reason: '邮件或订单涉及多个产品，请选择主要产品', candidates: mentioned };
    const queued = products.filter(p => p.queues.some(q => q.toLowerCase() === String(input.queue || '').trim().toLowerCase()));
    if (queued.length === 1) return { product: queued[0], source: 'queue', reason: '根据工单队列识别', candidates: [queued[0].id] };
    return { product: null, reason: '无法确定产品，请选择主要产品', candidates: queued.map(p => p.id) };
  }
  recordEvent(input) {
    return this.change(data => { const event = { ...clone(input), id: id(), at: now(), feedbackKey: crypto.randomBytes(24).toString('hex') }; data.events.push(event); return event; });
  }
  recordFeedback(input) {
    if (!['satisfied', 'neutral', 'unsatisfied', ''].includes(input.satisfaction || '') || !['accurate', 'partial', 'inaccurate', 'unknown', ''].includes(input.accuracy || '')) fail('评价选项不正确');
    if (!input.satisfaction && !input.accuracy) fail('请至少填写一项评价');
    return this.change(data => {
      const event = data.events.find(e => e.id === input.event_id && e.feedbackKey === input.feedback_key);
      if (!event) fail('结果不存在或评价凭证无效', 404);
      const previous = data.feedback.find(f => f.eventId === event.id);
      const f = { id: previous?.id || id(), eventId: event.id, at: now(), satisfaction: input.satisfaction || '', accuracy: input.accuracy || '',
        reason: text(input.reason || '', 200), note: text(input.note || '', 2000) };
      if (previous) Object.assign(previous, f); else data.feedback.push(f);
      return { ok: true };
    });
  }
  dashboard({ days = 7, product = '' } = {}) {
    const countDays = Number(days);
    if (![7, 30, 90].includes(countDays)) fail('时间范围须为 7、30 或 90 天');
    // Asia/Shanghai business dates, independent of the server's OS timezone.
    const day = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0,10);
    const today = day(now());
    const dates = Array.from({ length: countDays }, (_, i) => day(Date.now() - (countDays - 1 - i) * 86400000));
    const events = this.data.events.filter(e => day(e.at) >= dates[0] && day(e.at) <= today && (!product || e.productId === product));
    const ids = new Set(events.map(e => e.id));
    const feedback = this.data.feedback.filter(f => ids.has(f.eventId));
    const satisfaction = feedback.filter(f => f.satisfaction);
    const accuracy = feedback.filter(f => f.accuracy && f.accuracy !== 'unknown');
    const ticketKey = e => e.ticketId;
    const tickets = new Set(events.map(ticketKey));
    const evaluatedTickets = new Set(events.filter(e => feedback.some(f => f.eventId === e.id)).map(ticketKey));
    const ratio = (a,b) => b ? Math.round(a / b * 1000) / 10 : null;
    const named = e => this.data.products.find(p => p.id === e.productId)?.name || '已移除产品';
    return {
      tickets: tickets.size, generations: events.filter(e => ['generate-draft','refine-draft','chat'].includes(e.action)).length,
      analyses: events.filter(e => e.action === 'analyze-thread').length, evaluations: feedback.length,
      evaluatedTickets: evaluatedTickets.size, coverage: ratio(evaluatedTickets.size, tickets.size),
      satisfaction: ratio(satisfaction.filter(f => f.satisfaction === 'satisfied').length, satisfaction.length), satisfactionCount: satisfaction.length,
      accuracy: ratio(accuracy.filter(f => f.accuracy === 'accurate').length, accuracy.length), accuracyCount: accuracy.length,
      unknown: feedback.filter(f => f.accuracy === 'unknown').length,
      distribution: Object.fromEntries(['satisfied','neutral','unsatisfied'].map(key => [key, satisfaction.filter(f => f.satisfaction === key).length])),
      trend: dates.map(date => ({ date, tickets: new Set(events.filter(e => day(e.at) === date).map(ticketKey)).size })),
      byProduct: this.data.products.filter(p => !product || p.id === product).map(p => ({ name: p.name,
        tickets: new Set(events.filter(e => e.productId === p.id).map(ticketKey)).size })),
      feedback: feedback.slice().reverse().map(f => { const e = events.find(e => e.id === f.eventId); return { ...f, product: named(e), category: e.category, version: e.version }; }),
      timezone: 'Asia/Shanghai'
    };
  }
  feedbackDetail(feedbackId) {
    const f = this.data.feedback.find(f => f.id === feedbackId);
    if (!f) fail('反馈不存在', 404);
    const { feedbackKey, ...event } = this.data.events.find(e => e.id === f.eventId);
    return clone({ feedback: f, event });
  }
}
module.exports = { AdminStore, fail, kinds };
