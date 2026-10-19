// Curate existing repository material through the running admin API.
// Defaults to a read-only plan. --apply saves drafts; it never publishes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const descriptions = {
  'product-001': {
    title: '退款资格、期限与适用条件', category: 'refund',
    content: '退款申请期限：月度和年度订阅为 5 天；终身／永久授权为 30 天。\n\n原有政策列出的可受理情况：重复付款；买错产品并及时反馈；购买后 24 小时内未收到注册码且未获得客服回复；技术问题持续 30 天仍未解决；已取消续订但仍被自动扣费，需提供取消证明。\n\n原有政策列出的不受理情况：超过退款期限；未提供退款原因；不配合故障排查；仅因地区或平台价格差异申请退款；买错产品但未及时反馈；对处理效果不满意但未提供处理前后的对比图片。',
    internal: '以上期限及条件来自现有资料，尚未按具体产品、套餐或销售渠道核对。正式发布前需确认适用范围。受理退款不代表已经审批或退款完成，回复前先人工核查订单。'
  },
  'product-002': {
    title: '注册码无法激活：原因与排查', category: 'account',
    content: '注册码在购买后通过邮件发送。激活失败的常见原因包括：注册码或购买邮箱输入错误、下载的产品版本不对应、设备激活次数问题，或重新安装了操作系统。\n\n先核对购买邮箱和注册码，再确认下载的是正确产品版本。订阅到期后，注册码无法继续使用，需要续订。',
    internal: '客服操作：核对购买邮箱与系统订单记录；检查激活使用情况；在本地测试注册码是否有效；确认产品版本。激活或设备限制须以对应产品规则为准，不直接套用其他产品的限制。'
  },
  'product-003': {
    title: '更换电脑、重装系统与授权重置', category: 'account',
    content: '客户更换电脑或重装操作系统后，可联系支持团队申请重置激活。需要提供购买邮箱及操作系统信息。重置完成后，旧设备的激活会失效。',
    internal: '原有资料记载：后台技术上最多支持 3 台设备，但对客户说明为 1 台设备。此差异属于内部资料，不写入客户回复；发布前须核实具体产品的正式授权条款。重置由支持团队手动处理，未经确认不得告知客户已完成重置。'
  },
  'product-004': {
    title: '自动续订规则与取消方式', category: 'cancel_renewal',
    content: '订阅默认自动续订。客户可使用订阅邮件中的链接取消自动续订，也可联系支持团队协助。\n\n如果客户在扣费后 5 天退款期限内提出取消和退款申请，按退款政策核查资格。取消续订与退款是不同处理事项，需分别确认。',
    internal: '由客服通过工单系统提交取消续订或续费退款申请，交给负责团队处理。5 天期限来自原有资料，发布前核对具体产品、套餐和渠道。不将“收到申请”表述为“已经取消”。'
  },
  'product-005': {
    title: '发票与收据申请所需信息', category: 'invoice',
    content: '客户可以申请发票或收据。需要 VAT 发票或带公司信息的发票时，应提供公司名称、公司地址和税号／VAT ID。',
    internal: '发票和收据由客服手动制作。原有资料说明信息齐全后通常可以及时处理；未经核查不承诺具体完成时间。'
  },
  'product-006': {
    title: '社交平台免费积分活动：现有资料与待核对事项', category: 'free_credit',
    content: '现有资料包含 YouTube、Facebook 和 Twitter／X 三个平台的积分活动。客户需要提供活动凭证，例如链接或截图；截图应能看出客户账号及相关活动内容。具体参与方式和核验要求需先由客服确认。',
    internal: '存在来源差异，发布前必须核对：knowledge/products.json 描述的是发布产品评价／帖子，每位客户每个平台限一次；backend/prompts/free-credit-config.json 与 guidance.json 描述的是关注／订阅核验，每个平台 60 积分，最多 3 个平台、合计 180 积分，YouTube 需要订阅截图。不要将发帖评价和关注订阅当作同一活动，也不要把账号名或链接直接视作已通过核验。原有指引要求先记录到积分表，次日确认发放后再发送已发放通知。'
  },
  'product-007': {
    title: '软件崩溃、报错或功能异常的初步排查', category: 'technical',
    content: '遇到崩溃、软件错误或异常行为，先确认操作系统版本和显卡型号，再检查显卡驱动与软件是否为最新版本，必要时尝试重新安装软件。\n\n如果问题仍未解决，需要进一步收集日志和已尝试的排查步骤。原有政策记载：技术问题持续 30 天仍未解决时，可按退款政策核查退款资格。',
    internal: '基础排查无效时使用 crash 模板收集日志，通过工单系统将日志和已尝试步骤提交给技术团队。不得推测根因或承诺修复期限。30 天条件须与具体产品退款政策及处理记录核对，不能表述为自动退款。'
  },
  'product-008': {
    title: '忘记购买邮箱或找不到订单', category: 'account',
    content: '客户找不到购买邮件或不记得购买邮箱时，可提供大致购买日期、支付方式、信用卡后四位、产品名称和付款金额，供支持团队协助查找订单。找到并核实订单后，可继续协助恢复访问或重发注册码。',
    internal: '通过内部支持平台查询。仅按现有资料收集信用卡后四位，不索取完整卡号。查询成功前不要声称已经找到订单或已重发注册码。'
  },
  'product-009': {
    title: '修改注册邮箱的申请与核验', category: 'account',
    content: '需要修改注册邮箱时，请联系支持团队，并提供当前注册邮箱用于身份核验。',
    internal: '邮箱修改由客服在内部支持平台操作。原有资料仅列出当前注册邮箱这一核验信息，正式发布前核对具体产品的身份核验要求；未经确认不承诺已经完成邮箱修改。'
  },
  'policy-001': {
    title: '退款申请的处理流程与通知', category: 'refund',
    content: '收到退款申请后，先核查订单和退款资格。符合条件的申请交由负责人员处理，处理成功后再通知客户。\n\n收到申请时可使用：We have received your request and will assist you in submitting your refund request. You will be notified by email upon success.\n\n原有资料记载：退款到账通常需要 3–10 个工作日，取决于 Paddle、Stripe 等支付方式。',
    internal: '客服通过工单系统提交订单信息和退款原因。审批前不得直接保证退款；确认处理成功后，才使用 refunded 模板发送完成通知。到账时间来自原有资料，发布前核对实际渠道口径。'
  },
  'policy-002': {
    title: '取消自动续订的处理状态与回复', category: 'cancel_renewal',
    content: '客户申请取消自动续订时，区分“申请已收到”和“取消已完成”。申请收到时可使用：We have received your request and will assist you in submitting your request to cancel your auto-renewal. You will be notified by email upon success.\n\n仅在取消状态已确认后，才告知客户续订已取消。',
    internal: '按原有指引：查不到订单时请客户确认购买邮箱；订单为 PAID 时先确认收到请求，再在工单系统提交处理；所有相关订阅均为 SUBSCRIPTION_CANCELLED 时，才可使用已取消模板。未查询订单前先查询。原指引中指定负责人和界面操作路径保留在 AI 处理规则中，发布前核对是否仍适用。'
  },
  'policy-003': {
    title: '投诉、负面评价与情绪激动客户的应对', category: 'general',
    content: '保持冷静、专业，承认客户的不便和情绪，避免争辩、指责或防御性措辞。客户提及社交媒体投诉或负面评价时，表达理解并说明下一步处理安排。',
    internal: '客户威胁拒付时，按标准退款流程核查资格并升级处理，不未经确认承诺退款。原有资料提到拒付可能导致账号暂停，但对客表述须核实适用条款，不作自动化威胁话术。涉及法律行动、数据或隐私泄露，或多次联系仍未解决的情况，立即升级主管。'
  },
  'policy-004': {
    title: '禁止承诺与客服措辞规范', category: 'general',
    content: '避免使用未经事实支持的确定性承诺，例如“We will fix it immediately”“We will resolve it right away”“We guarantee a refund”。不使用“It is your fault”等责怪客户的措辞，也不直接以“We cannot help you”结束处理。\n\n采用有依据的表达，例如“we will review”“we will follow up”“you will be notified upon success”，并给出可执行的下一步。',
    internal: '涉及退款、补偿、修复时间、账号变更等结果，必须有明确的核实或处理依据。禁用措辞作为持续生效的行为约束时，还应保留在对应产品的 AI 规则中。'
  },
  'policy-005': {
    title: '技术问题升级流程与退款条件核查', category: 'technical',
    content: '第一步：检查显卡驱动、软件版本并尝试重新安装。\n第二步：基础排查无效后，收集日志及已尝试步骤。\n第三步：提交技术团队继续调查。\n\n不要承诺修复时间。原有资料说明技术问题持续 30 天仍未解决时，应按退款政策核查资格。',
    internal: '使用 crash 模板向客户索取日志，将日志和已尝试步骤通过工单系统提交给技术团队。依现有指引在共享文档和 Redmine 中记录并升级。退款须人工核查，并走正式申请和审批流程。'
  }
};

const templateNames = {
  cancel_renewal_v1: ['取消续订：根据订单状态选择回复', 'cancel_renewal'],
  free_credit_youtube_v1: ['免费积分：索取 YouTube 订阅截图', 'free_credit'],
  invoice_request_v1: ['发票申请：收集订单与账单信息', 'invoice'],
  license_code_not_working_v1: ['激活失败：索取注册码和报错信息', 'account'],
  refund_auto_renewal_v1: ['自动续费退款：确认申请并核查订单', 'refund'],
  technical_issue_collect_info_v1: ['技术异常：收集环境与复现信息', 'technical'],
  '原有话术 · free_credit / youtube_ask': ['免费积分：YouTube 订阅截图说明', 'free_credit'],
  '原有话术 · free_credit / ambiguous_image': ['免费积分：确认截图对应的平台', 'free_credit'],
  '原有话术 · free_credit / valid_channels_with_youtube_pending': ['免费积分：其他渠道已收到，YouTube 待补截图', 'free_credit'],
  '原有话术 · free_credit / only_youtube_id': ['免费积分：仅提供 YouTube 账号，待补截图', 'free_credit'],
  '原有话术 · cancel_renewal / all_cancelled': ['取消续订：已核实全部订阅已取消', 'cancel_renewal'],
  '原有话术 · cancel_renewal / has_active': ['取消续订：收到申请，等待处理', 'cancel_renewal'],
  '原有话术 · cancel_renewal / not_found': ['取消续订：未找到订单，确认购买邮箱', 'cancel_renewal'],
  '原有话术 · generic_support': ['通用支持回复：按已知事实补充内容', 'general']
};
function envValues() {
  const values = { ...process.env };
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim(), index = line.indexOf('=');
    if (!line || line.startsWith('#') || index < 1) continue;
    const key = line.slice(0, index).trim(); let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!values[key]) values[key] = value;
  }
  return values;
}

async function main() {
  const env = envValues();
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) throw new Error('需要通过 ADMIN_USERNAME 和 ADMIN_PASSWORD 登录现有后台；未修改任何数据。');
  const port = Number(env.PORT || 8787);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const origin = 'http://127.0.0.1:' + port;
  let cookie = '', csrf = '';
  async function api(endpoint, body) {
    const response = await fetch(origin + '/api/admin/' + endpoint, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(endpoint + ': ' + (data.error || response.status));
    if (endpoint === 'login') cookie = response.headers.get('set-cookie').split(';')[0];
    return data;
  }
  const user = await api('login', { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }); csrf = user.csrf;
  try {
    let products = await api('products');
    if (!products.length) {
      if (!process.argv.includes('--apply')) { console.log('计划：导入原有资料，再整理 14 条知识和原有模板为草稿。'); return; }
      await api('import-legacy', {}); products = await api('products');
    }
    const candidates = products.filter(p => p.name === 'AVCLabs（原有内容，待细分）');
    if (candidates.length !== 1) throw new Error('未找到唯一的原有资料产品，为避免误改已停止。');
    const product = candidates[0];
    const content = await api('content?product=' + encodeURIComponent(product.id));
    const sources = ['products.json', 'policies.json'].flatMap(file => JSON.parse(fs.readFileSync(path.join(root, 'knowledge', file), 'utf8')).entries);
    const updates = [], skipped = [];
    for (const source of sources) {
      const entry = content.draft.knowledge.find(e => e.id === source.id);
      if (!entry) { skipped.push(source.id + ': 后台没有对应条目'); continue; }
      const target = descriptions[source.id];
      if (!target) continue;
      const original = entry.content === source.content && entry.title === source.title && !entry.internal;
      const current = entry.content === target.content && entry.title === target.title && entry.internal === target.internal && entry.category === target.category;
      if (current) continue;
      if (!original) { skipped.push(source.id + ': 已有人工修改，予以保留'); continue; }
      updates.push({ kind: 'knowledge', entry: { ...entry, ...target } });
    }
    for (const entry of content.draft.templates) {
      const target = templateNames[entry.title] || (entry.title === entry.id ? templateNames[entry.id] : null);
      if (target) updates.push({ kind: 'templates', entry: { ...entry, title: target[0], category: target[1] } });
    }
    const plan = { product: product.name, knowledge: updates.filter(e => e.kind === 'knowledge').length, templates: updates.filter(e => e.kind === 'templates').length, rulesRetained: content.draft.rules.length, skipped, publish: false };
    console.log(JSON.stringify(plan, null, 2));
    if (!process.argv.includes('--apply') || !updates.length) return;
    const backupDir = path.join(root, 'backend/.cache/content-backups'); fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, 'before-curation-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(backup, JSON.stringify(content, null, 2), { mode: 0o600 });
    let revision = content.revision;
    for (const update of updates) {
      const saved = await api('entry', { product: product.id, revision, ...update }); revision = saved.revision;
    }
    const after = await api('content?product=' + encodeURIComponent(product.id));
    assert.equal(after.version, content.version, '本次操作不能发布正式版本');
    assert.deepEqual(after.published, content.published, '不能更改已发布内容');
    for (const update of updates) {
      const saved = after.draft[update.kind].find(e => e.id === update.entry.id);
      for (const key of ['title', 'content', 'category']) assert.equal(saved[key], update.entry[key]);
    }
    console.log(JSON.stringify({ saved: updates.length, draftCounts: Object.fromEntries(Object.entries(after.draft).map(([k,v]) => [k,v.length])), version: after.version, backup }, null, 2));
  } finally { await api('logout', {}).catch(() => {}); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { descriptions, templateNames };
