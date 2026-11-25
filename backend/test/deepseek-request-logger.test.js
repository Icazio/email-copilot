const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { recordDeepSeekRequest } = require('../lib/deepseek-request-logger');

test('captures the actual outbound chat payload without changing the reply or recording the API key', async t => {
  const base = path.resolve(__dirname, '../.cache');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'request-logger-test-'));
  const originalFetch = global.fetch;
  const keys = ['DEEPSEEK_REQUEST_LOG_DIR', 'DEEPSEEK_REQUEST_LOG', 'DEEPSEEK_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DEEPSEEK_REQUEST_LOG_DIR = directory;
  process.env.DEEPSEEK_REQUEST_LOG = '1';
  process.env.DEEPSEEK_API_KEY = 'synthetic-api-key-must-not-appear-in-logs';
  t.after(() => {
    global.fetch = originalFetch;
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    assert.equal(path.dirname(directory), base);
    assert.ok(path.basename(directory).startsWith('request-logger-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let transmitted;
  global.fetch = async (url, options) => {
    transmitted = { url, body: options.body };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '先核查订单状态，再决定下一步。' }, finish_reason: 'stop' }] }) };
  };
  const { chatDeepSeek } = require('../lib/deepseek-engine');
  const question = '这个工单下一步应该怎么处理？';
  const result = await chatDeepSeek({ model: 'deepseek-v4-flash', body: {
    messages: [{ role: 'user', content: question }],
    thread_context: { subject: 'Synthetic test', thread_text: 'Customer asks to cancel renewal.' },
    order_context: 'Synthetic order status: PAID'
  } });
  assert.equal(result.reply, '先核查订单状态，再决定下一步。');
  const contents = fs.readFileSync(path.join(directory, 'latest.json'), 'utf8');
  const record = JSON.parse(contents);
  assert.equal(record.url, transmitted.url);
  assert.equal(JSON.stringify(record.body), transmitted.body);
  assert.equal(record.headers.Authorization, 'Bearer [REDACTED]');
  assert.ok(!contents.includes(process.env.DEEPSEEK_API_KEY));
  assert.equal(record.body.messages.at(-1).content, question);
  assert.ok(record.body.messages[0].content.includes('Customer Order Information'));
  assert.ok(record.body.messages[0].content.includes('[COMPANY CONTEXT]'));
  assert.equal(record.body.response_format, undefined);
  assert.equal(record.body.max_tokens, 2400);
  assert.ok(fs.existsSync(path.join(directory, record.id + '.json')));

  process.env.DEEPSEEK_REQUEST_LOG = '0';
  assert.equal(recordDeepSeekRequest(transmitted.body), null);
  process.env.DEEPSEEK_REQUEST_LOG = '1';
  const notDirectory = path.join(directory, 'a-file');
  fs.writeFileSync(notDirectory, 'test');
  process.env.DEEPSEEK_REQUEST_LOG_DIR = notDirectory;
  const originalWarn = console.warn;
  try { console.warn = () => {}; assert.equal(recordDeepSeekRequest(transmitted.body), null); }
  finally { console.warn = originalWarn; }
});

test('reasoning-only or truncated replies retry with more room and only return final content', async t => {
  const originalFetch = global.fetch;
  const previous = process.env.DEEPSEEK_REQUEST_LOG;
  process.env.DEEPSEEK_REQUEST_LOG = '0';
  t.after(() => { global.fetch = originalFetch; if (previous === undefined) delete process.env.DEEPSEEK_REQUEST_LOG; else process.env.DEEPSEEK_REQUEST_LOG = previous; });
  const { chatDeepSeek } = require('../lib/deepseek-engine');
  const body = { messages: [{ role: 'user', content: '这个工单下一步应该怎么处理？' }] };
  for (const partial of ['', '未完成的回复']) {
    const sent = [];
    global.fetch = async (_url, options) => {
      sent.push(JSON.parse(options.body));
      const first = sent.length === 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: first ? partial : '请先核查授权到期日，再答复客户。', reasoning_content: 'The user asks in Chinese. I should analyze...' }, finish_reason: first ? 'length' : 'stop' }] }) };
    };
    const result = await chatDeepSeek({ model: 'deepseek-v4-flash', body });
    assert.equal(result.reply, '请先核查授权到期日，再答复客户。');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].max_tokens, 2400); assert.equal(sent[1].max_tokens, 8192);
    assert.deepEqual(sent[0].messages, sent[1].messages);
    assert.ok(!result.reply.includes('The user asks'));
  }
});

test('missing final content never returns reasoning, even when the retry is incomplete', async t => {
  const originalFetch = global.fetch;
  const previous = process.env.DEEPSEEK_REQUEST_LOG;
  process.env.DEEPSEEK_REQUEST_LOG = '0';
  t.after(() => { global.fetch = originalFetch; if (previous === undefined) delete process.env.DEEPSEEK_REQUEST_LOG; else process.env.DEEPSEEK_REQUEST_LOG = previous; });
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: '', reasoning_content: 'Hidden reasoning must not be displayed.' }, finish_reason: 'length' }] }) }; };
  const { chatDeepSeek } = require('../lib/deepseek-engine');
  await assert.rejects(() => chatDeepSeek({ model: 'deepseek-v4-flash', body: { messages: [{ role: 'user', content: 'Next step?' }] } }), error => {
    assert.equal(error.code, 'DEEPSEEK_INCOMPLETE_RESPONSE');
    assert.equal(error.status, 502);
    assert.ok(!error.message.includes('Hidden reasoning'));
    return true;
  });
  assert.equal(calls, 2);
});
