import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
const processes = [
  spawn(process.execPath, [compiler, '-p', 'tsconfig.server.json', '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [compiler, '-p', 'tsconfig.web.json', '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', 'dist/src/server.js'], { cwd: root, stdio: 'inherit' })
];
const assets = watch(path.join(root, 'web'), (_event, name) => {
  if (name && !/\.(?:js|ts|map)$/.test(name)) {
    cp(path.join(root, 'web', name), path.join(root, 'dist/web', name)).catch(error => console.error('Asset:', error.message));
  }
});
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  assets.close();
  for (const child of processes) child.kill();
  process.exitCode = code;
}
for (const child of processes) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!closing) stop(code ?? 1); });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
console.log('Desenvolvimento: fontes TS e assets monitorados. Recarregue o navegador após alterações.');
