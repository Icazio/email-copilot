# 垃圾邮件自动分拣设计方案

> 状态：草案 v1 · 2026-11-17
> 取代：[auto-reply-design.md](auto-reply-design.md)（自动回复方案已搁置，原因见第 1 节）
> 目标：让垃圾邮件不再占用客服时间。系统**只做移动，不做删除，也不对外发任何邮件**。

---

## 1. 背景

- 队列中垃圾邮件占比很高，真实客户工单每天最多 9 封。
- 客服的主要时间花在**分辨和清理垃圾邮件**上，而不是写回复。
- 自动回复的收益有限：按 9 封/天计算，每天只能自动处理约 3 封，省约 15 分钟，却要投入 1～2 人周开发，并承担对外发错邮件的风险。因此改为先解决分拣问题。

## 2. 现状（`extension/content.js` 队列页逻辑）

| 已有能力 | 实现 | 不足 |
|---|---|---|
| 规则打分 | `SPAM_RULES`：按发件人、主题、文本风格加分，≥ 3 分判为垃圾邮件 | 只看主题和预览；打分在 1～2 分之间的邮件无法判断 |
| 视觉标记 | 打 SPAM 徽章，并把该工单半透明显示 | — |
| 拉黑发件人 | `ec-block-btn` 按钮，名单存在 `localStorage` 的 `ec-blocked-senders` 中 | **名单只存在本机浏览器**，换电脑、换人后都会丢失 |
| 一键选中 | `#ec-select-btn` 勾选所有垃圾邮件 | 勾选后仍需人工批量处理；只在打开队列页时才运行 |

## 3. 方案总览：三层过滤

```
        邮件进入 Znuny
              │
   ┌──────────▼──────────┐
   │ 第 1 层：收件过滤规则  │  Znuny 服务器端，邮件入库时生效
   │ 明确的垃圾邮件 → Junk 队列 │  （需管理员配置，不写代码）
   └──────────┬──────────┘
              │ 剩余邮件进入正常队列
   ┌──────────▼──────────┐
   │ 第 2 层：插件规则 + AI │  在队列页运行
   │ 判定为 垃圾 / 正常 / 不确定 │  共享拉黑名单 + 白名单
   └──────────┬──────────┘
              │
   ┌──────────▼──────────┐
   │ 第 3 层：自动移走      │  Runner 窗口定时运行
   │ 高置信度垃圾 → Junk 队列 │  只移动不删除，每日汇总
   └─────────────────────┘
```

三层**相互独立，可以单独上线**。只做第 1 层就能挡掉大部分垃圾邮件。

## 4. 第 1 层：Znuny 收件过滤规则（PostMaster Filter）

**做法**：请 Znuny 管理员在「系统管理 → PostMaster 过滤器」中新建规则：匹配 `From` 或 `Subject` 的正则表达式，命中后设置队列头（`X-OTRS-Queue`，具体头名以所用 Znuny 版本为准）= `Junk`。

**只放强信号规则**，也就是现有规则中单条就达到 3 分、误判可能很小的那些：

| 规则名 | 匹配字段 | 正则 |
|---|---|---|
| spam-noreply-sender | From | `(newsletter\|mailer\|bulk)@` |
| spam-seo-guestpost | Subject | `guest\s*post\|do[\s-]?follow\|link[\s-]?build\|article\s*submission` |
| spam-seo-authority | Subject | `high\s+(da\|domain\s*authority)\|high\s+authority\s+placement\|promote\s+(your\s+)?website` |
| spam-pr-collab | Subject | `press\s+release\|collaboration\s+op+ortunity\|featured\s+on` |
| spam-blocklist | From | 由共享拉黑名单生成（见 5.3），定期同步给管理员 |

注意：
- **不放 `noreply@`、`no-reply@`**：支付平台（Paddle、Stripe）和应用商店的通知也用这类地址发信，可能是需要处理的退款或争议通知。这类邮件交给第 2 层判断。
- 规则在测试队列上验证一周后，再改为转到 Junk 队列。
- 管理员每周查看一次 Junk 队列，有误判的邮件就移回原队列，并调整规则。

## 5. 第 2 层：插件规则 + AI 复核

### 5.1 判定流程（队列页，每张工单）

```
发件人在白名单中？        → 正常（不再继续判断）
发件人在拉黑名单中？      → 垃圾（BLOCKED）
规则得分 ≥ 3              → 垃圾（SPAM）
其余（0～2 分）           → 发给后端 /spam/classify 由 AI 判定
                            spam 且 confidence ≥ 0.9  → 垃圾（AI-SPAM）
                            unsure 或置信度不足       → 不确定（显示黄色 ? 徽章，由人判断）
                            ham                       → 正常
```

### 5.2 白名单（防止误判真实客户）
满足以下任一条件的发件人，**永远不会被判为垃圾邮件**：
- 在 `AgentOrderSearch` 中能查到订单（复用 `queue-order-lookup.js`，查询结果缓存 7 天）
- 曾被客服手动标记为“不是垃圾邮件”（见 5.4）
- 手动维护的域名名单，如 `paddle.com`、`stripe.com`、`paypal.com`、`apple.com`

### 5.3 共享拉黑名单和白名单（存到后端）
- 新增 `backend/data/spam-lists.json`：
  ```json
  { "blocked_senders": [], "blocked_domains": [], "allowed_senders": [], "allowed_domains": [] }
  ```
- 新增接口：`GET /spam/lists`，以及 `POST /spam/lists`（`{ action: "block" | "unblock" | "allow" | "disallow", email | domain }`）。
- 插件启动时拉取名单，缓存 5 分钟；客服点击拉黑或取消拉黑后立即写回后端。
- **迁移**：插件首次连上新版后端时，自动把本机 `localStorage` 里的 `ec-blocked-senders` 合并上传，然后删除本地这份数据。
- 面板中提供「导出过滤规则」按钮：把 `blocked_domains` 和 `blocked_senders` 生成为第 1 层可以直接使用的正则，方便交给管理员。

### 5.4 AI 复核接口：`POST /spam/classify`
请求（只发送判断所需的最少内容）：
```js
{ ticket_id, sender, subject, preview }   // preview 为队列页显示的正文预览，截取前 500 字符
```
响应：
```js
{ verdict: "spam" | "ham" | "unsure", confidence, reason }   // reason 为一句中文说明，显示在徽章的悬停提示里
```
- 提示词放在 `backend/prompts/spam-classify.json`，说明公司业务：AVCLabs 视频/图片 AI 软件的客服，客户会来询问购买、退款、激活、技术问题。并附上若干正例和反例。
- 结果按 `ticket_id` 在后端缓存，同一张工单不重复判断。
- 引擎调用失败时，返回 `unsure`，**不回退到 mock 引擎**。

### 5.5 人工纠正与反馈
- 每张工单旁增加「不是垃圾」和「是垃圾」两个按钮：
  - 「不是垃圾」→ 把发件人加入白名单
  - 「是垃圾」→ 弹出选项：仅本封，或拉黑这个发件人，或拉黑整个域名
- 每次纠正都记录到 `backend/logs/spam/YYYY-MM-DD.jsonl`，用于统计误判率，并作为调整规则和提示词的依据。

## 6. 第 3 层：自动移走

只有当第 2 层在队列页上的误判率足够低之后（见第 9 节），才启用这一层。

### 6.1 运行方式
沿用上一版方案中的 Runner 设计，但**范围大幅缩小**：
- 在一台常开的机器上开一个专用 Chrome 窗口，以 `ai-bot` 账号登录，固定一个 Runner 标签页。
- `chrome.alarms` 每 10 分钟唤醒一次 → Runner 用 `fetch` 拉取队列页 → 用 `DOMParser` 解析 → 按第 2 层逻辑判定 → 移动垃圾邮件。
- **只需要实现「移动工单」这一种写操作**：调用 `AgentTicketMove`，或者对多张工单用 `AgentTicketBulk` 设置队列为 `Junk`。不涉及回复表单，也不对外发邮件。

### 6.2 自动移动的条件（全部满足才移动）
- 判定结果为 BLOCKED、SPAM（≥ 3 分），或 AI-SPAM（置信度 ≥ 0.9）
- 发件人不在白名单中，且查不到订单
- 工单未被锁定，且只有 1 篇文章（只处理新进来的首封邮件；已有往来的工单不碰）
- 当日自动移动数量未超过上限 `daily_move_cap`（默认 50，超过就暂停并发出通知）

### 6.3 防误判措施
- **只移动，不删除，不关闭**：工单仍在 Junk 队列中，随时可以移回。
- **每日汇总**：每天早上在面板中生成一份「昨日自动移走清单」，列出发件人、主题、判定原因，并提供一键移回按钮。
- 被移回的工单，发件人会自动加入白名单。

### 6.4 配置：`backend/data/spam-triage-policy.json`
```json
{
  "mode": "shadow",
  "poll_interval_min": 10,
  "ai_min_confidence": 0.9,
  "daily_move_cap": 50,
  "junk_queue": "Junk",
  "source_queues": ["avclabs"]
}
```
`mode` 有三个值：`off` | `shadow`（只记录“本来会移走哪些”，不实际移动）| `live`。

## 7. 代码改动清单

```
extension/
  content.js        修改：spamScore 之外增加白名单、AI 复核、黄色徽章、纠正按钮；拉黑名单改为从后端读写
  spam-runner.js    新增（第 3 层）：Runner 主流程
  znuny-io.js       新增（第 3 层）：拉取队列、移动工单
  background.js     修改（第 3 层）：alarms 调度、Runner 健康检查
  manifest.json     修改（第 3 层）：加 alarms 权限
  panel.html/js     修改：分拣页签——统计、每日汇总、导出过滤规则
backend/
  server.js         修改：/spam/lists、/spam/classify、/spam/feedback、/spam/stats
  lib/spam-classifier.js   新增
  prompts/spam-classify.json  新增
  data/spam-lists.json        新增
  data/spam-triage-policy.json 新增（第 3 层）
```

依然零依赖、无构建步骤。后端只监听 `127.0.0.1`。

## 8. 成本

| 项目 | 估算 |
|---|---|
| AI 复核 | 每封约 400 tokens 输入、50 tokens 输出，约 $0.00018。**即使每天 100 封（含垃圾邮件），每月也只要约 $0.5（¥4）**。规则已经判定的邮件不调用 AI，实际会更少。 |
| 第 1 层 | 管理员配置约半天；没有运行成本 |
| 第 2 层开发 | 约 3～5 天 |
| 第 3 层开发 | 约 3～5 天，外加常开机器（约 ¥20/月电费） |

单价按 DeepSeek V4.1 Flash（输入 $0.30、输出 $1.20 / 百万 tokens，来自第三方汇总）计算，以控制台账单为准。

## 9. 分期上线

| 阶段 | 内容 | 时长 | 进入下一阶段的条件 |
|---|---|---|---|
| P0 | 第 1 层：整理强信号规则，交给管理员配置；先在测试队列观察 | 1 周 | Junk 队列中没有真实客户邮件 |
| P1 | 第 2 层：共享名单 + 白名单 + AI 复核 + 纠正按钮，**只做标记，不移动** | 2 周 | AI-SPAM 判定的误判率 < 2%（按纠正记录统计） |
| P2 | 第 3 层 shadow 模式：Runner 只记录“本来会移走哪些” | 1 周 | 对照人工处理结果，没有误移 |
| P3 | 第 3 层 live 模式 | 持续 | 每周检查一次每日汇总和纠正记录 |

## 10. 对现有约定的影响
- `CLAUDE.md` 写着工具 “read-only by design”。第 1、2 层不改变这一点：第 1 层是 Znuny 自带功能，第 2 层只做标记，以及读写后端的名单。
- 第 3 层会写入 Znuny（移动工单），上线时需要同步更新 `CLAUDE.md`。

## 11. 待确认问题

1. Znuny 中有没有 `Junk` 队列？管理员能否配置 PostMaster 过滤器？
2. 每天进入队列的邮件**总数**大约是多少（含垃圾邮件）？用于判断第 3 层是否值得做。
3. 平时有几位客服在处理这些队列？会影响共享名单的必要性。
4. 支付平台、应用商店的通知邮件是否也进入这个队列？会影响白名单域名的设置。
5. 现有的拉黑名单是否只在你的浏览器里？需要迁移的数据有多少？
