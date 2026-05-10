# Dev Log

---

## 2026-05-10 — 队列页垃圾邮件识别 & 订单信息展示

### 背景
客服每天需要在 OTRS/Znuny 队列中手动甄别垃圾邮件（SEO 外链推销、新闻站付费投放、网红合作邀约等），逐一打开确认后再批量转移到 Junk 队列，效率低且容易误操作。同时，客服打开工单前无法快速了解客户的购买历史，需要手动查询订单系统。

本次开发在队列页直接注入两个功能模块，无需打开工单即可完成大部分判断。

---

### 功能一：垃圾邮件识别与批量操作（`extension/content.js`）

#### 识别引擎
放弃简单关键词命中，改用**加权评分制**（阈值 ≥ 3 分）。多个弱信号叠加才触发标记，避免单词误伤。

评分规则分为四层：
- **发件人信号**：`newsletter@`、`noreply@`、域名含 marketing/promo 等（+2~3）
- **主题强信号**：guest post、do follow、link building、press release、featured on、collaboration opportunity、promote your website、high DA 等（+3）
- **主题中等信号**：shop now、huge savings、special rates、quality websites、SEO、backlinks 等（+2）
- **文本风格**：正文含 `unsubscribe`（+3）；多个全大写词或感叹号（+1）

**检测范围**：工单标题 + 预览区邮件主题 + `ArticleBody` 正文内容，三者合并评分。解决了发件人用模糊标题规避过滤、实质内容在正文的情况。

#### 视觉标记
- 命中工单：整行透明度 50%，标题前插入红色 **SPAM** 徽章

#### 批量操作
- 右下角浮动按钮「选中垃圾邮件 (N)」，点击勾选所有 SPAM 工单复选框
- 用户可取消误标条目后，使用系统原有批量操作转移到 Junk 队列

#### 发件人黑名单
- 黑名单持久化存储于 `localStorage`
- 客户 ID 旁显示 **Block sender** 按钮，点击加入黑名单
- 黑名单命中直接显示紫色 **BLOCKED** 徽章，跳过规则计算，支持 **Unblock** 撤销
- 解决重复骚扰的发件人无需再次匹配规则的问题

---

### 功能二：队列订单信息展示（`extension/queue-order-lookup.js`）

队列页每个工单的元数据区自动显示该客户的最新购买记录：

```
AVCLabs Video Enhancer AI (Win)
2026-05-09 · EUR65.95 · PAID
```

#### 实现要点
- 从每个工单的「客户 ID」字段取邮箱，调用 `AgentOrderSearch` 接口查询
- **Paddle 中转邮件处理**：客户 ID 为 `assist@paddle.com` 时，自动从 `ArticleBody` 正文提取真实客户邮箱
- **解析器**：新增直接 DOM 解析器（`parseOrderRowsDom`），直接读取 `h4` + `p.FieldExplanation` 配对结构，解决原 regex 解析器因 `<span>` 标签导致财务字段提取失败的问题
- **多笔订单**：按购买日期降序排列，显示最新一笔 + `(+N more)`
- **缓存**：Token 上下文缓存 10 分钟，查询结果缓存 5 分钟
- **并发控制**：最多 3 个并发请求，不阻塞页面

---

### 调研文档

`docs/naive-bayes-evaluation.md` — 记录了对 nbayes、credulous、bayes 三个 JS Naive Bayes 库的调研结论：均无预训练模型，冷启动代价高，短文本效果差，当前场景不适用。保留为未来积累足够标注数据后的优化选项。

---

### 文件变更
| 文件 | 变更 |
|---|---|
| `extension/content.js` | 垃圾邮件识别引擎、视觉标记、批量选中、发件人黑名单 |
| `extension/manifest.json` | 新增 `queue-order-lookup.js` content script |
| `extension/queue-order-lookup.js` | 新增：队列页订单查询与展示 |
| `docs/naive-bayes-evaluation.md` | 新增：Naive Bayes 库调研报告 |
