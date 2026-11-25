# issue-types.json

## 📍 文件位置与用途

**在处理流程中的位置**: ⚠️ **间接（作为 extracted_fields.issue_type）**

### 作用流程

```
后端 Mock 引擎 inferIssueType()
    ↓
从此文件中选择对应的问题类型
    ↓
构建 extracted_fields.issue_type
    ↓
返回给前端
    ↓
前端显示给支持代理
    ↓
与分类和其他信息一起提交给 AI
    ↓
AI 参考此信息生成更准确的回复
```

## 📋 文件内容说明

6 个详细问题类型的定义：

```json
{
  "refund_auto_renewal": {
    "pattern": "/(auto-renew|renewed automatically)/i",
    "description": "Customer disputes auto-renewal charge",
    "category": "refund"
  },
  "cancel_renewal": {
    "pattern": "/(cancel renewal|cancel subscription|...)/i",
    "description": "Customer wants to cancel or stop auto-renewal",
    "category": "cancel_renewal"
  },
  "invoice_request": {
    "pattern": "/(invoice|tax invoice|receipt)/i",
    "description": "Customer requests invoice or billing document",
    "category": "invoice"
  },
  "license_code_not_working": {
    "pattern": "/(license code|registration code|...)/i",
    "description": "Customer has trouble with license or activation code",
    "category": "account"
  },
  "technical_issue": {
    "pattern": "/(slow|crash|error|failed|freeze|...)/i",
    "description": "Customer reports performance or stability issue",
    "category": "technical"
  },
  "general": {
    "pattern": "none",
    "description": "General inquiry or other issue",
    "category": "general"
  }
}
```

## 🔄 分类关系

问题类型是比主分类更细的层级：

| issue_type | category |
|-----------|----------|
| refund_auto_renewal | refund |
| cancel_renewal | cancel_renewal |
| invoice_request | invoice |
| license_code_not_working | account |
| technical_issue | technical |
| general | general |

## 📌 工作流步骤

### Step 1: analyze-thread
- Mock 引擎识别主分类（category）
- Mock 引擎识别问题类型（issue_type）
- 两个信息一起返回给前端

### Step 2: 前端显示
```
Category: refund
Issue Type: refund_auto_renewal
```

### Step 3: generate-draft & refine-draft
```
User Message 包含:
{
  "category": "refund",
  "extracted_fields": {
    "issue_type": "refund_auto_renewal"  // ← 来自此文件
  }
}
```

AI 可以使用这个细化的问题类型生成更准确的回复。

## ⚠️ 当前状态

**重要**: 此文件当前**预留使用**。

在 `mock-engine.js` 中有 `inferIssueType()` 函数使用此文件，但：
- 功能已实现
- 信息被放入 `extracted_fields.issue_type`
- 被传给 AI 参考
- 但**未被充分利用**

## 💡 未来扩展机会

可以利用 issue_type 实现：

1. **更精细的分类**
   - 区分自动续费退款 vs 一般退款
   - 区分账户激活 vs 许可证问题

2. **分类特定的提示词**
   - 为每个问题类型定制提示词
   - 提高 AI 生成的准确性

3. **更好的模板选择**
   - 根据 issue_type 选择更相关的模板

## ✅ 修改建议

✅ **安全修改**:
- 调整正则表达式以改进识别
- 更新 description 字段
- 添加更多关键词

⚠️ **考虑修改**:
- 添加新的问题类型（需要同步更新代码）
- 改变现有的问题类型映射

🔒 **不要修改**:
- 问题类型名称（除非同时更新代码）
- 分类映射（category 字段）

## 🧪 测试方式

修改后应该：
```bash
1. 重启后端
2. 测试各种问题类型的邮件
3. 验证 issue_type 字段被正确识别
4. 检查 AI 是否考虑了 issue_type
5. 对比使用前后的回复质量
```

## 🔗 相关文件

- `mock-engine.js` - inferIssueType() 函数
- `classification-rules.json` - 主分类规则
- `deepseek-engine.js` / `openai-engine.js` - AI API 接收此信息
- `panel.js` (前端) - 显示问题类型

## 🎯 建议

虽然此文件实现了功能，但建议：

1. **短期**: 保持当前实现，继续监测
2. **中期**: 在 AI prompt 中更明确地引用 issue_type
3. **长期**: 为每个 issue_type 创建定制的 prompt 或模板

这样可以充分利用已有的细化分类信息。
