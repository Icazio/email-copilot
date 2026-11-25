# classification-rules.json

## 📍 文件位置与用途

**在处理流程中的位置**: ❌ **NOT 直接发送给 AI（后端 Mock 引擎内部使用）**

### 作用流程

```
前端提交 analyze-thread 请求
    ↓
后端 mock-engine.js 的 inferCategory()
    ↓
从此文件加载规则
    ↓
使用正则表达式匹配邮件内容
    ↓
返回分类结果 (category)
    ↓
如果是 free_credit → Mock 直接处理，不调用 AI
否则 → 调用 DeepSeek/OpenAI API
```

## 📋 文件内容说明

包含 8 个分类的识别规则：

### 1. `invoice` (发票)
```regex
/(invoice|billing info|tax invoice|receipt)/i
```
匹配：invoice、billing info、tax invoice、receipt

### 2. `free_credit` (免费积分 - 复杂)
```
条件: hasAtHandle 或 (hasCreditsKeyword AND hasSocialUrl)
含义: @用户名 出现，或者既有积分关键词又有社交链接
```

### 3. `cancel_renewal` (取消续费)
```regex
/(cancel.{0,20}(renew|subscri)|...)/i
```

### 4. `refund` (退款)
```regex
/(refund|money back|auto-renew|...)/i
```

### 5. `account` (账户/许可证)
```regex
/(license code|registration code|...)/i
```

### 6. `technical` (技术问题)
```regex
/(bug|crash|not working|error|...)/i
```

### 7. `general` (其他)
默认分类，上述都不匹配时使用

## 🔄 分类优先级

执行顺序（重要！）:
1. invoice
2. free_credit （最特殊，有复杂逻辑）
3. cancel_renewal
4. refund
5. account
6. technical
7. general （默认）

## ⚡ 性能影响

- 这些规则在**后端本地执行**，不调用 AI
- `free_credit` 分类**完全由 Mock 引擎处理**，不需要 AI API
- 其他分类需要调用 DeepSeek/OpenAI API

## ⚠️ 修改影响

- 直接影响分类准确性
- 分类结果会被传给 AI（作为 `category` 字段）
- 修改会影响后续的 AI 提示词和生成结果

## ✅ 修改建议

✅ **安全修改**:
- 添加更多关键词到现有正则
- 调整正则的匹配灵活性
- 改进 free_credit 的检测逻辑

⚠️ **谨慎修改**:
- 改变分类优先级顺序
- 删除现有的分类

🔒 **不要修改**:
- 分类名称（会破坏与其他文件的对应关系）
- 基本的分类逻辑（除非充分测试）

## 🧪 测试方式

修改后应该测试：
```bash
1. 用各类别的样本邮件测试
2. 确保分类准确率 > 95%
3. 检查边界情况（模糊的邮件）
4. 验证 free_credit 是否只在适当时触发
```

## 🔗 相关文件

- `mock-engine-loader.js` - 加载此文件的模块
- `mock-engine.js` - inferCategory() 函数使用此文件
- `system-instructions.json` - 分类定义说明
- `PROMPT_FLOW.md` - 完整流程说明
