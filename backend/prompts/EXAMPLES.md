# Prompt Examples and Use Cases

## Example: Analyzing Different Ticket Types

### 1. Free Credit Issue
**Input**: Email mentioning "我想获得免费积分" + "https://www.youtube.com/watch?v=xyz"
**Expected Category**: `free_credit`
**Why**: Contains "积分" (credits) + social media link (YouTube)

### 2. Refund Request
**Input**: "Can you refund my purchase from last month? I'm not satisfied with the product."
**Expected Category**: `refund`
**Why**: Explicitly requests refund

### 3. Subscription Cancellation
**Input**: "I want to cancel my subscription and stop auto-renewal."
**Expected Category**: `cancel_renewal`
**Why**: Clear intent to cancel/stop auto-renewal

### 4. Technical Issue
**Input**: "My video processing keeps crashing. Error code: XYZ123"
**Expected Category**: `technical`
**Why**: Reports bug/crash

### 5. License/Account Issue
**Input**: "The license code I received doesn't work. What should I do?"
**Expected Category**: `account`
**Why**: License code activation problem

### 6. Invoice Request
**Input**: "I need an invoice for my recent purchase for accounting purposes."
**Expected Category**: `invoice`
**Why**: Requests billing document

### 7. General Inquiry
**Input**: "Do you offer a trial version? How does the pricing work?"
**Expected Category**: `general`
**Why**: Pre-sales inquiry, doesn't fit other categories

## Adding New Categories

To add a new issue category:

1. Add entry to `categories` in `system-instructions.json`:
   ```json
   "new_category": "Clear description of when to use this category..."
   ```

2. Update templates if needed: `backend/templates/`

3. Restart backend and test classification

## Output Format Expectations

For each mode (analyze-thread, generate-draft, refine-draft), the system expects JSON with specific keys:

### analyze-thread
```json
{
  "category": "refund",
  "summary": "用户要求退款并解释不满意原因",
  "confidence": 0.95,
  "extracted_fields": {...},
  "clarification_questions": ["确认订单号?", ...],
  "next_step": "检查退款政策并处理",
  "suggested_template_id": "refund_v1"
}
```

### generate-draft
```json
{
  "category": "refund",
  "draft_reply": "Dear customer, ...",
  "clarification_questions": "退款相关问题",
  "next_step": "转交给财务团队",
  "extracted_fields": {...},
  "template_id": "refund_v1"
}
```

### refine-draft
Same structure as generate-draft, incorporating lookup results
