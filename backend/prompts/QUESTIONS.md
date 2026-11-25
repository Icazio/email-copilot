# questions.json

## 📍 文件位置与用途

**在AI提示词中的位置**: ⚠️ **间接发送（经前端编辑后）**

### 作用流程

```
后端 Mock 引擎 buildQuestions()
    ↓
从此文件中选择适当的问题
    ↓
构建 clarification_questions 列表
    ↓
返回给前端
    ↓
前端显示给支持代理 (panel.js)
    ↓
⭐ 支持代理编辑问题
    ↓
编辑后的问题提交到 refine-draft
    ↓
在 buildAgentAnalysisBlock() 中包含
    ↓
✅ 发送给 AI（作为 User Message 的一部分）
```

## 📋 文件内容说明

按分类存储中文问卷问题：

```json
{
  "cancel_renewal": ["请问您购买时使用的邮箱地址是什么？"],
  "refund": [
    "请问您的订单号是多少？",
    "请问您购买时使用的邮箱地址是什么？"
  ],
  "invoice": [...],
  "account": [...],
  "technical": [...],
  "general": [],
  "free_credit": []
}
```

## 🔄 在 Mock 引擎中的使用

函数 `buildQuestions(category, fields)`:

1. 获取分类对应的问题列表
2. 根据已提取的字段筛选（有些问题只在缺少特定字段时显示）
3. 最多选择 4 个问题（避免过多）
4. 返回给前端

## 🔄 在 AI 请求中的使用

当是 `refine-draft` 时：

```
User Message 包含:
{
  ...
  "agent_questions": [
    "请问您购买时使用的邮箱地址是什么？",
    "请问您的订单号是多少？"
  ]
  // ↑ 支持代理编辑过的值
}
```

然后在 `buildAgentAnalysisBlock()` 中构建：

```
Agent analysis (reviewed and possibly edited):
Questions to ask:
- 请问您购买时使用的邮箱地址是什么？
- 请问您的订单号是多少？
```

这部分作为 System Message 的一部分发送给 AI。

## 📌 工作流步骤

### Step 1: analyze-thread
- ✅ Mock 从此文件选择初始问题
- ✅ 返回给前端

### Step 2: 前端 UI
- ✅ 显示问题给支持代理
- ⭐ **支持代理可以编辑、删除、重新排序问题**
- ✅ 或保持不变继续

### Step 3: generate-draft
- ✅ 使用前端返回的 `agent_questions`
- ✅ 可能再次修改

### Step 4: refine-draft
- ✅ 使用最新的 `agent_questions`
- ✅ AI 在生成最终回复时参考这些问题

## ⚠️ 修改影响

- 影响 analyze-thread 的返回值
- 影响支持代理看到的初始问题
- 最终影响 AI 生成的回复内容
- 支持代理可以覆盖这些问题（在 UI 中编辑）

## ✅ 修改建议

✅ **安全修改**:
- 添加或删除分类的问题
- 调整问题措辞使其更清晰
- 改进问题的顺序

⚠️ **谨慎修改**:
- 减少问题数量（可能影响效率）
- 改变问题的语气或风格

🔒 **不要修改**:
- 分类名称（会破坏对应关系）

## 🧪 测试方式

修改后应该：
```bash
1. 重启后端
2. 测试 analyze-thread 返回正确的问题
3. 在 UI 中验证问题显示正确
4. 验证支持代理可以编辑问题
5. 检查 refine-draft 是否使用编辑后的问题
```

## 🔗 相关文件

- `mock-engine-loader.js` - getQuestions() 加载器
- `mock-engine.js` - buildQuestions() 函数
- `deepseek-engine.js` - buildAgentAnalysisBlock() 使用
- `panel.js` (前端) - 显示和编辑问题
- `PROMPT_FLOW.md` - 完整流程说明
