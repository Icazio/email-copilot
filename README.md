# Email Copilot MVP

This folder now contains:

- Product and planning docs
- A zero-dependency browser extension skeleton
- A zero-dependency Node backend skeleton
- Fixed support templates
- Sample email threads

## Structure

```text
email/
  backend/
  extension/
  templates/
  samples/
  package.json
  run-backend.cmd
```

## MVP scope

- Internal support copilot only
- Browser extension side panel
- Read-only workflow
- English draft replies
- Manual final send by the agent
- Manual lookup results pasted back into the copilot

## Run backend

Use `cmd`:

```bat
run-backend.cmd
```

Or:

```bat
node backend\server.js
```

If you want `openai` mode, create a root `.env` file first:

```text
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5-mini
PORT=8787
```

You can copy from `.env.example`.

Default server URL:

```text
http://localhost:8787
```

## Load extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension` folder
5. Open the target email page
6. Click the extension icon to open the side panel

## Backend modes

The backend supports two modes:

The backend supports three modes:

- `mock`
  Default. Uses local heuristics and templates.
- `deepseek`
  Enabled when `AI_PROVIDER=deepseek` or `DEEPSEEK_API_KEY` is set.
- `openai`
  Enabled when `AI_PROVIDER=openai` or `OPENAI_API_KEY` is set.

Optional environment variables:

```text
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
PORT=8787
```

## Main endpoints

- `GET /health`
- `POST /extract-fields`
- `POST /analyze-thread`
- `POST /generate-draft`
- `POST /refine-draft`

## Notes

- The extension uses generic DOM extraction heuristics because no real Centuran DOM selectors are known yet.
- The backend is intentionally simple so you can iterate without package installs.
- The next recommended step is to replace generic thread extraction with real Centuran selectors and to expand the template pack using real support emails.
