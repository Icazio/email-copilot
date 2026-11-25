# 自动回复（Auto Mode）设计方案

> ⚠️ **已搁置（2026-11-17）**：真实工单量太少（≤ 9 封/天），自动回复的投入产出不划算，主要负担来自垃圾邮件。当前方案见 [spam-triage-design.md](spam-triage-design.md)。本文档保留，供以后工单量上升时参考。

> 状态：草案 v2 · 2026-11-09
> 目标：让系统在无人值守的情况下处理 Znuny 新工单。低风险工单由 AI 直接回复客户，其余工单由 AI 预写内部备注草稿，客服一键采用。
> 实现路线：**插件自动模式**——在一个专用的 Chrome 窗口中，由插件以 `ai-bot` 客服身份运行。第一期**不需要 Znuny 管理员开通接口**。

---

## 1. 背景与现状

当前系统是「人在环」的 Copilot：

```
客服打开工单页 → 插件 content.js 抓取线程 → 后端 /analyze-thread、/generate-draft → 客服复制、修改、发送
```

插件已经具备自动化所需的大部分能力，第一期选择在插件里做，不另起一个后台进程：

| 能力 | 现有实现 | 自动模式复用方式 |
|---|---|---|
| 读取工单线程 | `content.js` → `collectZnunyThreadText()`，抓取每篇文章的 iframe HTML | 改成可以对任意 `Document` 执行，不再只读当前页面 |
| 订单信息 | `queue-order-lookup.js` 以登录态调用 `AgentOrderSearch` | 直接调用 |
| 队列页识别 | `content.js` → `initQueueSpamFlags()` | 参考它解析队列列表 |
| 分析和起草 | 后端 `analyzeThread*` / `generateDraft*` | 原样调用 |

### 路线对比（记录决策依据）

| | **A 插件自动模式（本方案）** | B 后台进程 + Znuny REST |
|---|---|---|
| Znuny 侧要求 | 一个普通客服账号 | 开通 GenericInterface 接口、建账号、加动态字段 |
| 订单信息 | ✅ 复用现有逻辑 | ❌ 需要新开接口 |
| 运行环境 | 一台常开的机器，Chrome 保持登录 | 任意服务器 |
| 稳定性 | 依赖 Znuny 页面结构 | 依赖接口，更稳定 |

**策略**：先用 A 跑通影子期和小范围放量。等证明效果后，如有需要再迁移到 B。为此，**决策逻辑放在后端**（见第 3 节），插件只负责和 Znuny 之间的读写，迁移时只需要换掉读写这一层。

## 2. 总体架构

```
┌──────── 专用 Chrome 窗口（以 ai-bot 登录 Znuny）────────┐          ┌────────── 本机后端 :8787 ──────────┐
│                                                     │          │                                   │
│  background.js                                      │          │  POST /auto/process               │
│   └─ chrome.alarms 每 N 分钟唤醒一次 ──┐               │          │   ├─ 过滤（去重、上限、防自动回复）    │
│                                    ▼               │  HTTP    │   ├─ analyzeThread*               │
│  Runner 标签页（固定的 Znuny 页面）                    │ ───────▶ │   ├─ policy-gate（决策）            │
│   └─ auto-runner.js（content script）               │          │   ├─ generateDraft*               │
│       1. fetch 队列页 → 解析新工单                     │ ◀─────── │   ├─ draft-guard（发送前检查）       │
│       2. fetch 工单页 + 文章 iframe → 线程            │  决策结果 │   └─ 写审计日志、更新状态             │
│       3. AgentOrderSearch → 订单信息                 │          │                                   │
│       4. 按决策结果提交 Note / Compose 表单            │          │  POST /auto/commit（写回结果）       │
└─────────────────────────────────────────────────────┘          └───────────────────────────────────┘
```

设计要点：
- **不在标签页之间跳转**：Runner 标签页始终停在 Znuny 页面上，所有读写都在同源下通过 `fetch(..., { credentials: "include" })` 完成，用 `DOMParser` 解析返回的 HTML。这和 `queue-order-lookup.js` 现在的做法一致，比打开、切换标签页稳定得多。
- **MV3 的 Service Worker 会休眠**，所以用 `chrome.alarms` 定时唤醒，再通知 Runner 标签页开始一轮。需要在 manifest 中新增 `alarms` 权限。
- **规则和状态都放在后端**：白名单、阈值、去重记录、每日上限、审计日志都由后端维护。插件里不存业务规则。
- 依然零依赖、无构建步骤。

### 新增和修改的文件

```
extension/
  auto-runner.js             新增：自动模式主流程（只在 Runner 标签页启用）
  znuny-io.js                新增：Znuny 读写封装（队列、工单、文章、Note 和 Compose 表单）
  content.js                 修改：把 collectZnuny* 改为接受 Document 参数（默认 document）
  background.js              修改：alarms 调度、Runner 标签页的健康检查和恢复
  manifest.json              修改：加 alarms 权限，content_scripts 加入新文件
  panel.html / panel.js      修改：加「自动模式」页签——开关、状态、最近处理记录
backend/
  server.js                  修改：新增 /auto/process、/auto/commit、/auto/stats
  lib/auto-pipeline.js       新增：过滤 → 分析 → 决策 → 起草 → 检查
  lib/policy-gate.js         新增：决策
  lib/draft-guard.js         新增：发送前检查
  data/auto-reply-policy.json  新增：配置（可热加载）
  state/processed.json       新增：已处理记录
  logs/auto-reply/YYYY-MM-DD.jsonl  新增：审计日志
```

## 3. 处理流程

### 3.1 唤醒与自检（background.js）
每次 alarm 触发时：
1. 找到标记为 Runner 的标签页（URL 中带 `#email-copilot-runner`）。没有就新开一个并固定。
2. 检查是否已登录：如果页面跳转到了登录页，就暂停自动模式，在面板上显示「需要重新登录」，并发出系统通知。**插件不保存、也不自动填写密码。**
3. 确认后端 `/health` 正常、自动模式开关处于开启状态后，向 Runner 发送 `AUTO_RUN_TICK` 消息。
4. 用一个锁保证同一时间只运行一轮：上一轮还没结束时，本次直接跳过。

### 3.2 拉取新工单（znuny-io.js）
- `fetch` 目标队列的列表页：`Action=AgentTicketQueue;QueueID=…`，或者用保存好的搜索条件 `AgentTicketSearch`。
- 解析出 TicketID、TicketNumber、状态、锁定状态、负责人、最后更新时间。
- 只保留以下工单：状态为 `new`，或状态为 `open` 且最后一篇文章来自客户；**未锁定**；最近 24 小时内有更新。
- 每轮最多处理 `max_tickets_per_run` 张。

### 3.3 读取线程和订单
- `fetch` `AgentTicketZoom` 页面并用 `DOMParser` 解析，再调用改造后的 `collectZnunySubject(doc)` 和 `collectZnunyThreadText(doc)`，得到和现在完全相同的 `thread_structured` 结构。
- 读取每篇文章的方向、发件人和邮件头（Zoom 页面能看到的部分），用于识别自动回复邮件。
- 用客户邮箱调用 `AgentOrderSearch` 得到 `order_context`。查询失败时置空，不阻断流程（后端遇到依赖订单信息的类别会转人工）。

### 3.4 后端处理：`POST /auto/process`

请求：
```js
{
  ticket: { id, number, queue, state, locked, owner },
  last_article: { id, direction, sender, headers },   // headers 只放 Auto-Submitted / X-Autoreply 等少数几个
  subject, thread_text, thread_structured, order_context
}
```

响应：
```js
{
  decision: "AUTO_SEND" | "DRAFT_NOTE" | "SKIP",
  reason: "category_not_whitelisted",
  category, confidence, summary, next_step,
  reply_body,          // AUTO_SEND 时：最终发给客户的纯文本
  note_body,           // DRAFT_NOTE 时：内部备注全文（格式见 3.7）
  run_id               // 用于 /auto/commit 对账
}
```

后端内部依次执行以下步骤：

**① 过滤（不调用 AI）**：满足以下任一条件就返回 SKIP：
- `processed.json` 中已有相同的 `TicketID + ArticleID`
- 最后一篇文章不是客户发的
- 发件人符合 `noreply|mailer-daemon|postmaster`，或带有 `Auto-Submitted: auto-*` / `X-Autoreply` 等邮件头（防止与对方的自动回复互相触发，形成循环）
- 该工单 7 天内已经自动发送过 1 次

**② 分析**：调用 `analyzeThread*`。失败时**不能**像 HTTP 服务那样回退到 mock 引擎，而是返回 SKIP（原因 `engine_error`），下一轮再试。

**③ 决策（policy-gate）**：按顺序判定，命中任意一步就停止：
1. `mode=off` → SKIP；`mode=shadow` → 最多只能 DRAFT_NOTE
2. 风险信号（关键词加 AI 判定）：投诉、律师、chargeback、PayPal 争议、辱骂、要求见主管 → DRAFT_NOTE，并加 `urgent` 标记
3. 客户语言不在支持列表内 → DRAFT_NOTE
4. 类别不在 `auto_send` 白名单内 → DRAFT_NOTE
5. `confidence` 低于该类别的阈值 → DRAFT_NOTE
6. 当日自动发送数已达 `daily_auto_send_cap` → DRAFT_NOTE（熔断）
7. 以上都通过 → AUTO_SEND

**④ 起草**：调用 `generateDraft*`，传入分析得到的 `category` 和 `suggested_template_id`，以及 `order_context`。

**⑤ 发送前检查（draft-guard，只对 AUTO_SEND 生效）**：全部用规则实现，任意一条不通过就降级为 DRAFT_NOTE，并在备注中写明原因：
- 草稿长度在 80～2500 字符之间
- 不含 Markdown 痕迹（`**`、`#`、行首的 `- `），也不含 `[占位符]`、`{{…}}`、`TODO`
- 是英文
- 不含承诺类措辞：`refund(ed)? (has been|will be) (issued|processed)`、`we will refund`、`guarantee` 等
- 不含原线程和订单信息中都没有出现过的金额、订单号、激活码（防止 AI 编造）

### 3.5 类别策略（第一期）

| 类别 / 模板 | 策略 | 理由 |
|---|---|---|
| `invoice` / `invoice_request_v1` | AUTO_SEND（阈值 0.85） | 固定流程，没有承诺风险 |
| `cancel_renewal` / `cancel_renewal_v1` | AUTO_SEND（阈值 0.85） | 只是操作指引 |
| `general` 中的产品反馈或功能建议 | AUTO_SEND（阈值 0.9） | 感谢加记录，不做承诺 |
| `technical` / `technical_issue_collect_info_v1` | 只有**首封**回复 AUTO_SEND，后续转 DRAFT | 首封只做信息收集（系统、版本、日志） |
| `refund` / `refund_auto_renewal_v1` | DRAFT_NOTE | 政策要求不得直接承诺退款，需要人工提交给负责人 |
| `account` / `license_code_not_working_v1` | DRAFT_NOTE | 需要人工重置激活 |
| `free_credit` / `free_credit_youtube_v1` | DRAFT_NOTE | 需要人工核验截图并发放积分 |
| 其他、无法识别 | DRAFT_NOTE | 默认保守处理 |

`confidence` 是模型自己报的分数，只作为**辅助**条件；真正的安全保障来自**类别白名单**加发送前检查。

### 3.6 写回 Znuny（znuny-io.js）

写回前，先重新 `fetch` 一次工单页，确认**最后一篇文章没有变化、工单仍未锁定**。如果在这期间客服接手了工单，就放弃写回，并向后端提交 `aborted`。

- **DRAFT_NOTE** → `AgentTicketNote`：
  1. `fetch` 表单页，解析出 `ChallengeToken`、`FormID` 等隐藏字段
  2. 填写 Subject `[AI 草稿] <类别>`、Body 为 `note_body`，文章类型选「内部」
  3. 以 `multipart/form-data` 方式 POST 提交，然后检查返回页面，确认提交成功
- **AUTO_SEND** → `AgentTicketCompose`（回复）：
  1. `fetch` 回复表单，解析隐藏字段，并检查收件人默认填的就是客户邮箱
  2. Body 为 `reply_body` 加统一签名；下一状态设为 `pending auto close+`
  3. POST 提交后，重新读取工单，确认多了一篇对外文章
- 提交结果通过 `POST /auto/commit { run_id, outcome: "sent" | "noted" | "aborted" | "failed", article_id }` 回报后端。后端据此更新 `processed.json` 和审计日志。

> 表单字段名会随 Znuny 版本和配置不同而变化。所以 `znuny-io.js` 会先把表单里**所有**隐藏字段原样带上，只覆盖需要修改的字段，并在 P0 阶段针对实际环境录制和校验字段。

### 3.7 内部备注格式

```
[AI 草稿] 类别：refund · 置信度：0.82 · 转人工原因：类别不在白名单
摘要：……
建议下一步：……
───── 草稿（可直接复制） ─────
……
```

## 4. 配置

### 4.1 `backend/data/auto-reply-policy.json`

```json
{
  "mode": "shadow",
  "poll_interval_min": 3,
  "max_tickets_per_run": 10,
  "lookback_hours": 24,
  "queues": ["avclabs"],
  "languages": ["en"],
  "max_auto_replies_per_ticket": 1,
  "daily_auto_send_cap": 100,
  "auto_send": {
    "invoice": { "min_confidence": 0.85 },
    "cancel_renewal": { "min_confidence": 0.85 },
    "general_feedback": { "min_confidence": 0.9 },
    "technical_first_reply": { "min_confidence": 0.8 }
  },
  "escalation_keywords": ["chargeback", "lawyer", "attorney", "dispute", "scam", "fraud", "complaint", "BBB"],
  "signature": "Best regards,\nAVCLabs Support Team",
  "business_hours_only": false
}
```

- `mode` 有三个值：`off` | `shadow`（只写备注）| `live`
- 每次请求都会重新读取这个文件，改配置不用重启。
- 紧急停止有两种方式：在 `.env` 中设 `AUTO_REPLY_MODE=off`（优先级高于 policy.json），或者在插件面板上关闭自动模式开关。任何一处关闭都会立即生效。

### 4.2 插件面板「自动模式」页签
- 开关（默认关闭；开启后只在当前这个 Chrome 配置文件中生效）
- 状态：上次运行时间、今日处理数、自动发送数、写草稿数、跳过数、熔断状态（数据来自 `/auto/stats`）
- 最近 20 条处理记录，点击可跳转到对应工单
- 提示「这个窗口请勿手动使用」

## 5. 部署与运行环境

1. 准备一台**常开的 Windows 机器**（虚拟机或闲置电脑都可以），关闭睡眠。
2. 请 Znuny 管理员新建客服账号 `ai-bot`，只授予目标队列的读写权限。这是**唯一**需要管理员做的事。
3. 新建一个独立的 Chrome 配置文件「Email Copilot Bot」，以 `ai-bot` 登录 Znuny，并在 Znuny 中延长这个账号的会话有效期。
4. 加载插件，打开面板，开启自动模式。
5. 本机运行后端（`run-backend.cmd`），并设为开机自启（任务计划程序）。Chrome 也设为开机自启并恢复上次打开的页面。
6. 会话过期需要重新登录时，插件会发出通知，由人工登录。**插件不保存、不自动填写密码。**

## 6. 安全与风险控制

| 风险 | 控制措施 |
|---|---|
| 与客户的自动回复互相触发，来回发信 | 识别 `Auto-Submitted` 等邮件头和 noreply 发件人；单工单 7 天内最多自动发送 1 次 |
| AI 编造事实或做出承诺 | 类别白名单 + 发送前规则检查 + 高风险类别只写草稿 |
| 大规模误发 | 每日上限熔断；面板开关和 `.env` 两处都能紧急关停 |
| 与客服同时处理同一工单 | 跳过已锁定的工单；写回前重新读取并对比最后一篇文章 |
| Znuny 页面改版导致解析或提交失败 | 提交后都会重新读取工单验证结果；连续失败 3 次就自动暂停自动模式并发出通知 |
| 机器或浏览器宕机 | 只会漏处理，不会误发；工单仍留在队列里由人工处理；面板显示上次运行时间 |
| 客户隐私 | 审计日志只记录工单号、类别、决策和草稿哈希，不记录正文；自动模式下默认关闭 `.cache/deepseek-requests` |
| 后端暴露在网络上 | 后端只监听 `127.0.0.1` |

## 7. 可观测性

- 审计日志按天写一个 jsonl 文件，每张工单一行：
  `{ ts, run_id, ticketId, articleId, category, confidence, decision, reason, guardFailures[], outcome, engine, ms }`
- `GET /auto/stats`：今日各决策数量、各类别数量、失败次数、熔断状态。
- **采纳率**是评估 AI 质量的核心指标：影子期内，对比客服最终发出的回复和 AI 草稿的相似度。离线脚本 `backend/scripts/adoption-report.js` 读取审计日志，再去 Znuny 抓取对应工单后续的对外文章来计算。

## 8. 分期上线

| 阶段 | 时长 | mode | 内容 | 进入下一阶段的条件 |
|---|---|---|---|---|
| P0 开发 | 1～2 周 | off | 改造 `collectZnuny*`，完成 znuny-io 和后端 pipeline；在**测试队列**中录制、校验 Note 和 Compose 表单的字段 | 测试队列连续 3 天没有重复处理、没有提交失败 |
| P1 影子 | 2 周 | shadow | 所有工单只写内部备注；客服照常回复 | 白名单类别的采纳率 ≥ 85%，发送前检查没有漏检 |
| P2 小范围 | 2 周 | live | 只开放 `invoice` + `cancel_renewal`，日上限 20 | 一周内客户投诉和二次追问没有上升 |
| P3 扩展 | 持续 | live | 逐步加入反馈类、技术首封 | 按类别分别评估 |
| （可选）迁移 | — | — | 自动模式长期运行、稳定性要求变高后，切换到路线 B（REST 后台进程），只需替换插件中的 Znuny 读写层 | — |

## 9. 不在本期范围

- 自动执行业务操作（退款、重置激活、发放积分）：AI 只写回复和备注。
- 多轮自动对话：每张工单只自动回复一次，之后交给人工。
- 附件和图片理解（如 YouTube 订阅截图核验）。
- 客服日常使用的插件功能（侧边栏起草）保持不变。

## 10. 对现有约定的影响

`CLAUDE.md` 中写着工具 “read-only by design”。自动模式上线后，插件在 Runner 窗口中会写入 Znuny（备注和回复）。届时需要同步更新 `CLAUDE.md`，说明这只限于 Runner 窗口，并且受 `auto-reply-policy.json` 控制。

## 11. 待确认问题

1. 能否为 `ai-bot` 申请一个客服账号，并延长它的会话有效期？
2. 自动回复的签名用什么名字：署 “AVCLabs Support Team”，还是使用某位客服的个人署名？
3. 是否需要只在工作时间自动发送？
4. 第一期开放自动发送的类别，是否同意第 3.5 节的建议？
5. 用哪台机器作为常开的运行环境？

## 12. 成本估算（2026-11-09）

### 12.1 单张工单的 token 用量（实测）
数据来源：`backend/logs/deepseek-debug.log` 中 114 次真实调用。

| | 平均 | P90 |
|---|---|---|
| 每次调用 输入 tokens | 2,229 | 3,193 |
| 每次调用 输出 tokens | 788 | 1,210 |

每张工单调用 2 次（分析 + 起草）：**平均约 4.5k 输入 + 1.6k 输出**，保守估计（P90）约 6.4k 输入 + 2.4k 输出。计算时不扣除缓存命中，结果偏保守。

### 12.2 单价
`.env` 里配置的 `deepseek-v4-flash` 已经退役，现在由 DeepSeek-V4.1-Flash 提供服务，并按 Flash 的价格计费。官方价格页没能直接读到，下面按第三方汇总的价格计算，**以 DeepSeek 控制台账单为准**：
- V4.1 Flash（基准）：输入 $0.30 / 1M tokens，输出 $1.20 / 1M tokens
- 原 V4 Flash（下限参考）：输入 $0.14 / 1M tokens，输出 $0.28 / 1M tokens

### 12.3 每月 API 费用（按 30 天计，未打折）

| 日均新工单 | 月工单数 | 平均 | 保守（P90 + 20% 重试余量） |
|---|---|---|---|
| **9（实际峰值）** | **270** | **≈ $0.9（¥6）** | **≈ $1.6（¥11）** |
| 50 | 1,500 | ≈ $5（¥36） | ≈ $9（¥65） |
| 100 | 3,000 | ≈ $10（¥72） | ≈ $17（¥125） |
| 300 | 9,000 | ≈ $30（¥215） | ≈ $52（¥375） |

单张工单约 **$0.003～0.006（约 2～4 分钱人民币）**。

### 12.4 其他成本
| 项目 | 估算 |
|---|---|
| 常开机器的电费（台式机约 40W） | 约 30 kWh/月，约 ¥20/月；用现有的虚拟机则为 0 |
| P0 开发 | 1～2 人周（一次性） |
| P1 影子期人工 | 客服照常回复，只多了「对比 AI 草稿」这一步，几乎不增加工作量 |
| 日常运维 | 会话过期时重新登录、出故障时处理，预计每周 < 30 分钟 |

结论：按实际工单量（每天最多 9 封），API 费用每月约 ¥6～11，比电费还低。成本几乎全部是**开发投入和维护时间**。

### 12.5 投入产出
- 每天最多 9 封，如果按白名单自动发送的比例占 30～40% 估算，**每天约有 3 封能完全自动处理**，省下大约 15 分钟客服时间。
- 其余工单 AI 只预写草稿，只能省下客服打开工单、点「分析」「起草」的等待时间。
- 对比 P0 的 1～2 人周开发投入，加上常开机器和会话维护的成本，**全自动模式的回本周期较长**。在这个工单量下，更划算的做法是先只做影子模式：AI 自动写备注，不自动发送。这样就不需要实现 Compose 表单提交、熔断这些最复杂、风险最高的部分，开发量可以减半。
