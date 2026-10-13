# 提示词流程图

## 📊 完整处理流程

```
┌─────────────────────────────────────────────────────────────────┐
│                     前端 (Chrome 扩展)                            │
│                                                                   │
│  1. 用户打开 ticket 页面                                          │
│  2. content.js 提取邮件内容                                       │
│  3. panel.js 提交请求到后端                                      │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                  后端 (Node.js)                                   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 1️⃣  ANALYZE-THREAD (分析邮件)                              │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │                                                              │   │
│  │ 输入: 原始邮件内容                                           │   │
│  │ ↓                                                           │   │
│  │ Mock 引擎分类:                                              │   │
│  │   • classification-rules.json ← 分类规则                   │   │
│  │   • issue-types.json ← 细化问题类型                       │   │
│  │ ↓                                                           │   │
│  │ 如果 category == 'free_credit':                            │   │
│  │   └─ Mock 引擎直接处理 (不调用 AI)                         │   │
│  │     • free-credit-config.json ← 平台规则                 │   │
│  │     • draft-templates.json ← 回复模板                    │   │
│  │     • guidance.json ← 处理指导                            │   │
│  │                                                              │   │
│  │ 否则 (其他分类):                                            │   │
│  │   ├─ Mock 引擎生成初始值:                                 │   │
│  │   │   • summaries.json ← 问题摘要                         │   │
│  │   │   • questions.json ← 澄清问题                        │   │
│  │   │   • guidance.json ← 处理指导                         │   │
│  │   │                                                         │   │
│  │   └─ 调用 AI 进行深度分析:                                 │   │
│  │       ┌──────────────────────────────────────┐           │   │
│  │       │  System Message                       │           │   │
│  │       │  ← system-instructions.json           │           │   │
│  │       │     (角色定义 + 分类规则)             │           │   │
│  │       │                                        │           │   │
│  │       │  User Message                         │           │   │
│  │       │  ├─ Task: analyze-thread             │           │   │
│  │       │  ├─ Structured ticket data           │           │   │
│  │       │  ├─ Combined thread context          │           │   │
│  │       │  └─ Template context                 │           │   │
│  │       │                                        │           │   │
│  │       │  ▼ DeepSeek/OpenAI API ▼            │           │   │
│  │       │                                        │           │   │
│  │       │  Response:                            │           │   │
│  │       │  {                                     │           │   │
│  │       │    category, summary, confidence,    │           │   │
│  │       │    clarification_questions,          │           │   │
│  │       │    next_step,                        │           │   │
│  │       │    suggested_template_id             │           │   │
│  │       │  }                                     │           │   │
│  │       └──────────────────────────────────────┘           │   │
│  │                                                              │   │
│  │ 返回给前端: {category, summary, questions, guidance, ...}  │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 2️⃣  [前端 UI] 支持代理编辑                                 │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │                                                              │   │
│  │ 前端显示:                                                   │   │
│  │  • summary (来自 summaries.json) ← 可编辑              │   │
│  │  • questions (来自 questions.json) ← 可编辑            │   │
│  │  • guidance (来自 guidance.json) ← 可编辑              │   │
│  │  • fields (提取的数据)                                     │   │
│  │                                                              │   │
│  │ 支持代理编辑后提交 generate-draft                          │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 3️⃣  GENERATE-DRAFT (生成草稿)                             │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │                                                              │   │
│  │ 输入: {category, manual_notes, agent_summary, ...}         │   │
│  │ ↓                                                           │   │
│  │ 如果 category == 'free_credit':                            │   │
│  │   └─ Mock 引擎直接生成 (不调用 AI)                        │   │
│  │     • draft-templates.json ← 回复文案                    │   │
│  │                                                              │   │
│  │ 否则:                                                        │   │
│  │   └─ 调用 AI 生成回复:                                     │   │
│  │       ┌──────────────────────────────────────┐           │   │
│  │       │  System Message                       │           │   │
│  │       │  ← system-instructions.json           │           │   │
│  │       │                                        │           │   │
│  │       │  User Message                         │           │   │
│  │       │  ├─ Task: generate-draft             │           │   │
│  │       │  ├─ Category                         │           │   │
│  │       │  ├─ Combined thread context          │           │   │
│  │       │  ├─ Manual notes (代理备注)          │           │   │
│  │       │  ├─ Extracted fields                 │           │   │
│  │       │  └─ Template context                 │           │   │
│  │       │                                        │           │   │
│  │       │  ▼ AI API ▼                         │           │   │
│  │       │                                        │           │   │
│  │       │  Response: {draft_reply, ...}        │           │   │
│  │       └──────────────────────────────────────┘           │   │
│  │                                                              │   │
│  │ 返回给前端: {draft_reply, clarification_questions, ...}    │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 4️⃣  [前端 UI] 支持代理审核草稿                            │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │                                                              │   │
│  │ 前端显示:                                                   │   │
│  │  • draft_reply (AI 生成的回复) ← 可编辑                  │   │
│  │  • 支持代理可以:                                           │   │
│  │    - 编辑回复内容                                           │   │
│  │    - 编辑摘要、问题、指导                                 │   │
│  │    - 执行订单查询 (对于需要的分类)                       │   │
│  │                                                              │   │
│  │ 支持代理编辑后提交 refine-draft                            │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 5️⃣  REFINE-DRAFT (优化草稿)                              │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │                                                              │   │
│  │ 输入: {previous_draft, manual_lookup_result,                │   │
│  │        agent_summary (编辑后), agent_questions (编辑后),   │   │
│  │        agent_next_step (编辑后), ...}                      │   │
│  │ ↓                                                           │   │
│  │ 调用 AI 进行优化:                                           │   │
│  │       ┌──────────────────────────────────────┐           │   │
│  │       │  System Message                       │           │   │
│  │       │  ← system-instructions.json           │           │   │
│  │       │                                        │           │   │
│  │       │  User Message                         │           │   │
│  │       │  ├─ Task: refine-draft               │           │   │
│  │       │  ├─ Category                         │           │   │
│  │       │  ├─ Combined thread context          │           │   │
│  │       │  ├─ Agent analysis (编辑后的):      │           │   │
│  │       │  │  └─ 来自前端编辑的值:              │           │   │
│  │       │  │     • summary (summaries.json)   │           │   │
│  │       │  │     • clarification_questions    │           │   │
│  │       │  │       (questions.json)           │           │   │
│  │       │  │     • next_step (guidance.json)  │           │   │
│  │       │  ├─ Manual lookup result            │           │   │
│  │       │  ├─ Manual notes                    │           │   │
│  │       │  ├─ Previous draft (AI 生成)       │           │   │
│  │       │  ├─ Extracted fields                │           │   │
│  │       │  └─ Template context                │           │   │
│  │       │                                        │           │   │
│  │       │  ▼ AI API ▼                         │           │   │
│  │       │                                        │           │   │
│  │       │  Response: {final_draft_reply, ...} │           │   │
│  │       └──────────────────────────────────────┘           │   │
│  │                                                              │   │
│  │ 返回给前端: {draft_reply (优化后), ...}                   │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  支持代理最终审核并发送回复                                     │   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📋 配置文件与流程的对应关系

### 🔵 直接发送给 AI 的配置

```
DeepSeek/OpenAI API 请求中:

System Message:
└─ system-instructions.json
   ├─ base (角色、约束)
   └─ categories (7个分类的定义)

User Message (analyze/generate/refine):
├─ Task 类型
├─ Structured ticket data
├─ Combined thread context
├─ Agent analysis (refine-draft 时)
│  └─ 来自以下配置的值 (支持代理编辑后):
│     ├─ summaries.json (summary)
│     ├─ questions.json (clarification_questions)
│     └─ guidance.json (next_step)
├─ Manual lookup/notes
├─ Extracted fields
│  └─ issue_type (来自 issue-types.json)
└─ Template context
```

### 🟠 在后端处理但不发送给 AI 的配置

```
Mock 引擎处理流程:

inferCategory():
└─ classification-rules.json

extractFreeCredit():
├─ free-credit-config.json
│  ├─ social_platforms (检测社交平台)
│  ├─ attachment_detection (检测截图)
│  ├─ verification_rules (验证规则)
│  ├─ credits_calculation (计算积分)
│  └─ spreadsheet_format (生成表格行)
├─ draft-templates.json (YouTube Ask 文案)
└─ guidance.json (free_credit 指导)

buildSummary():
└─ summaries.json

buildQuestions():
└─ questions.json

buildNextStep():
└─ guidance.json

buildDraft():
└─ draft-templates.json

inferIssueType():
└─ issue-types.json
```

---

## 🎯 各文件的作用范围

| 文件 | 在 Mock 中 | 发给 AI | 可编辑 | 用途 |
|-----|---------|--------|------|------|
| system-instructions.json | ❌ | ✅ System | ❌ | AI 角色定义 |
| classification-rules.json | ✅ | ❌ | ❌ | 分类识别 |
| questions.json | ✅ | ❌→✅* | ✅ | 问卷问题 |
| guidance.json | ✅ | ❌→✅* | ✅ | 处理指导 |
| summaries.json | ✅ | ❌→✅* | ✅ | 问题摘要 |
| draft-templates.json | ✅ | ❌ | ❌ | 回复模板 |
| free-credit-config.json | ✅ | ❌ | ❌ | 免费积分规则 |
| issue-types.json | ✅ | ❌ | ❌ | 问题类型 |

**\* 经支持代理编辑后才发给AI**

---

## 🔄 数据流动示例

### 示例 1: Refund（退款）分类

```
1. 用户邮件: "我想要退款"
   ↓
2. Mock 引擎分类
   • classification-rules.json: 匹配 "refund" 规则
   ↓
3. 不是 free_credit，调用 AI
   • System: system-instructions.json
   • User: combine all thread data
   ↓
4. AI 返回
   • category: refund
   • summary: "客户就退款或扣费问题进行咨询。"
   • questions: ["请问您的订单号是多少？", ...]
   • next_step: "发送任何退款相关回复前，请先在后台人工核查订单。"
   ↓
5. 前端显示，支持代理可编辑
   ↓
6. 支持代理执行订单查询
   ↓
7. generate-draft
   • 调用 AI 生成回复
   • User Message 包含 manual_lookup_result
   ↓
8. 前端显示草稿，支持代理编辑
   ↓
9. refine-draft
   • 调用 AI 优化回复
   • User Message 包含 agent_summary (编辑后)
   • 结合订单查询结果生成最终回复
```

### 示例 2: Free Credit（免费积分）分类

```
1. 用户邮件: "我在 YouTube 关注了你们"
   (包含 @youtubehandle 和可能的截图)
   ↓
2. Mock 引擎分类
   • classification-rules.json: 匹配 "free_credit" 规则
   ↓
3. 完全由 Mock 引擎处理，不调用 AI
   • free-credit-config.json: 检测社交平台
   • attachment_detection: 检测截图
   • credits_calculation: 计算 60 积分
   • draft-templates.json: 生成 YouTube 验证请求
   • guidance.json: 生成后续步骤
   • spreadsheet_format: 生成电子表格行
   ↓
4. 返回给前端
   • category: free_credit
   • spreadsheet_row: "2026.05.19 customer@email.com Youtube 60 ... screenshot"
   • draft_reply: "As we're unable to verify YouTube..."
   ↓
5. 支持代理看到表格行和回复
   ↓
6. 点击发送，邮件发出
```

---

## 📌 重要提示

### ✅ 安全修改的配置

这些可以安全编辑，只需确保 JSON 格式正确：

- `questions.json` - 修改问卷问题
- `guidance.json` - 修改处理指导
- `summaries.json` - 修改问题摘要
- `draft-templates.json` - 修改回复文案
- `free-credit-config.json` - 修改免费积分规则

### ⚠️ 需要谨慎修改的配置

这些修改会影响 AI 行为，需要充分测试：

- `system-instructions.json` - 修改会影响所有 AI 决策
- `classification-rules.json` - 修改会影响分类准确性
- `issue-types.json` - 修改会影响问题类型识别

### 🔒 不应该手动修改的配置

这些是由系统自动生成或使用的：

- 前端编辑的值（在 panel.js 中）
- 支持代理编辑后的数据（agent_summary, agent_questions, agent_next_step）
