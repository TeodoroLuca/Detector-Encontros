/** Iniciador compartilhado por Windows, Linux e macOS; reutiliza build e servidor. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));

function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} encerrou com ${signal || `código ${code}`}.`));
    });
  });
}

function openBrowser(url) {
  const [executable, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  let notified = false;
  const fallback = () => {
    if (notified) return;
    notified = true;
    console.warn(`Não foi possível abrir o navegador automaticamente. Abra ${url} manualmente.`);
  };
  const browser = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
  browser.once('error', fallback);
  browser.once('exit', code => { if (code !== 0) fallback(); });
  browser.unref();
}

function localUrl(host, port) {
  const accessibleHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const authority = accessibleHost.includes(':') ? `[${accessibleHost}]` : accessibleHost;
  return `http://${authority}:${port}`;
}

async function main() {
  for (const flag of flags) {
    if (!['--no-browser', '--check', '--help'].includes(flag)) throw new Error(`Opção desconhecida: ${flag}. Use --help.`);
  }
  if (flags.has('--help')) {
    console.log('Uso: npm run launch -- [--no-browser | --check | --help]\n' +
      'Sem opções: prepara o build, inicia o servidor e abre o navegador.\n' +
      '--no-browser: inicia o servidor sem abrir o navegador.\n' +
      '--check: prepara o build, verifica a API e a página em uma porta temporária e encerra.');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error(`Node.js ${process.versions.node} não é compatível. Instale Node.js 22 ou superior.`);
  }
  process.chdir(root);
  const checking = flags.has('--check');
  const host = checking ? '127.0.0.1' : process.env.HOST || '127.0.0.1';
  const port = checking ? 0 : Number(process.env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PORT deve estar entre 0 e 65535.');

  if (!fs.existsSync(path.join(root, 'node_modules/typescript/bin/tsc')) ||
      !fs.existsSync(path.join(root, 'node_modules/@types/node/package.json'))) {
    console.log('Instalando dependências do projeto com npm ci...');
    // No Windows, npm é um arquivo .cmd; a linha é fixa, sem interpolar argumentos.
    try {
      if (process.platform === 'win32') await command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci']);
      else await command('npm', ['ci']);
    } catch (error) {
      throw new Error('Não foi possível instalar as dependências. Confira o npm e o acesso à internet e execute npm ci.', { cause: error });
    }
  }
  console.log('Preparando a aplicação...');
  await command(process.execPath, [path.join(root, 'scripts/build.mjs')]);
  const { createAppServer } = await import('../dist/src/server.js');
  const server = createAppServer();
  try {
    const listening = once(server, 'listening');
    server.listen(port, host);
    await listening;
  } catch (error) {
    server.close(() => {});
    if (error?.code === 'EADDRINUSE') throw new Error(`A porta ${port} já está em uso. Feche a instância anterior ou configure outra PORT.`);
    throw error;
  }
  const address = server.address();
  const url = localUrl(host, address.port);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    server.close();
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('close', () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  });

  if (checking) {
    try {
      const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (!health.ok || (await health.json()).status !== 'ok') throw new Error('A API não respondeu corretamente.');
      const page = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!page.ok || !(await page.text()).includes('Detector de Encontros')) throw new Error('A página inicial não respondeu corretamente.');
      console.log('Verificação concluída: build, API e interface disponíveis.');
    } finally {
      const closing = once(server, 'close');
      stop();
      await closing;
    }
    return;
  }
  console.log(`Detector de Encontros: ${url}\nMantenha esta janela aberta. Use Ctrl+C para encerrar.`);
  if (!flags.has('--no-browser')) openBrowser(url);
}

main().catch(error => {
  console.error(`Não foi possível iniciar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
