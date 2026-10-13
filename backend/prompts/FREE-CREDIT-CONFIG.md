# free-credit-config.json

## 📍 文件位置与用途

**在处理流程中的位置**: ❌ **NOT 直接发送给 AI（免费积分专用配置）**

### 作用流程

```
分类识别为 'free_credit'
    ↓
后端 Mock 引擎完全处理（不调用 AI）
    ↓
使用此文件中的规则
    ├─ 检测社交平台
    ├─ 检测截图附件
    ├─ 计算积分
    ├─ 生成验证请求
    └─ 生成电子表格行
    ↓
返回所有处理结果给前端
```

## 📋 文件内容说明

### 1. social_platforms (社交平台配置)

```json
{
  "facebook": {
    "id": "facebook",
    "name": "Facebook",
    "url_pattern": "https?://(?:www\\.)?facebook\\.com/\\S+",
    "credits": 60,        // 每个平台 60 积分
    "priority": 1         // 检测优先级
  },
  "twitter": {...},
  "youtube": {
    ...
    "requires_screenshot": true   // YouTube 需要截图验证
  }
}
```

**作用**:
- 定义可以赚取积分的社交平台
- URL 模式用于检测邮件中的链接
- 优先级用于冲突解决

### 2. attachment_detection (附件检测)

```json
{
  "youtube_keywords": ["/youtube/i", "/_youtube_/i", "/yt_/i"],
  "twitter_keywords": ["/twitter/i", "/avclabsofficial/i", ...],
  "image_extensions": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
}
```

**作用**:
- 根据文件名猜测截图属于哪个平台
- 识别图片文件类型

### 3. verification_rules (验证规则)

```json
{
  "youtube_handle_pattern": "/(?<!\\S)@[\\w.]{2,}/g",
  "youtube_handle_min_length": 2,
  "youtube_screenshot_required": true,
  "ask_for_screenshot_message": "Unable to verify YouTube subscriptions from our end"
}
```

**作用**:
- 定义 YouTube 验证的规则
- 何时请求截图

### 4. credits_calculation (积分计算)

```json
{
  "base_credits_per_platform": 60,  // 每平台 60 积分
  "max_platforms": 3,               // 最多 3 个平台
  "max_total_credits": 180          // 最多 180 积分
}
```

**作用**:
- 计算总积分
- 防止超额

### 5. spreadsheet_format (表格格式)

```json
{
  "date_format": "YYYY.MM.DD",
  "fields": ["date", "customer_email", "valid_channels", "total_credits", "reserved", "valid_links"],
  "separator": "\t"
}
```

**作用**:
- 生成供支持团队记录的电子表格行
- 格式：日期、邮箱、平台、积分、预留、链接
- 用制表符分隔（便于粘贴到 Excel）

## 🔄 在 Mock 引擎中的使用

主要函数：

### extractFreeCredit()
使用 `social_platforms` 和 `attachment_detection` 检测：
- 找到的社交平台链接
- 附件中的截图
- YouTube 待验证的 handle

### formatSpreadsheetRow()
使用 `spreadsheet_format` 生成表格行：
```
2026.05.19	customer@email.com	Youtube,Facebook	120		screenshot
```

## 📊 积分计算示例

```
用户邮件包含：
  ✅ Facebook 链接
  ✅ Twitter 链接
  ⏳ YouTube @handle (需要截图)

结果：
  - 有效平台: 2 (Facebook + Twitter)
  - 积分: 2 × 60 = 120
  - YouTube pending: 等待截图
  
电子表格行：
  2026.05.19	user@email.com	Facebook,Twitter	120	youtube_screenshot	https://... https://...
```

## ⚠️ 修改影响

- 影响免费积分的识别和计算
- 不影响 AI 调用（free_credit 完全由 Mock 处理）

## ✅ 修改建议

✅ **安全修改**:
- 添加新的社交平台
- 调整积分数量
- 改变 URL 模式以改进检测
- 调整 Excel 表格格式

⚠️ **谨慎修改**:
- 改变最大积分数
- 改变平台数量限制

🔒 **不要修改**:
- 字段名称（除非同时更新代码）

## 🧪 测试方式

修改后应该：
```bash
1. 测试各平台的链接识别
2. 测试截图的检测
3. 验证积分计算正确
4. 检查生成的电子表格行格式
5. 测试限额限制（最多 180 积分）
6. 测试 YouTube 验证请求
```

## 💡 使用场景

支持团队使用生成的电子表格行：
1. 复制生成的表格行
2. 粘贴到"积分记录"电子表格
3. 次日确认积分已发放
4. 使用"AVCLabs: Add Free Credits" 模板回复客户

## 🔗 相关文件

- `mock-engine-loader.js` - loadFreeCreditConfig() 加载器
- `mock-engine.js` - extractFreeCredit(), formatSpreadsheetRow() 等
- `panel.js` (前端) - 显示电子表格行
