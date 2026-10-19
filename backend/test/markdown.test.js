const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('../admin/app');

test('knowledge Markdown renders headings, emphasis, lists and preserves the source', () => {
  const source = '# 退款政策\n\n## 申请条件\n\n**5 天内**申请，先核查 *订单*，勿~~直接承诺~~。\n\n- 购买邮箱\n- 订单号\n  - 支付渠道\n\n1. 查询订单\n2. 核实状态';
  const html = renderMarkdown(source);
  assert.ok(html.includes('<h1>退款政策</h1>'));
  assert.ok(html.includes('<h2>申请条件</h2>'));
  assert.ok(html.includes('<strong>5 天内</strong>'));
  assert.ok(html.includes('<em>订单</em>'));
  assert.ok(html.includes('<del>直接承诺</del>'));
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  assert.ok(html.includes('<ol>'));
  assert.ok(source.includes('**5 天内**'));
});

test('tables, quotes, code blocks, inline code and task lists', () => {
  const html = renderMarkdown('| 套餐 | 期限 |\n| :--- | ---: |\n| 月度 | **5 天** |\n| 永久 | 30 天 |\n\n> 先核查订单。\n\n```html\n<script>alert(1)</script>\n```\n\n字段为 `order_id`。\n\n- [x] 已核查\n- [ ] 待处理');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('class="md-align-right"'));
  assert.ok(html.includes('<strong>5 天</strong>'));
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>'));
  assert.ok(html.includes('<code>order_id</code>'));
  assert.ok(html.includes('disabled checked'));
  assert.ok(!html.includes('<script>'));
});

test('untrusted HTML and links cannot insert scripts, handlers or remote images', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n[bad](javascript:evil) [encoded](javascript&colon;evil) [data](data:text/html,evil)\n\n[good](https://example.com/p?q=%22) [mail](mailto:support@example.com)\n\n![remote](https://tracker.example/image.png)\n\n`<svg onload=alert(1)>`');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(!html.includes('href="data:'));
  assert.ok(html.includes('href="https://example.com/p?q=%22"'));
  assert.ok(html.includes('href="mailto:support@example.com"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('&lt;img'));
});

test('plain text, escaped Markdown and unterminated fences remain readable', () => {
  assert.equal(renderMarkdown('第一步\n第二步'), '<p>第一步<br>第二步</p>');
  assert.ok(renderMarkdown('\\*原样星号\\*').includes('*原样星号*'));
  assert.ok(renderMarkdown('```\n<unsafe>').includes('&lt;unsafe&gt;'));
  assert.equal(renderMarkdown(''), '');
});
