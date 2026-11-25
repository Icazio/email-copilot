# 系统提示词提取汇总

## 已完成 ✅

| 文件 | 提取内容 | 状态 |
|-----|--------|------|
| `backend/prompts/system-instructions.json` | 基础系统指令 + 7个分类定义 | ✅ 完成 |
| `backend/lib/prompt-loader.js` | 提示词加载器 | ✅ 完成 |

---

## 发现的额外提示词

### 🔴 **高优先级 - 立即可提取**

#### 1. OpenAI 引擎系统指令
**文件**: `backend/lib/openai-engine.js` 第41-61行
**问题**: 与 deepseek-engine.js 中的硬编码完全一样
**解决**: 应该改为使用 `prompt-loader.js` 中的 `buildSystemInstructions`

#### 2. Mock 引擎中的分类规则
**文件**: `backend/lib/mock-engine.js` 第32-68行 `inferCategory()`
**内容**: 
- 发票识别规则
- 免费积分识别规则（支持多语言）
- 订阅取消识别规则
- 退款识别规则
- 账户/许可证问题规则
- 技术问题规则

**建议**: 提取到 `backend/prompts/classification-rules.json`

#### 3. 中文问卷问题
**文件**: `backend/lib/mock-engine.js` 第325-352行 `buildQuestions()`
**内容**: 
- "请问您购买时使用的邮箱地址是什么？"
- "请问您的订单号是多少？"
- "请提供许可证代码以及报错截图..."
- "请告知产品版本、操作系统..."
- 等共12个中文问题

**建议**: 提取到 `backend/prompts/questions.json`

#### 4. 中文处理指导
**文件**: `backend/lib/mock-engine.js` 第354-381行 `buildNextStep()`
**内容**:
- "未查到订单，请让客户确认购买时使用的邮箱地址。"
- "所有订阅已取消。使用「AVCLabs: cancel subscription」标准回复..."
- "发现有效订阅（PAID）。先发送确认邮件..."
- 各类别的人工处理步骤

**建议**: 提取到 `backend/prompts/guidance.json`

#### 5. 中文总结模板
**文件**: `backend/lib/mock-engine.js` 第309-323行 `buildSummary()`
**内容**: 
```json
{
  "free_credit": "客户申请关注社交媒体渠道的免费积分。",
  "cancel_renewal": "客户请求取消订阅或自动续费。",
  "refund": "客户就退款或扣费问题进行咨询。",
  "invoice": "客户需要发票或账单文件。",
  "account": "客户反映账户、激活或许可证代码问题。",
  "technical": "客户报告技术问题，可能需要收集信息后再升级处理。",
  "general": "需人工核查客户请求内容。"
}
```

**建议**: 提取到 `backend/prompts/summaries.json`

---

### 🟡 **中优先级 - 可后续提取**

#### 6. 英文草稿模板
**文件**: `backend/lib/mock-engine.js` 第418-454行
**包含**: 
- 取消续费回复
- 免费积分验证请求
- 通用支持回复模板

**建议**: 提取到 `backend/prompts/draft-templates.json`

#### 7. 免费积分专属配置
**文件**: `backend/lib/mock-engine.js` 第110-175行
**包含**:
- 社交媒体链接提取规则
- 截图分类逻辑
- 积分计算规则（60/平台）
- YouTube 验证流程

**建议**: 提取到 `backend/prompts/free-credit-config.json`

#### 8. 问题类型推断规则
**文件**: `backend/lib/mock-engine.js` 第269-287行
**包含**: 7种详细问题类型的识别规则

**建议**: 提取到 `backend/prompts/issue-types.json`

---

## 推荐实现方案

### 第一阶段（本次）✅ 已完成
- [x] 创建 `system-instructions.json`
- [x] 创建 `prompt-loader.js`
- [x] 修改 `deepseek-engine.js` 使用新loader

### 第二阶段（推荐）🎯 下次完成
- [ ] 修复 `openai-engine.js` 使用 `prompt-loader`
- [ ] 提取分类规则到 `classification-rules.json`
- [ ] 提取问题到 `questions.json`
- [ ] 提取指导到 `guidance.json`
- [ ] 提取总结到 `summaries.json`
- [ ] 创建 `mock-engine-loader.js` 来加载这些配置
- [ ] 修改 `mock-engine.js` 使用新loader

### 第三阶段（可选）
- [ ] 提取草稿模板到 `draft-templates.json`
- [ ] 提取免费积分配置到 `free-credit-config.json`
- [ ] 添加多语言支持（zh_CN, zh_TW, en, etc.）

---

## 目标文件结构

```
backend/prompts/
├── system-instructions.json      ✅ 已有
├── classification-rules.json      (待建)
├── questions.json                 (待建)
├── guidance.json                  (待建)
├── summaries.json                 (待建)
├── draft-templates.json           (待建)
├── free-credit-config.json        (待建)
├── issue-types.json               (待建)
└── README.md                       ✅ 已有

backend/lib/
├── prompt-loader.js               ✅ 已有
├── mock-engine-loader.js          (待建)
└── openai-engine.js               (需修改)
```

---

## 收益分析

| 操作 | 当前状态 | 提取后 | 收益 |
|-----|--------|------|------|
| 更新分类规则 | 修改代码 | 编辑JSON | ⚡ 快10倍 |
| 修改问卷 | 重启后端 | 热更新 | 🚀 不用重启 |
| A/B测试 | 不可行 | 支持版本 | ✨ 新功能 |
| 多语言 | 代码耦合 | 配置管理 | 🌍 完整支持 |
| 代码维护 | 混乱 | 清晰分离 | 📚 易维护 |

---

## 快速决策

**立即执行第二阶段？** (预计 30-45 分钟)

- ✅ 推荐 - 整体架构会更清晰
- ❌ 延后 - 当前功能已完成，可以稍后再做
- 🤔 部分 - 只做高优先级（分类规则 + 问题 + 指导）

请确认是否继续进行！
