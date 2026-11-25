# draft-templates.json

## 📍 文件位置与用途

**在AI提示词中的位置**: ❌ **NOT 直接发送（Mock 引擎使用）**

### 作用流程

```
前端提交 generate-draft 请求
    ↓
后端 Mock 引擎
    ↓
如果 category == 'free_credit':
  ├─ 从此文件获取模板
  ├─ 进行占位符替换
  └─ 直接生成回复（不调用 AI）
        ↓
        返回 draft_reply 给前端

否则:
  └─ 调用 AI API 生成回复
     (此文件不直接使用，但可作为参考)
```

## 📋 文件内容说明

### 1. free_credit 部分
免费积分相关的回复文案：

```json
{
  "youtube_ask": "As we're currently unable...",
  "ambiguous_image": "Thank you for reaching out. We received...",
  "valid_channels_with_youtube_pending": "Thank you for your support!...",
  "only_youtube_id": "Thank you for your support!..."
}
```

这些模板支持占位符替换：
- `{closing}` - 邮件结尾（通常是 "Best regards,"）
- `{channels}` - 有效的社交平台列表
- `{youtube_ask}` - YouTube 验证请求文案

### 2. cancel_renewal 部分
取消续费相关的回复：

```json
{
  "all_cancelled": "Thank you for contacting us. We have checked...",
  "has_active": "Thank you for contacting us. We have received...",
  "not_found": "Thank you for contacting us. To help us locate..."
}
```

根据订阅状态选择：
- `all_cancelled` - 订阅已取消，无需后续操作
- `has_active` - 有活跃订阅，需要升级处理
- `not_found` - 未找到订单，需要客户确认邮箱

### 3. generic_support 部分
通用支持回复框架：

```json
{
  "generic_support": "Thank you for contacting us.\n\nWe understand that you are contacting us about {customer_need}. {context_sentence}{order_sentence}{body_guidance}\n\n{question_block}\n\n{closing}"
}
```

支持占位符：
- `{customer_need}` - "your refund-related request" 等
- `{context_sentence}` - 额外上下文
- `{order_sentence}` - 订单号提醒
- `{body_guidance}` - 模板中的指导
- `{question_block}` - 澄清问题块
- `{closing}` - 邮件结尾

### 4. 分类映射部分
各分类的 customer_need 短语：

```json
{
  "refund": {"customer_need": "your refund-related request"},
  "invoice": {"customer_need": "your invoice request"},
  "account": {"customer_need": "the activation issue"},
  "technical": {"customer_need": "the issue you reported"},
  "general": {"customer_need": "your request"}
}
```

## 🔄 在 Mock 引擎中的使用

### 对于 free_credit:

```javascript
// buildFreeCreditDraft() 使用此文件
const template = getDraftTemplate("free_credit");
// 使用 template.youtube_ask, template.ambiguous_image 等
```

### 对于 cancel_renewal:

```javascript
// buildCancelRenewalDraft() 使用此文件
const template = getDraftTemplate("cancel_renewal");
const draftText = template[status]; // status: "all_cancelled" | "has_active" | "not_found"
```

### 对于其他分类:

```javascript
// buildDraft() 使用通用框架
const template = getDraftTemplate("generic_support");
// 进行占位符替换生成最终回复
```

## ⚠️ 修改影响

### free_credit & cancel_renewal:
- 直接影响生成的回复内容（Mock 引擎）
- 不调用 AI

### 其他分类:
- 影响 Mock 引擎中的回复框架
- AI 生成时可能参考这些模板

## ✅ 修改建议

✅ **安全修改**:
- 调整英文措辞和语气
- 改进邮件模板的结构
- 更新公司政策相关的文案

⚠️ **谨慎修改**:
- 改变占位符结构（需要同时更新代码）
- 删除现有的分类文案

🔒 **不要修改**:
- 占位符名称（如果不更新代码）
- 分类名称（会破坏对应关系）

## 🧪 测试方式

修改后应该：
```bash
1. 重启后端
2. 测试 free_credit 分类的生成结果
3. 测试 cancel_renewal 的三种状态
4. 验证占位符替换正确
5. 验证 AI 生成的其他分类回复
6. 检查英文语法和语气一致性
```

## 🔗 相关文件

- `mock-engine-loader.js` - getDraftTemplate() 加载器
- `mock-engine.js` - buildFreeCreditDraft(), buildCancelRenewalDraft(), buildDraft()
- `panel.js` (前端) - 显示生成的回复
