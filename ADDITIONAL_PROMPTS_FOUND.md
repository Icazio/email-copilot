# 发现的额外提示词

在 `backend/lib/mock-engine.js` 中发现以下可提取的硬编码内容：

## 1. 分类规则 (Classification Rules)
**文件**: mock-engine.js 第32-68行 `inferCategory()` 函数

包含内容：
- 发票匹配规则
- 免费积分关键词规则（积分、@handle、社交链接）
- 订阅取消规则
- 退款规则
- 账户激活规则
- 技术问题规则
- 默认分类规则

**可提取为**: `backend/prompts/classification-rules.json`

```json
{
  "invoice": "/(invoice|billing info|tax invoice|receipt)/",
  "free_credit": {
    "keywords": "/(free.?credits?|credits?|cr[eé]ditos?|积分)/",
    "requires": ["hasAtHandle OR hasSocialUrl"]
  },
  ...
}
```

---

## 2. 问卷问题 (Questions)
**文件**: mock-engine.js 第325-352行 `buildQuestions()` 函数

包含内容：
- 取消续费问题
- 订单号问题
- 邮箱地址问题
- 许可证代码问题
- 技术问题

都是**中文问题**，适合提取到 `backend/prompts/questions.json`

---

## 3. 下一步指导 (Guidance/Next Steps)
**文件**: mock-engine.js 第354-381行 `buildNextStep()` 函数

包含内容：
- 各类别的处理步骤（中文）
- 需要人工核查的指导
- 流程升级步骤
- 部门转交说明

适合提取到 `backend/prompts/guidance.json`

---

## 4. 自动总结模板 (Summary Templates)
**文件**: mock-engine.js 第309-323行 `buildSummary()` 函数

包含内容：
- 7个分类的总结模板（中文）
- 每个分类一个模板

适合提取到 `backend/prompts/summaries.json`

---

## 5. 草稿回复模板 (Draft Templates)
**文件**: mock-engine.js 第383-454行 `buildDraft()` 和相关函数

包含内容：
- `buildCancelRenewalDraft()` - 取消续费回复模板
- `buildFreeCreditDraft()` - 免费积分回复模板
- `buildDraft()` - 通用回复模板
- YouTube 验证询问文案

这是英文草稿模板，可提取到 `backend/prompts/draft-templates.json`

---

## 6. 免费积分相关文案
**文件**: mock-engine.js 第229-250行 `buildFreeCreditNextStep()` 函数

包含内容：
- 免费积分处理流程（中文）
- 截图验证说明
- 积分记录表格说明
- 模板回复说明

---

## 7. 问题类型推断 (Issue Type Inference)
**文件**: mock-engine.js 第269-287行 `inferIssueType()` 函数

包含内容：
- 7种问题类型的正则规则
- 与 `inferCategory()` 相似但粒度更细

---

## 8. 免费积分高级逻辑 (Free Credit Logic)
**文件**: mock-engine.js 第110-175行 `extractFreeCredit()` 函数

包含内容：
- Facebook/Twitter/YouTube 链接提取规则
- 截图分类逻辑
- 积分计算规则（60积分/平台）
- 验证流程（3个平台 = 180积分）

---

## 推荐提取顺序

1. **优先级 🔴 高**
   - `classification-rules.json` - 分类规则（影响categorize逻辑）
   - `prompts-guidance.json` - 下一步指导（最易变化，应独立维护）
   - `prompts-questions.json` - 问卷问题（不断调整的内容）

2. **优先级 🟡 中**
   - `draft-templates.json` - 草稿模板（经常更新）
   - `summaries.json` - 总结模板（偶尔更新）

3. **优先级 🟢 低**
   - `free-credit-config.json` - 免费积分规则（相对稳定）
   - `issue-type-inference.json` - 问题类型（很少变）

---

## 文件结构示例

```
backend/prompts/
├── system-instructions.json (已有)
├── classification-rules.json (new)
├── prompts-guidance.json (new)
├── prompts-questions.json (new)
├── draft-templates.json (new)
├── summaries.json (new)
├── free-credit-config.json (new)
└── README.md
```

---

## 实现建议

1. 创建 `backend/lib/mock-engine-loader.js` 来加载这些配置
2. 修改 `mock-engine.js` 来使用加载的配置而不是硬编码
3. 创建 `backend/validate-prompts.js` 脚本来验证所有配置完整性
4. 更新 `backend/test-prompt-loader.js` 来测试新的加载器

---

## 优势

✅ 完全分离业务逻辑和内容提示词  
✅ 支持动态更新分类规则（无需重启）  
✅ 便于A/B测试不同的问卷问题  
✅ 中英文提示词分开管理  
✅ 为多语言支持奠定基础  
