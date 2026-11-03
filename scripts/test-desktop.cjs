const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');
const root = path.resolve(__dirname, '..');
const checks = process.argv.slice(2);
if (!checks.length) checks.push('electron-smoke', 'renderer-flow', 'autoconnect-flow', 'usage-flow', 'commands-flow', 'folder-upload-flow', 'credentials-crossprocess', 'updates-flow');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const check of checks) {
  if (!/^[a-z-]+$/.test(check)) throw new Error('Invalid desktop test name');
  const file = path.join(root, 'tests', `${check}.cjs`);
  const nodeTest = check === 'credentials-crossprocess';
  const result = spawnSync(nodeTest ? process.execPath : electron, nodeTest ? [file] : ['--disable-gpu', file], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
