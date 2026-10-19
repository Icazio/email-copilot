const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '..');
const files = ['backend/server.js', ...['backend/lib','backend/admin','extension'].flatMap(dir =>
  fs.readdirSync(path.join(base,dir)).filter(f=>f.endsWith('.js')).map(f=>dir+'/'+f))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd:base, stdio:'inherit', windowsHide:true });
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
console.log(`Syntax checks passed: ${files.length} JavaScript files.`);
