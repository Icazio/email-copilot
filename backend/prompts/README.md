# System Prompts

This directory contains all system prompts and instructions used by the email copilot backend.

## Files

### system-instructions.json

Contains the core system instructions for the AI copilot, including:

- **base**: Core role, task, scope, and constraints
  - `role`: Copilot's identity and primary function
  - `task`: What the copilot helps with
  - `scope`: Limitations and boundaries
  - `constraints`: Behavioral rules and guidelines

- **categories**: Issue categorization rules
  - Defines 7 categories: `free_credit`, `cancel_renewal`, `refund`, `invoice`, `account`, `technical`, `general`
  - Each category has clear selection criteria to help AI classify incoming tickets accurately

## Usage

The `prompt-loader.js` module in `backend/lib/` automatically loads and constructs system instructions from these JSON files.

To use in code:
```javascript
const { buildSystemInstructions } = require("./lib/prompt-loader");

const instructions = buildSystemInstructions("analyze-thread", contextBlock);
```

## Editing Guidelines

When updating prompts:

1. **Keep instructions clear and actionable** - AI models follow explicit instructions better
2. **Category definitions** - Be specific about selection criteria to reduce misclassification
3. **Constraints** - List what NOT to do explicitly (e.g., "Never promise...")
4. **Language** - Keep Simplified Chinese output instructions, English instructions for copilot behavior

## Testing After Changes

After modifying prompts:
1. Restart the backend: `npm start`
2. Test with sample tickets from each category
3. Check the debug logs: `backend/logs/deepseek-debug.log`
4. Verify that:
   - Categories are classified correctly
   - Chinese output is generated for clarification questions
   - No constraints are violated
