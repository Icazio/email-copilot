# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Email Copilot MVP — a Chrome extension + local Node.js backend that helps customer support agents draft English email replies. The extension runs in a browser side panel, captures email threads from a ticketing system (Centuran), and calls the backend to analyze, categorize, and generate draft replies. Agents manually review and send the final reply; the tool is read-only by design.

## Commands

```bash
# Start backend server (port 8787)
npm start
# or
node backend/server.js
# or on Windows
run-backend.cmd

# Syntax check all JS files
npm run check
```

No build step required — the project uses vanilla JS and Node.js with zero npm dependencies.

**Load extension in Chrome:**
1. Go to `chrome://extensions`, enable Developer mode
2. "Load unpacked" → select the `extension/` folder
3. Open a target email page and click the extension icon

**Configure AI provider** — copy `.env.example` to `.env`:
```
AI_PROVIDER=deepseek   # deepseek | openai | mock (default)
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
PORT=8787
```

## Architecture

The system has two parts that communicate over HTTP:

### Backend (`backend/`)
- `server.js` — zero-dependency Node.js HTTP server; routes to the active AI engine based on `AI_PROVIDER` env var; falls back to mock engine on failure; loads templates from `templates/` at startup
- `lib/mock-engine.js` — default engine; uses regex pattern matching + template interpolation, no API calls needed
- `lib/deepseek-engine.js` / `lib/openai-engine.js` — real LLM engines
- `lib/helpers.js` — shared text normalization and template loading utilities

### Extension (`extension/`)
- `content.js` — content script; extracts the email thread from the page DOM using CSS selectors (generic selectors currently; real Centuran selectors are pending)
- `panel.js` + `panel.html` + `panel.css` — side panel UI; orchestrates the multi-step workflow: extract → analyze → generate draft → (optional) refine with agent notes
- `background.js` — Manifest V3 service worker for setup

### API Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check; returns current mode and model |
| POST | `/extract-fields` | Extract order ID, email, product name, etc. from thread |
| POST | `/analyze-thread` | Categorize issue; match to a template |
| POST | `/generate-draft` | Generate initial reply draft |
| POST | `/refine-draft` | Refine draft given agent lookup results or notes |

### Templates (`templates/`)
Five pre-built JSON templates for common scenarios: refund, invoice request, license code not working, auto-renewal cancellation, technical issue info collection. The mock engine selects and fills these via keyword matching; LLM engines use them as structured prompts.

## Key Constraints

- **Zero npm dependencies** — intentional; do not add packages. Use only built-in Node.js modules (`http`, `fs`, `path`, `url`, `crypto`).
- **Centuran DOM selectors** — `extension/content.js` uses placeholder selectors. Real selectors must be captured from the actual Centuran ticketing UI before production use.
- **English only** — all draft generation targets English; the templates and prompts are English-only.
