# System Prompts Refactoring

## Overview

The system prompts have been extracted from hardcoded strings in `deepseek-engine.js` into a structured, maintainable configuration system.

## Changes Made

### 1. New Files Created

- **`backend/prompts/system-instructions.json`** - Main prompt configuration
  - Stores base instructions (role, task, scope, constraints)
  - Stores all issue category definitions
  - Easy to edit and version control

- **`backend/lib/prompt-loader.js`** - Prompt loading module
  - Loads JSON configurations from `prompts/` directory
  - Exports `buildSystemInstructions()` function
  - Replaces the hardcoded version from `deepseek-engine.js`

- **`backend/prompts/README.md`** - Documentation
  - Explains the structure of prompt files
  - Guidelines for editing prompts
  - Instructions for testing after changes

- **`backend/prompts/EXAMPLES.md`** - Usage examples
  - Example tickets for each category
  - Expected AI classifications
  - Output format specifications

- **`backend/check-prompts.js`** - Validation script
  - Verifies `system-instructions.json` integrity
  - Checks all required categories are defined
  - Can be run: `node backend/check-prompts.js`

- **`backend/test-prompt-loader.js`** - Testing script
  - Tests the prompt-loader module
  - Verifies prompts are loaded correctly
  - Can be run: `cd backend && node test-prompt-loader.js`

### 2. Modified Files

- **`backend/lib/deepseek-engine.js`**
  - Removed hardcoded `buildSystemInstructions()` function
  - Now imports `buildSystemInstructions` from `prompt-loader.js`
  - All three API calls (analyze-thread, generate-draft, refine-draft) now use the new loader
  - Added debug logging for template selection

## Benefits

✅ **Centralized Configuration** - All prompts in one JSON file  
✅ **Easy Maintenance** - Edit prompts without touching code  
✅ **Better Documentation** - README and EXAMPLES guide users  
✅ **Validation Tools** - Scripts verify prompt integrity  
✅ **Version Control** - Prompts can be tracked separately  
✅ **Scalability** - Easy to add new prompt types or categories  

## How to Edit Prompts

1. Open `backend/prompts/system-instructions.json`
2. Edit the relevant section:
   - Base instructions under `base`
   - Category definitions under `categories`
3. Save the file
4. Verify with: `node backend/check-prompts.js`
5. Restart the backend: `npm start`

## How to Add a New Category

Example: Adding a `refund_dispute` category:

1. Edit `system-instructions.json`:
```json
{
  "categories": {
    "refund_dispute": "Customer disputes a charge or refund decision..."
  }
}
```

2. Verify: `node backend/check-prompts.js`
3. Update mock-engine.js if needed for mock classification
4. Add corresponding template in `backend/templates/` if needed
5. Restart backend and test

## File Structure

```
email-copilot/
├── backend/
│   ├── lib/
│   │   ├── deepseek-engine.js (modified)
│   │   ├── prompt-loader.js (new)
│   │   └── ...
│   ├── prompts/
│   │   ├── system-instructions.json (new)
│   │   ├── README.md (new)
│   │   └── EXAMPLES.md (new)
│   ├── check-prompts.js (new)
│   ├── test-prompt-loader.js (new)
│   └── ...
└── ...
```

## Testing After Changes

Run the validation scripts to verify everything works:

```bash
# Check prompt file integrity
node backend/check-prompts.js

# Test the prompt-loader module
cd backend && node test-prompt-loader.js

# Test with actual backend
npm start
# Then test with sample tickets in the UI
```

## Backward Compatibility

✅ No changes required to extension code  
✅ No changes to API endpoints  
✅ No changes to database  
✅ Fully backward compatible - same behavior as before

## Future Enhancements

Consider implementing:
- Language-specific prompts (currently English-only)
- Template-specific prompts
- A/B testing different prompt versions
- Prompt versioning/history
- Web UI for editing prompts

## References

- System Prompts: `backend/prompts/system-instructions.json`
- Loader Code: `backend/lib/prompt-loader.js`
- Integration Point: `backend/lib/deepseek-engine.js`
