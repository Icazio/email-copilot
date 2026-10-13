# guidance.json

## 📍 文件位置与用途

**在AI提示词中的位置**: ⚠️ **间接发送（经前端编辑后）**

### 作用流程

```
后端 Mock 引擎 buildNextStep()
    ↓
从此文件选择对应分类的指导
    ↓
构建 next_step 文本
    ↓
返回给前端
    ↓
前端显示给支持代理 (panel.js)
    ↓
⭐ 支持代理编辑指导
    ↓
编辑后的指导提交到 refine-draft
    ↓
在 buildAgentAnalysisBlock() 中包含
    ↓
✅ 发送给 AI（作为 User Message 的一部分）
```

## 📋 文件内容说明

按分类存储中文处理指导步骤：

### 1. 简单分类（一个字符串）

```json
{
  "refund": "发送任何退款相关回复前，请先在后台人工核查订单。",
  "invoice": "收集缺失的账单信息后，继续人工开票流程。",
  "account": "收集所需信息后，在技术支持平台继续处理。",
  "technical": "先收集缺失的技术信息，再在共享文档和 Redmine 中记录并升级处理。"
}
```

### 2. 复杂分类（根据状态选择）

```json
{
  "cancel_renewal": {
    "not_found": "未查到订单，请让客户确认...",
    "all_cancelled": "所有订阅已取消。使用...",
    "has_active": "发现有效订阅（PAID）。...",
    "no_lookup": "请先执行订单查询..."
  }
}
```

### 3. 特殊分类（免费积分）

```json
{
  "free_credit": {
    "screenshot_needs_verification": "检测到附件截图，请查看...",
    "ambiguous_images": "检测到附件截图，但无法自动判断...",
    "youtube_pending": "YouTube：等待客户发送订阅截图。",
    "valid_channels": "将下方表格行复制到积分记录表格...",
    "no_valid_channels": "未识别到有效社交媒体渠道..."
  }
}
```

## 🔄 在 Mock 引擎中的使用

函数 `buildNextStep(category, body)`:

1. 对于 `cancel_renewal`：根据订阅状态选择指导
2. 对于其他分类：直接使用对应的指导文本
3. 返回中文指导给前端

## 🔄 在 AI 请求中的使用

当是 `refine-draft` 时：

```
User Message 包含:
{
  ...
  "agent_next_step": "发现有效订阅（PAID）。先发送确认邮件给客户..."
  // ↑ 支持代理编辑过的值
}
```

然后在 `buildAgentAnalysisBlock()` 中构建：

```
Agent analysis (reviewed and possibly edited):
Next step: 发现有效订阅（PAID）。先发送确认邮件给客户...
```

这部分作为 System Message 的一部分发送给 AI。

## 📌 工作流步骤

### Step 1: analyze-thread
- ✅ Mock 从此文件获取初始指导
- ✅ 返回给前端

### Step 2: 前端 UI
- ✅ 显示指导给支持代理
- ⭐ **支持代理可以编辑指导内容**
- ✅ 或保持不变继续

### Step 3: generate-draft
- ✅ 使用前端返回的 `agent_next_step`
- ✅ 可能再次修改

### Step 4: refine-draft
- ✅ 使用最新的 `agent_next_step`
- ✅ AI 在生成最终回复时参考这些指导

## ⚠️ 修改影响

- 影响支持代理看到的处理步骤指导
- 影响 AI 生成回复时的参考信息
- 支持代理可以覆盖这些指导（在 UI 中编辑）

## ✅ 修改建议

✅ **安全修改**:
- 改进指导步骤的清晰度
- 添加更详细的步骤说明
- 更新部门名称或流程

⚠️ **谨慎修改**:
- 改变处理流程（需要充分测试）
- 删除现有的状态选项（如 has_active）

🔒 **不要修改**:
- 分类名称
- cancel_renewal 的状态键（not_found, has_active 等）

## 🔗 特殊说明：cancel_renewal

对于 `cancel_renewal` 分类，有特殊的状态判断：

```javascript
const status = parseSubscriptionStatus(body?.manual_lookup_result);
// 返回: "not_found" | "all_cancelled" | "has_active" | null

// 然后选择对应的指导
```

支持代理执行**订单查询**后，系统会自动选择合适的指导。

## 🧪 测试方式

修改后应该：
```bash
1. 重启后端
2. 测试 analyze-thread 返回正确的指导
3. 在 UI 中验证指导显示正确
4. 验证支持代理可以编辑指导
5. 对于 cancel_renewal：
   - 测试未找到订单的情况
   - 测试订阅已取消的情况
   - 测试有活跃订阅的情况
```

## 🔗 相关文件

- `mock-engine-loader.js` - getGuidance() 加载器
- `mock-engine.js` - buildNextStep() 函数
- `deepseek-engine.js` - buildAgentAnalysisBlock() 使用
- `panel.js` (前端) - 显示和编辑指导
- `PROMPT_FLOW.md` - 完整流程说明
