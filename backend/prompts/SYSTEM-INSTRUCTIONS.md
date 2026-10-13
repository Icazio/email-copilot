# system-instructions.json

## 📍 文件位置与用途

**在AI提示词中的位置**: ✅ **直接发送给 AI（System Message）**

### 作用流程

```
前端提交请求
    ↓
后端 deepseek-engine.js / openai-engine.js
    ↓
调用 buildSystemInstructions() [来自 prompt-loader.js]
    ↓
从此文件加载内容
    ↓
构建 System Message
    ↓
发送给 DeepSeek/OpenAI API
```

## 📋 文件内容说明

### 1. `base` 部分
定义 AI 助手的核心特性：
- **role**: AI 的身份（内部邮件支持助手）
- **task**: 主要功能（帮助支持代理起草回复）
- **scope**: 边界限制（不是最终发送者）
- **constraints**: 行为约束（不承诺退款、修复等）

### 2. `categories` 部分
定义 7 个问题分类的选择规则：
- `free_credit`: 社交媒体证明 + 积分
- `cancel_renewal`: 取消订阅请求
- `refund`: 退款或扣费投诉
- `invoice`: 发票文件请求
- `account`: 激活或许可证问题
- `technical`: 技术 bug 或崩溃
- `general`: 上述都不符合

## 🔄 在 AI 请求中的使用

```
POST https://api.deepseek.com/chat/completions
{
  "messages": [
    {
      "role": "system",
      "content": "You are an internal email support copilot.\n..." 
      // ↑ 来自此文件的内容
    },
    {
      "role": "user",
      "content": "Task: analyze-thread\n..."
    }
  ]
}
```

## ⚠️ 修改影响

- 修改会影响**所有 AI 请求**（analyze/generate/refine）
- 改变分类定义可能导致分类准确性下降
- 改变约束条件可能导致 AI 做出不符合公司政策的承诺

## ✅ 修改建议

✅ **安全修改**:
- 调整约束条件的措辞
- 更新分类定义的清晰度
- 修改代理应有的态度或风格

⚠️ **谨慎修改**:
- 添加新的分类（需要同时更新 other files）
- 改变角色定义（影响所有 AI 行为）

🔒 **不要修改**:
- 分类数量（会破坏其他配置的对应关系）

## 🔗 相关文件

- `prompt-loader.js` - 加载此文件的模块
- `deepseek-engine.js` - 在 analyze/generate/refine 中使用
- `openai-engine.js` - 在 analyze/generate/refine 中使用
- `classification-rules.json` - 分类识别规则
- `PROMPT_FLOW.md` - 完整流程说明
