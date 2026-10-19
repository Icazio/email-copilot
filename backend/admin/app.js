'use strict';
// Local Markdown renderer: escapes source HTML and permits only safe link schemes.
// The knowledge source remains Markdown; only the presentation is converted to HTML.
function renderMarkdown(source) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function inline(value, depth = 0) {
    if (depth > 8) return escape(value);
    let html = '', i = 0;
    while (i < value.length) {
      const rest = value.slice(i);
      if (value[i] === '\\' && /[\\`*{}\[\]()#+.!_>~|\-]/.test(value[i + 1] || '')) { html += escape(value[i + 1]); i += 2; continue; }
      if (value[i] === '`') {
        const ticks = rest.match(/^`+/)[0], end = value.indexOf(ticks, i + ticks.length);
        if (end >= 0) { html += '<code>' + escape(value.slice(i + ticks.length, end)) + '</code>'; i = end + ticks.length; continue; }
      }
      const image = rest.match(/^!\[([^\]\n]*)\]\(([^\n]*?)\)/);
      if (image) { html += escape(image[1]); i += image[0].length; continue; }
      const link = rest.match(/^\[([^\]\n]+)\]\(([^\s()]+)(?:\s+"([^"\n]*)")?\)/);
      if (link) {
        const url = link[2];
        const safe = /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i.test(url) && !/[\u0000-\u0020\u007f\\]/.test(url);
        html += safe ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer"${link[3] ? ` title="${escape(link[3])}"` : ''}>${inline(link[1], depth + 1)}</a>` : inline(link[1], depth + 1);
        i += link[0].length; continue;
      }
      let matched = false;
      for (const [delimiter, tag] of [['**','strong'],['__','strong'],['~~','del'],['*','em'],['_','em']]) {
        if (!rest.startsWith(delimiter)) continue;
        if (delimiter === '_' && /[\p{L}\p{N}]/u.test(value[i - 1] || '')) continue;
        const end = value.indexOf(delimiter, i + delimiter.length);
        if (end <= i + delimiter.length) continue;
        html += `<${tag}>${inline(value.slice(i + delimiter.length, end), depth + 1)}</${tag}>`;
        i = end + delimiter.length; matched = true; break;
      }
      if (matched) continue;
      html += escape(value[i++]);
    }
    return html;
  }
  function cells(line) {
    let input = line.trim();
    if (input.startsWith('|')) input = input.slice(1);
    if (input.endsWith('|') && !input.endsWith('\\|')) input = input.slice(0,-1);
    const result = []; let cell = '', code = false;
    for (let i = 0; i < input.length; i++) {
      if (input[i] === '\\' && input[i + 1] === '|') { cell += '|'; i++; }
      else if (input[i] === '`') { code = !code; cell += input[i]; }
      else if (input[i] === '|' && !code) { result.push(cell.trim()); cell = ''; }
      else cell += input[i];
    }
    result.push(cell.trim()); return result;
  }
  const listMatch = line => line.match(/^( *)([-+*]|\d+[.)])\s+(.*)$/);
  const fenceMatch = line => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const hr = line => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
  function blocks(lines, depth = 0) {
    if (depth > 12) return '<p>' + lines.map(escape).join('<br>') + '</p>';
    const output = []; let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = fenceMatch(line);
      if (fence) {
        const code = []; i++;
        const closing = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
        while (i < lines.length && !closing.test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        output.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>'); continue;
      }
      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) { const level = heading[1].length; output.push(`<h${level}>${inline(heading[2])}</h${level}>`); i++; continue; }
      if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1])) {
        const level = lines[i + 1].trim()[0] === '=' ? 1 : 2;
        output.push(`<h${level}>${inline(line.trim())}</h${level}>`); i += 2; continue;
      }
      if (hr(line)) { output.push('<hr>'); i++; continue; }
      if (/^ {0,3}>/.test(line)) {
        const quote = []; while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/,''));
        output.push('<blockquote>' + blocks(quote, depth + 1) + '</blockquote>'); continue;
      }
      if (line.includes('|') && i + 1 < lines.length) {
        const header = cells(line), separators = cells(lines[i + 1]);
        if (header.length === separators.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
          const aligns = separators.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
          const row = (values, tag) => '<tr>' + header.map((_, index) => `<${tag} class="md-align-${aligns[index]}">${inline(values[index] || '')}</${tag}>`).join('') + '</tr>';
          const rows = []; i += 2;
          while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(row(cells(lines[i++]),'td'));
          output.push('<div class="md-table"><table><thead>' + row(header,'th') + '</thead><tbody>' + rows.join('') + '</tbody></table></div>'); continue;
        }
      }
      const list = listMatch(line);
      if (list) {
        const indent = list[1].length, ordered = /^\d/.test(list[2]), items = [];
        while (i < lines.length) {
          const item = listMatch(lines[i]);
          if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
          const body = [item[3]], prefix = item[0].length - item[3].length; i++;
          while (i < lines.length) {
            if (!lines[i].trim()) {
              if (i + 1 < lines.length && (lines[i + 1].match(/^ */)[0].length > indent || listMatch(lines[i + 1])?.[1].length === indent)) { body.push(''); i++; continue; }
              break;
            }
            const leading = lines[i].match(/^ */)[0].length;
            if (leading <= indent) break;
            body.push(lines[i++].slice(Math.min(prefix, leading)));
          }
          let task = '';
          if (/^\[[ xX]\]\s+/.test(body[0])) {
            task = `<input type="checkbox" disabled${/^\[[xX]\]/.test(body[0]) ? ' checked' : ''} aria-label="任务状态"> `;
            body[0] = body[0].replace(/^\[[ xX]\]\s+/, '');
          }
          items.push('<li>' + task + blocks(body, depth + 1) + '</li>');
        }
        const tag = ordered ? 'ol' : 'ul';
        const start = ordered ? Math.min(Number.parseInt(list[2], 10), 1000000) : 1;
        output.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>`); continue;
      }
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !fenceMatch(lines[i]) && !/^ {0,3}(?:#{1,6}\s|>)/.test(lines[i]) && !hr(lines[i]) && !listMatch(lines[i])) {
        if (i + 1 < lines.length && (lines[i].includes('|') && cells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell)) || /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]))) break;
        paragraph.push(lines[i++]);
      }
      output.push('<p>' + paragraph.map(text => inline(text.replace(/ {2,}$/, ''))).join('<br>') + '</p>');
    }
    return output.join('\n');
  }
  return blocks(String(source || '').replace(/\r\n?/g,'\n').replace(/\t/g,'    ').split('\n'));
}
if (typeof module !== 'undefined' && module.exports) module.exports = { renderMarkdown };
if (typeof document !== 'undefined') {
const root = document.getElementById('root');
const modal = document.getElementById('modal');
const titles = { dashboard: '服务总览', products: '产品管理', knowledge: '业务知识', templates: '回复模板', rules: 'AI 处理规则', test: '测试工作台', history: '发布与历史', settings: '账号与设置' };
const symbols = ['◫','◇','▤','▧','✳','▷','↺','⚙'];
const kindNames = { knowledge: '业务知识', templates: '回复模板', rules: 'AI 规则' };
const categoryNames = { general: '通用', refund: '退款', cancel_renewal: '取消续订', account: '账号与授权', technical: '技术问题', invoice: '发票', free_credit: '免费积分' };
const feedbackNames = { satisfied: '满意', neutral: '一般', unsatisfied: '不满意', accurate: '准确', partial: '部分准确', inaccurate: '不准确', unknown: '无法判断' };
const state = { user: null, csrf: '', products: [], page: 'dashboard', product: '', selected: '', content: null, days: '7', filterProduct: '', dirty: false, testResults: {}, testTab: 'reply' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = value => value === null ? '—' : value + '%';
const date = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function toast(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 4500); }
async function api(url, body) {
  const response = await fetch('/api/admin/' + url, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('login')) { state.user = null; login(); }
    throw new Error(data.error || '请求失败');
  }
  return data;
}
function bind(id, type, fn) {
  const element = document.getElementById(id);
  if (element) element.addEventListener(type, async event => {
    try { await fn(event); } catch (error) { toast(error.message); }
  });
}
function options(items, selected) { return items.map(([value,label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join(''); }
function productOptions(selected, all = false) { return options([...(all ? [['','全部产品']] : [['','请选择产品']]), ...state.products.map(p => [p.id,p.name + (p.enabled ? '' : '（已停用）')])], selected); }
function heading(title, description, controls = '') { return `<div class="page-heading"><div><div class="eyebrow">EMAIL COPILOT / WORKSPACE</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="controls">${controls}</div></div>`; }
function productSelect() { return `<label class="visually-hidden" for="productSelect">当前产品</label><select id="productSelect">${productOptions(state.product)}</select>`; }
function showDialog(html) { modal.innerHTML = html; modal.showModal(); modal.querySelectorAll('[data-close]').forEach(el => el.onclick = () => modal.close()); }
function allowLeave() { return !state.dirty || confirm('当前有尚未保存的编辑，确定离开吗？'); }
async function refreshProducts() {
  state.products = await api('products');
  if (!state.products.some(p => p.id === state.product)) state.product = state.products[0]?.id || '';
}
async function init() {
  const session = await api('session'); state.user = session.user; state.csrf = session.csrf || ''; state.mode = session.mode; state.model = session.model; state.needsSetup = session.needsSetup;
  if (!state.user) return login();
  await refreshProducts(); await render();
}
function login() {
  root.innerHTML = `<main class="login"><div class="login-card"><div class="brand"><span class="brand-mark">✳</span>Email Copilot</div><h1>让每一次回复更有依据</h1><p>登录知识与服务质量管理后台</p>${state.needsSetup ? `<div class="notice">尚未创建管理员。请在服务器环境中设置 ADMIN_USERNAME 和至少 12 位的 ADMIN_PASSWORD，然后重启服务。配置方法见项目 README。</div>` : ''}<form id="loginForm"><div class="field"><label for="username">管理员账号</label><input id="username" name="username" autocomplete="username" required></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><p class="error" id="loginError" role="alert"></p><button class="primary" ${state.needsSetup ? 'disabled' : ''}>登录管理后台 →</button></form><p class="hint">公司内部工作空间 · 仅限授权管理员</p></div></main>`;
  bind('loginForm','submit',async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try {
      const result = await api('login', { username: document.getElementById('username').value, password: document.getElementById('password').value });
      state.user = result.user; state.csrf = result.csrf; await refreshProducts(); await render();
    } catch(error) { document.getElementById('loginError').textContent = error.message; }
    finally { button.disabled = false; }
  });
}
async function render() {
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">✳</span>Email Copilot</div><div class="brand-caption">KNOWLEDGE & INSIGHTS</div><nav class="nav" aria-label="主要导航">${Object.entries(titles).map(([key,title],i) => `<button data-page="${key}" class="${state.page === key ? 'active' : ''}" ${state.page === key ? 'aria-current="page"' : ''}><span class="nav-symbol">${symbols[i]}</span>${title}</button>`).join('')}</nav><div class="sidebar-foot"><strong>为更好的客服体验</strong>知识 · 协作 · 持续改进<br>公司内部管理工作空间</div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb">工作空间 <span>/ ${titles[state.page]}</span></div><div class="user"><span class="avatar">${esc(state.user.username[0].toUpperCase())}</span>${esc(state.user.username)}<button id="logout" class="link">退出</button></div></header><main class="content" id="page"><div class="loading">正在加载…</div></main></div></div>`;
  document.querySelectorAll('[data-page]').forEach(button => button.onclick = async () => {
    if (!allowLeave()) return;
    state.dirty = false; state.page = button.dataset.page; state.selected = ''; await render().catch(error => toast(error.message));
  });
  bind('logout', 'click', async () => { if (!allowLeave()) return; await api('logout', {}); state.user = null; state.dirty = false; login(); });
  try {
    if (state.page === 'dashboard') await dashboard();
    else if (state.page === 'products') products();
    else if (['knowledge','templates','rules'].includes(state.page)) await editor();
    else if (state.page === 'test') testPage();
    else if (state.page === 'history') await history();
    else await settings();
  } catch (error) { document.getElementById('page').innerHTML = `<div class="notice">${esc(error.message)}</div>`; }
}
function page(html) { document.getElementById('page').innerHTML = html; }
function bindProduct(callback) {
  bind('productSelect','change', async event => {
    if (!event.target.value) { event.target.value = state.product; return; }
    if (!allowLeave()) { event.target.value = state.product; return; }
    state.dirty = false; state.product = event.target.value; state.selected = ''; state.testResults = {}; await callback();
  });
}
function noProducts() { page(heading(titles[state.page], '各产品的内容独立维护') + `<div class="card empty"><strong>先建立你的第一个产品</strong>在产品管理中新建产品，或将现有文件导入为待检查的草稿。<p><button id="goProducts" class="primary">前往产品管理</button></p></div>`); bind('goProducts','click', async () => { state.page = 'products'; await render(); }); }
async function dashboard() {
  const d = await api(`dashboard?days=${state.days}&product=${encodeURIComponent(state.filterProduct)}`);
  const max = Math.max(1, ...d.trend.map(t => t.tickets));
  const feedback = d.feedback.slice(0,100);
  const stat = (label, value, note, symbol) => `<div class="stat"><div class="stat-label">${label}<span class="stat-symbol">${symbol}</span></div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`;
  page(heading('服务总览', '了解助手的使用情况，让反馈成为知识改进的起点。', `<label class="visually-hidden" for="dashProduct">筛选产品</label><select id="dashProduct">${productOptions(state.filterProduct,true)}</select><label class="visually-hidden" for="days">时间范围</label><select id="days">${options([['7','最近 7 天'],['30','最近 30 天'],['90','最近 90 天']],state.days)}</select>`) +
    (state.mode === 'mock' ? '<div class="notice">当前为演示模式。可以管理和测试内容；配置模型后生成实际 AI 回复。演示产生的正式使用记录会标注 mock。</div>' : '') +
    `<div class="stats">${stat('助手协助工单',d.tickets,`按工单去重 · ${d.analyses} 次分析`,'◇')}${stat('回复生成次数',d.generations,'包含对话、生成和修改回复','↗')}${stat('客服满意度',fmt(d.satisfaction),`${d.satisfactionCount} 次满意度评价`,'♡')}${stat('客服评价准确率',fmt(d.accuracy),`${d.accuracyCount} 次有效评价 · 无法判断 ${d.unknown} 次`,'✓')}</div>
    <div class="dashboard-grid"><section class="card"><div class="card-head"><h2>工单使用趋势</h2><span class="muted">每日协助工单 · 上海时间</span></div><div class="chart" aria-label="每日协助工单趋势">${d.trend.map((t,i) => `<div class="chart-col" title="${t.date}：${t.tickets} 个工单">${d.trend.length <= 30 ? `<span class="chart-count">${t.tickets}</span>` : ''}<div class="chart-bar" data-height="${Math.max(1,t.tickets/max*140)}"></div></div>`).join('')}</div><div class="chart-labels">${d.trend.filter((_,i) => i === 0 || i === d.trend.length-1 || i % Math.ceil(d.trend.length / 7) === 0).map(t => `<span>${t.date.slice(5)}</span>`).join('')}</div></section>
    <section class="card"><div class="card-head"><h2>客服评价</h2><span class="muted">自愿填写</span></div><div class="distribution">${Object.entries(d.distribution).map(([key,count]) => `<div><div class="distribution-label"><span>${feedbackNames[key]}</span><span>${count} 次</span></div><div class="track"><div class="fill ${key}" data-width="${d.satisfactionCount ? count/d.satisfactionCount*100 : 0}"></div></div></div>`).join('')}</div><div class="coverage">评价覆盖率 <strong>${fmt(d.coverage)}</strong> · ${d.evaluatedTickets} / ${d.tickets} 个工单<br>满意度按满意评价占比；准确率排除“无法判断”。</div></section></div>
    <section class="card"><div class="card-head"><h2>反馈与改进</h2><span class="muted">最近 ${feedback.length} 条评价 · 结果与当时的内容版本关联</span></div>${feedback.length ? `<div class="table-wrap"><table><thead><tr><th>产品 / 问题类型</th><th>满意度</th><th>准确性</th><th>问题原因</th><th>评价时间</th><th></th></tr></thead><tbody>${feedback.map(f => `<tr><td>${esc(f.product)}<br><span class="muted">${esc(categoryNames[f.category] || f.category)} · v${f.version}</span></td><td>${feedbackTag(f.satisfaction)}</td><td>${feedbackTag(f.accuracy)}</td><td>${esc(f.reason || '—')}</td><td class="muted">${date(f.at)}</td><td><button class="link" data-feedback="${f.id}">查看详情 →</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><strong>等待第一条反馈</strong>客服在助手中使用并评价结果后，数据会显示在这里。</div>'}</section>
    <section class="card audit"><div class="card-head"><h2>产品使用分布</h2></div>${d.byProduct.length ? `<table><thead><tr><th>产品</th><th>协助工单</th></tr></thead><tbody>${d.byProduct.map(p => `<tr><td>${esc(p.name)}</td><td>${p.tickets}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">尚未配置产品</div>'}</section>`);
  document.querySelectorAll('[data-height]').forEach(el => el.style.height = el.dataset.height + 'px');
  document.querySelectorAll('[data-width]').forEach(el => el.style.width = el.dataset.width + '%');
  bind('days','change',async event => { state.days = event.target.value; await dashboard(); });
  bind('dashProduct','change',async event => { state.filterProduct = event.target.value; await dashboard(); });
  document.querySelectorAll('[data-feedback]').forEach(b => b.onclick = () => feedbackDetail(b.dataset.feedback).catch(e => toast(e.message)));
}
function feedbackTag(value) { return value ? `<span class="tag ${['unsatisfied','inaccurate'].includes(value) ? 'bad' : ['partial','neutral','unknown'].includes(value) ? 'warn' : ''}">${feedbackNames[value]}</span>` : '—'; }
async function feedbackDetail(key) {
  const data = await api('feedback?id=' + encodeURIComponent(key));
  showDialog(`<h2>反馈详情</h2><p>${feedbackTag(data.feedback.satisfaction)} ${feedbackTag(data.feedback.accuracy)} <span class="muted">v${data.event.version} · ${esc(data.event.mode)}</span></p><p>${esc(data.feedback.reason)} ${esc(data.feedback.note)}</p><h3>工单主题</h3><p>${esc(data.event.subject)}</p><h3>当时的生成结果</h3><pre>${esc(data.event.output.reply || data.event.output.draft_reply)}</pre><h3>当时提供给助手的内容</h3>${referenceHTML(data.event.references, data.event.usedIds)}<div class="dialog-footer"><button data-close>关闭</button></div>`);
}
function products() {
  page(heading('产品管理','各产品拥有独立的知识、模板、规则与发布记录。','<button class="primary" id="newProduct">＋ 新建产品</button>') +
    (!state.products.length ? `<div class="notice green">可以从空白产品开始，或将项目原有知识、模板和基础规则导入为草稿。原有内容需要检查适用产品后再发布。<p><button id="importLegacy">导入原有内容</button></p></div>` : '') +
    `<div class="product-grid">${state.products.map(p => `<article class="card product-card"><div class="card-head"><h2>${esc(p.name)}</h2><span class="tag ${p.enabled ? '' : 'warn'}">${p.enabled ? '使用中' : '已停用'}</span></div><p>${p.counts.knowledge} 条知识 · ${p.counts.templates} 个模板 · ${p.counts.rules} 条规则</p><p>正式版本：${p.version ? 'v' + p.version : '尚未发布'} · 待发布 ${p.pending} 项</p><p>关联队列：${esc(p.queues.join('、') || '未配置')}</p><div class="controls"><button data-edit-product="${p.id}">编辑资料</button><button class="primary" data-manage="${p.id}">管理内容 →</button></div></article>`).join('')}</div>`);
  bind('newProduct','click',() => productDialog());
  bind('importLegacy','click',async () => { await api('import-legacy',{}); await refreshProducts(); products(); toast('原有内容已导入为草稿，请检查后发布'); });
  document.querySelectorAll('[data-edit-product]').forEach(b => b.onclick = () => productDialog(state.products.find(p => p.id === b.dataset.editProduct)));
  document.querySelectorAll('[data-manage]').forEach(b => b.onclick = async () => { state.product = b.dataset.manage; state.page = 'knowledge'; state.selected = ''; await render(); });
}
function productDialog(p = {}) {
  showDialog(`<h2>${p.id ? '编辑产品资料' : '新建产品'}</h2><form id="productForm"><div class="field"><label for="pName">产品名称</label><input id="pName" value="${esc(p.name)}" required maxlength="120"></div><div class="field"><label for="pAliases">产品别名</label><textarea id="pAliases" rows="2">${esc(p.aliases?.join('\n'))}</textarea><span class="hint">每行一项，用于识别邮件中的产品名称；请避免多个产品共用同一简称。</span></div><div class="form-grid"><div class="field"><label for="pQueues">关联工单队列</label><textarea id="pQueues" rows="3">${esc(p.queues?.join('\n'))}</textarea><span class="hint">每行一个队列；同一队列可以关联多个产品。</span></div><div class="field"><label for="pOrders">订单商品名称</label><textarea id="pOrders" rows="3">${esc(p.orderNames?.join('\n'))}</textarea><span class="hint">每行一个名称，供订单识别使用。</span></div></div>${!p.id ? `<div class="field"><label for="copyFrom">初始内容</label><select id="copyFrom">${options([['','空白产品'],...state.products.map(p => [p.id,'复制自：' + p.name])],'')}</select><span class="hint">复制来源的已发布内容，作为新产品草稿；之后独立维护。</span></div>` : ''}<label class="check"><input id="pEnabled" type="checkbox" ${p.enabled !== false ? 'checked' : ''}>启用产品</label><p class="hint">产品识别配置保存后立即生效；业务内容须单独发布。</p><div class="dialog-footer"><button type="button" data-close>取消</button><button class="primary">保存产品</button></div></form>`);
  bind('productForm','submit',async event => { event.preventDefault(); const lines = key => document.getElementById(key).value.split('\n').map(s => s.trim()).filter(Boolean);
    const result = await api('products', { id:p.id, revision:p.revision, name:document.getElementById('pName').value, aliases:lines('pAliases'), queues:lines('pQueues'), orderNames:lines('pOrders'), enabled:document.getElementById('pEnabled').checked, copyFrom:document.getElementById('copyFrom')?.value });
    modal.close(); await refreshProducts(); state.product = result.id; products(); toast('产品资料已保存');
  });
}
async function editor() {
  if (!state.product) return noProducts();
  const p = state.content = await api('content?product=' + encodeURIComponent(state.product));
  const kind = state.page;
  if (!p.draft[kind].some(e => e.id === state.selected)) state.selected = p.draft[kind][0]?.id || '';
  page(heading(titles[kind], '保存为草稿，在测试确认后发布生效。',productSelect()) +
    (Object.values(p.pending).some(a => a.length) ? `<div class="notice green">当前产品有 ${Object.values(p.pending).reduce((n,a)=>n+a.length,0)} 项待发布修改。<button class="link" id="openPublish">查看并发布 →</button></div>` : '') +
    `<div class="editor-layout"><aside class="card entry-list"><label class="visually-hidden" for="searchEntry">搜索内容</label><input id="searchEntry" placeholder="搜索标题、正文或关键词…"><div class="controls"><select id="filterCategory" aria-label="按分类筛选">${options([['','全部分类'],...Object.entries(categoryNames)],'')}</select><select id="filterStatus" aria-label="按状态筛选">${options([['','全部状态'],['pending','待发布'],['published','已发布'],['disabled','已停用']],'')}</select></div><p><button id="newEntry" class="primary">＋ 新增${kindNames[kind]}</button></p><div id="entryItems"></div></aside><section class="card" id="entryEditor"></section></div>`);
  function list() {
    const q = document.getElementById('searchEntry').value.toLowerCase();
    const category = document.getElementById('filterCategory').value, status = document.getElementById('filterStatus').value;
    const entries = p.draft[kind].filter(e => (e.title + e.content + e.tags.join(' ')).toLowerCase().includes(q) && (!category || e.category === category) && (!status || (status === 'pending' ? p.pending[kind].includes(e.id) : status === 'disabled' ? !e.enabled : !p.pending[kind].includes(e.id))));
    document.getElementById('entryItems').innerHTML = entries.map(e => `<button class="entry-item ${state.selected === e.id ? 'active' : ''}" data-entry="${e.id}"><span class="entry-title">${esc(e.title)}</span><span class="entry-meta"><span class="muted">${esc(categoryNames[e.category] || e.category)}</span><span class="tag ${p.pending[kind].includes(e.id) ? 'warn' : ''}">${p.pending[kind].includes(e.id) ? '有草稿' : '已发布'}${e.enabled ? '' : ' · 停用'}</span></span></button>`).join('') || '<div class="empty">暂无匹配内容</div>';
    document.querySelectorAll('[data-entry]').forEach(b => b.onclick = () => { if (!allowLeave()) return; state.dirty = false; state.selected = b.dataset.entry; list(); entryForm(p.draft[kind].find(e => e.id === state.selected),kind,p); });
  }
  list(); entryForm(p.draft[kind].find(e => e.id === state.selected),kind,p);
  bind('searchEntry','input',list); bind('filterCategory','change',list); bind('filterStatus','change',list);
  bind('newEntry','click',() => { if (!allowLeave()) return; state.dirty = false; state.selected = ''; list(); entryForm(null,kind,p); });
  bind('openPublish','click',() => { if (allowLeave()) publishDialog(p); }); bindProduct(editor);
}
function entryForm(entry,kind,p) {
  const e = entry || { title:'', category:'general', content:'', tags:[], internal:'', enabled:true, stage:'all', fixed:[], conditions:'' };
  document.getElementById('entryEditor').innerHTML = `<div class="editor-header"><h2>${entry ? '编辑' : '新增'}${kindNames[kind]}</h2><span class="muted">${e.updatedAt ? esc(e.updatedBy) + ' · ' + date(e.updatedAt) : '未保存'}</span></div><form id="entryForm"><div class="form-grid"><div class="field"><label for="eTitle">标题</label><input id="eTitle" value="${esc(e.title)}" maxlength="200" required></div><div class="field"><label for="eCategory">分类</label><select id="eCategory">${options(Object.entries(categoryNames),e.category)}</select></div></div><div class="field"><label for="eTags">检索关键词</label><input id="eTags" value="${esc(e.tags.join(', '))}" placeholder="例如：退款, refund, money back"><span class="hint">使用中英文逗号分隔，可填写不同语言的关键词。</span></div>${kind === 'rules' ? `<div class="field"><label for="eStage">作用环节</label><select id="eStage">${options([['all','所有环节'],['analyze-thread','分析工单'],['generate-draft','生成回复'],['refine-draft','修改回复'],['chat','助手对话']],e.stage)}</select></div>` : ''}<div class="field"><label for="eContent">${kind === 'templates' ? '英文模板正文' : kind === 'rules' ? '规则内容' : '知识正文'}</label><textarea id="eContent" rows="12" required>${esc(e.content)}</textarea>${kind === 'templates' ? '<span class="hint">支持 {{customer_name}}、{{product_name}} 等变量；只能使用邮件或订单中的已知事实填写。</span>' : ''}</div>${kind === 'knowledge' ? `<div class="field"><label for="eInternal">内部说明</label><textarea id="eInternal" rows="4">${esc(e.internal)}</textarea><span class="hint">用于客服处理判断，要求助手不向客户披露。发布前请通过测试检查回复。</span></div>` : ''}${kind === 'templates' ? `<div class="field"><label for="eConditions">使用条件</label><textarea id="eConditions" rows="2">${esc(e.conditions)}</textarea></div><div class="field"><label for="eFixed">必须保留的固定表述</label><textarea id="eFixed" rows="3">${esc(e.fixed.join('\n'))}</textarea><span class="hint">每行一段，须与正文一致；其余内容允许助手按邮件调整。</span></div>` : ''}<label class="check"><input id="eEnabled" type="checkbox" ${e.enabled ? 'checked' : ''}>启用此内容</label><div class="editor-actions">${entry ? '<button class="danger" type="button" id="deleteEntry">删除</button>' : ''}<button type="button" id="testEntry">去测试</button><button class="primary">保存草稿</button></div></form>`;
  const form = document.getElementById('entryForm'); form.addEventListener('input',()=>state.dirty=true); form.addEventListener('change',()=>state.dirty=true);
  if (kind === 'knowledge') {
    const source = document.getElementById('eContent');
    const toolbar = document.createElement('div'); toolbar.className = 'markdown-toolbar';
    toolbar.innerHTML = '<div class="markdown-modes" role="group" aria-label="知识正文显示方式"><button type="button" id="markdownEdit">编辑</button><button type="button" id="markdownPreview">预览</button></div><span class="hint">支持 Markdown：标题、列表、表格、代码和链接</span>';
    const preview = document.createElement('div'); preview.id = 'knowledgePreview'; preview.className = 'markdown-body knowledge-preview'; preview.setAttribute('aria-label','知识正文 Markdown 预览');
    source.before(toolbar); source.after(preview);
    const update = () => { preview.innerHTML = source.value.trim() ? renderMarkdown(source.value) : '<p class="muted">暂无正文，请切换到编辑后输入内容。</p>'; };
    function mode(isPreview) {
      source.hidden = isPreview; preview.hidden = !isPreview;
      document.getElementById('markdownEdit').setAttribute('aria-pressed',String(!isPreview));
      document.getElementById('markdownPreview').setAttribute('aria-pressed',String(isPreview));
      if (isPreview) update();
    }
    bind('markdownEdit','click',()=>{mode(false);source.focus();});
    bind('markdownPreview','click',()=>mode(true));
    source.addEventListener('input',update); source.addEventListener('invalid',()=>mode(false));
    mode(Boolean(entry?.content));
  }
  bind('entryForm','submit',async event => { event.preventDefault(); const value = key => document.getElementById(key)?.value || '';
    const body = { id:entry?.id, title:value('eTitle'), category:value('eCategory'), content:value('eContent'), tags:value('eTags').split(/[,，]/).map(s=>s.trim()).filter(Boolean), internal:value('eInternal'), stage:value('eStage'), fixed:value('eFixed').split('\n').map(s=>s.trim()).filter(Boolean), conditions:value('eConditions'), enabled:document.getElementById('eEnabled').checked };
    const result = await api('entry',{ product:state.product, kind, revision:p.revision, entry:body }); state.selected=result.id; state.dirty=false; await refreshProducts(); await editor(); toast('草稿已保存，发布后正式生效');
  });
  bind('deleteEntry','click',async () => { if (!confirm('删除后会形成待发布修改；发布前正式内容仍然可用。确定删除吗？')) return; await api('delete-entry',{product:state.product,kind,id:entry.id,revision:p.revision}); state.dirty=false; state.selected=''; await refreshProducts(); await editor(); });
  bind('testEntry','click',async () => { if (!allowLeave()) return; state.dirty=false; state.page='test'; state.testResults={}; await render(); });
}
function entryDiff(entry) { return entry ? [entry.title, '分类：'+entry.category, '启用：'+entry.enabled, '关键词：'+entry.tags.join(', '), entry.stage ? '环节：'+entry.stage : '', entry.conditions || '', entry.content, entry.internal ? '内部说明：'+entry.internal : '', entry.fixed?.length ? '固定表述：\n'+entry.fixed.join('\n') : ''].filter(Boolean).join('\n\n') : '（无内容 / 删除）'; }
function publishDialog(p) {
  const items = Object.entries(p.pending).flatMap(([kind,ids])=>ids.map(id=>({kind,id})));
  showDialog(`<h2>发布修改 · ${esc(p.name)}</h2><p class="muted">选中的修改会同时生效。未勾选的内容继续保留为草稿。</p><form id="publishForm">${items.map((item,i)=>{
    const old=p.published[item.kind].find(e=>e.id===item.id), next=p.draft[item.kind].find(e=>e.id===item.id);
    return `<div class="release-item"><label class="release-label"><input type="checkbox" name="release" value="${i}" checked><span>${kindNames[item.kind]} · ${esc(next?.title || old?.title)} ${!next?'（删除）':''}</span></label><details><summary class="muted">查看修改前后</summary><div class="diff"><div><p class="muted">当前已发布</p><pre>${esc(entryDiff(old))}</pre></div><div><p class="muted">本次修改</p><pre>${esc(entryDiff(next))}</pre></div></div></details></div>`;
  }).join('')}<div class="field"><label for="releaseNote">发布说明（选填）</label><input id="releaseNote" maxlength="1000" placeholder="例如：更新退款期限及对应回复"></div><div class="dialog-footer"><button type="button" data-close>取消</button><button class="primary" ${items.length?'':'disabled'}>确认发布 ${items.length} 项修改</button></div></form>`);
  bind('publishForm','submit',async event=>{event.preventDefault(); const chosen=[...modal.querySelectorAll('input[name=release]:checked')].map(el=>items[Number(el.value)]); if(!chosen.length) throw new Error('请选择待发布修改'); await api('publish',{product:p.id,revision:p.revision,items:chosen,note:document.getElementById('releaseNote').value}); modal.close(); state.dirty=false; await refreshProducts(); await render(); toast('已发布，助手立即使用新版本');});
}
function referenceHTML(references,usedIds=[]) {
  return Object.entries(references || {}).map(([kind,entries])=>`<h3>${kindNames[kind]} · ${entries.length}</h3>${entries.map(e=>`<details class="reference"><summary>${esc(e.title)} ${usedIds.includes(e.id)?'<span class="tag">模型报告已使用</span>':''}</summary>${kind === 'knowledge' ? `<div class="markdown-body">${renderMarkdown(e.content)}</div>` : `<p>${esc(e.content)}</p>`}${e.internal?`<p>内部说明：${esc(e.internal)}</p>`:''}</details>`).join('')}`).join('')+'<p class="hint">以上为提供给模型的内容；“已使用”由模型报告，供人工检查。</p>';
}
function testPage() {
  if (!state.product) return noProducts();
  page(heading('测试工作台','粘贴邮件，检查处理建议与英文回复。测试不计入正式使用统计。',productSelect())+
    `<div class="test-grid"><section class="card"><h2>输入测试邮件</h2><p class="muted">测试内容仅用于本次生成，不自动保存为案例。</p><form id="testForm"><div class="field"><label for="testSubject">邮件主题（选填）</label><input id="testSubject" placeholder="例如：Request a refund"></div><div class="field"><label for="testThread">邮件内容</label><textarea id="testThread" required placeholder="粘贴客户邮件或完整往来…"></textarea></div><div class="field"><label for="testOrder">订单信息（选填）</label><textarea id="testOrder" class="order" placeholder="产品名称、购买日期、订单状态等"></textarea></div><div class="form-grid"><div class="field"><label for="testVersion">测试内容</label><select id="testVersion"><option value="published">已发布版本</option><option value="draft">包含全部草稿</option></select></div><div class="field"><label for="testAction">测试任务</label><select id="testAction"><option value="generate-draft">生成英文回复</option><option value="analyze-thread">分析工单</option></select></div></div><button class="primary" id="runTest">开始测试 →</button></form></section><section class="card"><div class="card-head"><h2>测试结果</h2><select id="resultVersion" aria-label="选择查看的测试结果"></select></div><div class="tabs"><button data-tab="reply" class="active">英文回复</button><button data-tab="analysis">处理建议</button><button data-tab="references">引用内容</button></div><div id="testOutput" class="empty">运行测试后，在这里检查结果。<br>分别运行两个版本后，可以切换对比。</div></section></div>`);
  bindProduct(testPage);
  bind('testForm','submit',async event=>{event.preventDefault(); const button=document.getElementById('runTest'); button.disabled=true; button.textContent='正在生成…';
    const version=document.getElementById('testVersion').value;
    try { const result=await api('test',{product_id:state.product,subject:document.getElementById('testSubject').value,thread_text:document.getElementById('testThread').value,order_context:document.getElementById('testOrder').value,draft:version==='draft',action:document.getElementById('testAction').value}); state.testResults[version]=result; const select=document.getElementById('resultVersion'); select.innerHTML=options(Object.keys(state.testResults).map(k=>[k,k==='draft'?'草稿测试结果':'已发布测试结果']),version); renderTestOutput(); }
    finally {button.disabled=false;button.textContent='开始测试 →';}
  });
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.testTab=b.dataset.tab;document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el===b));renderTestOutput();});
  bind('resultVersion','change',renderTestOutput);
}
function renderTestOutput() {
  const result=state.testResults[document.getElementById('resultVersion').value]; if(!result)return;
  const el=document.getElementById('testOutput');el.className='';
  const note=`<p class="muted">${esc(result.product_name)} · ${result.draft?'草稿':'v'+result.version} · ${esc(result.mode)}</p>${result.mode==='mock'?'<div class="notice">演示模式：展示检索结果与模板原文，未调用模型。</div>':''}${result.warnings.map(w=>`<div class="notice">${esc(w)}</div>`).join('')}`;
  el.innerHTML=note+(state.testTab==='references'?referenceHTML(result.references,result.used_ids):state.testTab==='analysis'?`<h3>问题类型：${esc(categoryNames[result.category]||result.category)}</h3><div class="result-text">${esc(result.summary)}\n\n${esc(result.next_step)}</div>`:`<div class="result-text">${esc(result.draft_reply||result.reply||'本任务未生成回复')}</div>`);
}
async function history() {
  if(!state.product)return noProducts();const p=state.content=await api('content?product='+encodeURIComponent(state.product));
  page(heading('发布与历史','每次发布保存完整快照；恢复旧版本会创建一个新的正式版本。',productSelect())+
    `<section class="card"><div class="card-head"><h2>当前版本 ${p.version?'v'+p.version:'尚未发布'}</h2><button id="publishNow" class="primary">查看待发布修改</button></div><p class="muted">待发布：${Object.entries(p.pending).map(([k,v])=>`${kindNames[k]} ${v.length} 项`).join(' · ')}</p>${p.history.length?`<table><thead><tr><th>版本</th><th>发布说明</th><th>发布人</th><th>时间</th><th></th></tr></thead><tbody>${p.history.slice().reverse().map(h=>`<tr><td><span class="tag">v${h.version}</span></td><td>${esc(h.note||'—')}</td><td>${esc(h.actor)}</td><td>${date(h.at)}</td><td><button class="link" data-view-version="${h.version}">查看内容</button> ${h.version===p.version?'当前版本':`<button class="link" data-restore="${h.version}">恢复此版本</button>`}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">尚无发布记录</div>'}</section>`);
  bindProduct(history);bind('publishNow','click',()=>publishDialog(p));
  document.querySelectorAll('[data-view-version]').forEach(b=>b.onclick=async()=>{try{const release=await api('version?product='+encodeURIComponent(p.id)+'&version='+b.dataset.viewVersion);showDialog(`<h2>${esc(p.name)} · v${release.version}</h2><p class="muted">${esc(release.actor)} · ${date(release.at)} · ${esc(release.note)}</p>${referenceHTML(release.snapshot)}<div class="dialog-footer"><button data-close>关闭</button></div>`);}catch(error){toast(error.message);}});
  document.querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{if(!confirm(`将当前产品恢复至 v${b.dataset.restore}，并立即生效。确定继续吗？`))return;try{await api('restore',{product:p.id,revision:p.revision,version:Number(b.dataset.restore)});await refreshProducts();await history();toast('已恢复，并创建新版本');}catch(error){toast(error.message);}});
}
async function settings() {
  const [users,audit]=await Promise.all([api('users'),api('audit')]);
  page(heading('账号与设置','管理员拥有内容编辑和发布权限；所有修改均留有记录。','<button id="newUser" class="primary">＋ 添加管理员</button>')+
    `<section class="card"><div class="card-head"><h2>管理员账号</h2><span class="muted">不统计客服个人表现</span></div><div class="table-wrap"><table><thead><tr><th>账号</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.username)}</td><td><span class="tag">${u.enabled?'启用':'停用'}</span></td><td>${date(u.createdAt)}</td><td><button class="link" data-reset="${u.id}">重设密码</button><button class="link" data-user="${u.id}" data-enabled="${!u.enabled}">${u.enabled?'停用':'启用'}</button></td></tr>`).join('')}</tbody></table></div></section><section class="card audit"><div class="card-head"><h2>服务配置</h2></div><p>模型服务：<code>${esc(state.mode)}</code> · <code>${esc(state.model)}</code></p><p class="muted">模型密钥、助手访问密钥、数据目录与 HTTPS 设置由服务器环境配置，详见 README。队列映射在各产品资料中维护。</p></section><section class="card audit"><div class="card-head"><h2>管理员操作记录</h2><span class="muted">最近 200 条</span></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>说明</th></tr></thead><tbody>${audit.map(a=>`<tr><td>${date(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div></section>`);
  function userDialog(user){showDialog(`<h2>${user?'重设密码 · '+esc(user.username):'添加管理员'}</h2><form id="userForm">${user?'':'<div class="field"><label for="newUsername">账号</label><input id="newUsername" required autocomplete="off" pattern="[a-zA-Z0-9_.@-]{3,80}"></div>'}<div class="field"><label for="newPassword">新密码</label><input id="newPassword" type="password" minlength="12" maxlength="200" required autocomplete="new-password"><span class="hint">至少 12 个字符；重设后该账号的已有登录会失效。</span></div><div class="dialog-footer"><button type="button" data-close>取消</button><button class="primary">保存</button></div></form>`);bind('userForm','submit',async event=>{event.preventDefault();await api('users',{id:user?.id,username:document.getElementById('newUsername')?.value,password:document.getElementById('newPassword').value});modal.close();if(user?.id===state.user.id){state.user=null;login();}else await settings();toast('账号已保存');});}
  bind('newUser','click',()=>userDialog());document.querySelectorAll('[data-reset]').forEach(b=>b.onclick=()=>userDialog(users.find(u=>u.id===b.dataset.reset)));
  document.querySelectorAll('[data-user]').forEach(b=>b.onclick=async()=>{if(!confirm('确认修改此管理员的启用状态？'))return;try{await api('users',{id:b.dataset.user,enabled:b.dataset.enabled==='true'});if(b.dataset.user===state.user.id){state.user=null;login();}else await settings();}catch(error){toast(error.message);}});
}
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
init().catch(error=>{root.innerHTML=`<main class="login"><div class="login-card"><h1>暂时无法加载</h1><p>${esc(error.message)}</p><p>请检查后台服务后刷新页面。</p></div></main>`;});
}
