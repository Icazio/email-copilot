const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Capture the exact serialized request body without receiving the real API key.
// Logging is best-effort and must never change the model request or its response.
function recordDeepSeekRequest(body, kind = 'chat') {
  if (process.env.DEEPSEEK_REQUEST_LOG === '0') return null;
  try {
    const directory = path.resolve(process.env.DEEPSEEK_REQUEST_LOG_DIR || path.join(__dirname, '../.cache/deepseek-requests'));
    const timestamp = new Date().toISOString();
    const id = timestamp.replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
    const record = {
      id, timestamp, kind,
      method: 'POST', url: 'https://api.deepseek.com/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer [REDACTED]' },
      body: JSON.parse(body)
    };
    const output = JSON.stringify(record, null, 2) + '\n';
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, id + '.json');
    fs.writeFileSync(file, output, { mode: 0o600 });
    const temporary = path.join(directory, '.latest-' + id + '.tmp');
    fs.writeFileSync(temporary, output, { mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, 'latest.json'));
    return file;
  } catch (error) {
    console.warn('DeepSeek request logging failed:', error.code || error.name);
    return null;
  }
}

module.exports = { recordDeepSeekRequest };
