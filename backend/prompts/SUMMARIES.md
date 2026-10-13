# summaries.json

## 📍 文件位置与用途

**在AI提示词中的位置**: ⚠️ **间接发送（经前端编辑后）**

与 `guidance.json` 和 `questions.json` 类似的工作流。

### 作用流程

```
后端 Mock 引擎 buildSummary()
    ↓
从此文件选择分类对应的模板
    ↓
与邮件首行结合生成摘要
    ↓
返回给前端
    ↓
前端显示给支持代理
    ↓
⭐ 支持代理编辑摘要
    ↓
编辑后的摘要提交到 refine-draft
    ↓
在 buildAgentAnalysisBlock() 中包含
    ↓
✅ 发送给 AI
```

## 📋 文件内容说明

7 个分类的中文摘要模板：

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

## 🔄 在 Mock 引擎中的使用

函数 `buildSummary(text, category, structured)`:

```javascript
// 获取分类模板
const template = summaries[category] || summaries["general"];

// 与邮件首行结合
if (firstLine) {
  return `${template} 邮件首行：${firstLine}`;
} else {
  return template;
}
```

## 📌 关键特点

- **模板 + 首行结合** - 使摘要更具体
- **供支持代理编辑** - 在 UI 中可修改
- **可以完全删除** - 支持代理可以清空摘要（告诉 AI 不要推断）

## 🔗 在 AI 中的使用

在 `refine-draft` 时：

```
User Message 包含编辑后的值，
buildAgentAnalysisBlock() 构建：

Summary: [支持代理编辑的摘要内容]
// 或
The agent has cleared the summary — do not infer or restate one.
```

## ✅ 修改建议

✅ **安全修改**:
- 改进模板措辞
- 使摘要更简洁或更详细
- 更新分类描述

🔒 **不要修改**:
- 分类名称或数量

## 🔗 相关文件

- `mock-engine-loader.js` - getSummary() 加载器
- `mock-engine.js` - buildSummary() 函数
- `deepseek-engine.js` - buildAgentAnalysisBlock() 使用
- `panel.js` (前端) - 显示和编辑摘要
