import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const config of ['tsconfig.server.json', 'tsconfig.web.json']) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', config], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir(path.join(root, 'dist/web'), { recursive: true });
for (const entry of await readdir(path.join(root, 'web'), { withFileTypes: true })) {
  if (entry.isFile() && !/\.(?:js|ts|map)$/.test(entry.name)) {
    await cp(path.join(root, 'web', entry.name), path.join(root, 'dist/web', entry.name));
  }
}
await cp(path.join(root, 'exemplos'), path.join(root, 'dist/exemplos'), { recursive: true });
const { name, version, engines } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(root, 'dist/package.json'), JSON.stringify({ name, version, private: true, type: 'module', engines, scripts: { start: 'node src/server.js' } }, null, 2) + '\n');
console.log('Build TypeScript e assets concluído em dist/.');
