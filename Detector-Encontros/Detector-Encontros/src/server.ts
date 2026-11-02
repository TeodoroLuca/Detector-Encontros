import http from 'node:http';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { processFile } from './cli.js';
import { inspectFile } from './inspection.js';
import { assertEncounter, compare } from './compare.js';
import { DatasetError, ResourceLimitError, readDatasetLines } from './parser.js';
import { streamZip } from './zip.js';
import type {
  ProcessingJob, JobSummary, Encontro, ResultsRequest, ResultsResponse, MapResponse,
  InspectResponse, JobsResponse, ProcessResponse, CompareResponse, ErrorResponse, HealthResponse
} from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const EXAMPLE = path.join(ROOT, 'exemplos', 'exemplo.txt');
const MIB = 1024 * 1024;
const MAX_REFERENCE = 20 * MIB;
const MIME: Readonly<Record<string, string>> = {
  '/': 'text/html; charset=utf-8', '/index.html': 'text/html; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8', '/app.js': 'application/javascript; charset=utf-8',
  '/map.js': 'application/javascript; charset=utf-8', '/premium.css': 'text/css; charset=utf-8',
  '/refinement.css': 'text/css; charset=utf-8', '/world.json': 'application/json; charset=utf-8',
  '/favicon.svg': 'image/svg+xml'
};

export interface ServerOptions {
  maxUploadBytes?: number;
  maxConcurrentJobs?: number;
  maxRecords?: number;
  maxOutputBytes?: number;
  maxStoredOutputBytes?: number;
  maxJobs?: number;
  requestTimeoutMs?: number;
}
interface ServerLimits {
  maxUploadBytes: number;
  maxConcurrentJobs: number;
  maxRecords: number;
  maxOutputBytes: number;
  maxStoredOutputBytes: number;
  maxJobs: number;
  requestTimeoutMs: number;
}
type HttpStatus = 400 | 404 | 413 | 429;
class HttpError extends Error {
  readonly code = 'HTTP_ERROR';
  constructor(readonly status: HttpStatus, message: string) { super(message); }
}
function fail(status: HttpStatus, message: string): HttpError { return new HttpError(status, message); }
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Configuração ${name} deve ser um inteiro positivo.`);
  return value;
}
function configured(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Configuração ${name} deve ser um inteiro positivo.`);
  return positiveInteger(Number(raw), name);
}
function limitsFromOptions(options: ServerOptions): ServerLimits {
  return {
    maxUploadBytes: positiveInteger(options.maxUploadBytes ?? configured('MAX_UPLOAD_MB', 10_240) * MIB, 'MAX_UPLOAD_MB'),
    maxConcurrentJobs: positiveInteger(options.maxConcurrentJobs ?? configured('MAX_CONCURRENT_JOBS', 1), 'MAX_CONCURRENT_JOBS'),
    maxRecords: positiveInteger(options.maxRecords ?? configured('MAX_RECORDS', 20_000_000), 'MAX_RECORDS'),
    maxOutputBytes: positiveInteger(options.maxOutputBytes ?? configured('MAX_OUTPUT_MB', 512) * MIB, 'MAX_OUTPUT_MB'),
    maxStoredOutputBytes: positiveInteger(options.maxStoredOutputBytes ?? configured('MAX_STORED_OUTPUT_MB', 1024) * MIB, 'MAX_STORED_OUTPUT_MB'),
    maxJobs: positiveInteger(options.maxJobs ?? configured('MAX_JOBS', 100), 'MAX_JOBS'),
    requestTimeoutMs: positiveInteger(options.requestTimeoutMs ?? configured('REQUEST_TIMEOUT_SECONDS', 900) * 1000, 'REQUEST_TIMEOUT_SECONDS')
  };
}
function securityHeaders(): OutgoingHttpHeaders {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store'
  };
}
type ApiPayload = HealthResponse | InspectResponse | JobsResponse | ProcessResponse |
  CompareResponse | ErrorResponse | ResultsResponse | MapResponse;
function replyJson(res: ServerResponse, code: number, payload: ApiPayload): void {
  if (res.destroyed) return;
  const data = JSON.stringify(payload);
  res.writeHead(code, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function safeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().endsWith('.txt') || trimmed.length > 160 || trimmed.length < 5) {
    throw fail(400, 'Selecione um arquivo com extensão .txt.');
  }
  // Names are display metadata only; storage paths always use generated UUIDs.
  return path.posix.basename(path.win32.basename(trimmed)).replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 140);
}
function summary(job: ProcessingJob): JobSummary {
  return {
    id: job.id, filename: job.filename, size: job.size, count: job.count,
    duplicated: job.duplicated, timestamps: job.timestamps, encounters: job.encounters,
    byType: job.byType, durationMs: job.durationMs, performanceMetrics: job.performanceMetrics,
    createdAt: job.createdAt
  };
}
function checkLength(req: IncomingMessage, limit: number): void {
  const header = req.headers['content-length'];
  if (header !== undefined && (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header)))) {
    throw fail(400, 'Tamanho do arquivo inválido.');
  }
  if (Number(header) > limit) throw fail(413, `Arquivo excede o limite de ${Math.ceil(limit / MIB)} MB.`);
}
async function receiveFile(req: IncomingMessage, filepath: string, limit: number, signal: AbortSignal): Promise<number> {
  checkLength(req, limit);
  let size = 0;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    // Do not destroy the request on a size error: the HTTP client must receive 413.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw fail(400, 'Bloco de upload inválido.');
      size += chunk.byteLength;
      if (size > limit) throw fail(413, 'Arquivo acima do limite permitido.');
      yield chunk;
    }
  }
  await pipeline(chunks(), fs.createWriteStream(filepath, { flags: 'wx' }), { signal });
  if (!size) throw fail(400, 'O arquivo está vazio.');
  return size;
}
async function receiveJson(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  checkLength(req, MAX_REFERENCE);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) throw fail(400, 'Bloco de upload inválido.');
    length += chunk.byteLength;
    if (length > MAX_REFERENCE) throw fail(413, 'Gabarito acima do limite de 20 MB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) as unknown; }
  catch { throw fail(400, 'O gabarito deve conter JSON válido.'); }
}
async function* readOutput(filePath: string, signal: AbortSignal): AsyncGenerator<Encontro> {
  // Reuse the reader that retains its error handler through stream close,
  // including early pagination exits and client cancellation.
  for await (const line of readDatasetLines(filePath, signal)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    const row: unknown = JSON.parse(trimmed.replace(/,$/, ''));
    assertEncounter(row);
    yield row;
  }
}
async function readResults(filePath: string, options: ResultsRequest & { totalEncounters: number }, signal: AbortSignal): Promise<ResultsResponse> {
  const { offset, limit, type, search, totalEncounters } = options;
  const items: Encontro[] = [];
  let found = 0;
  const filterActive = Boolean(type || search);
  for await (const row of readOutput(filePath, signal)) {
    if (type && row.tipo !== type) continue;
    if (search && !row.timestamp.includes(search) && !row.monitoradosEncontro.some(id => String(id).includes(search))) continue;
    if (found >= offset && items.length < limit) items.push(row);
    found++;
    if (!filterActive && found >= offset + limit) break;
  }
  return { items, total: filterActive ? found : totalEncounters, offset, limit };
}
/** Deterministic sample across the entire result; the official output is untouched. */
async function readMapResults(filePath: string, total: number, signal: AbortSignal, maxPoints = 750): Promise<MapResponse> {
  const items: Encontro[] = [];
  let index = 0;
  for await (const row of readOutput(filePath, signal)) {
    const shouldDisplay = total <= maxPoints || Math.floor(index * maxPoints / total) !== Math.floor((index - 1) * maxPoints / total);
    if (shouldDisplay && items.length < maxPoints) items.push(row);
    index++;
  }
  return { items, total, sampled: total > items.length, displayed: items.length };
}
function pagination(url: URL): ResultsRequest {
  const type = url.searchParams.get('type') || '';
  const search = (url.searchParams.get('search') || '').trim();
  const offsetRaw = url.searchParams.get('offset') ?? '0';
  const limitRaw = url.searchParams.get('limit') ?? '10';
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (type !== '' && type !== 'generico' && type !== 'faccao' && type !== 'protetiva') throw fail(400, 'Tipo inválido.');
  if (search.length > 80 || !/^\d+$/.test(offsetRaw) || !/^\d+$/.test(limitRaw) ||
      !Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw fail(400, 'Parâmetros de paginação ou pesquisa inválidos.');
  }
  return { offset, limit, type, search };
}
async function sendFile(res: ServerResponse, filename: string, contentType: string, signal: AbortSignal, headers: OutgoingHttpHeaders = {}): Promise<void> {
  const stat = await fs.promises.stat(filename);
  res.writeHead(200, { ...securityHeaders(), 'Content-Type': contentType, 'Content-Length': stat.size, ...headers });
  await pipeline(fs.createReadStream(filename), res, { signal });
}

export function createAppServer(options: ServerOptions = {}): http.Server {
  const limits = limitsFromOptions(options);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-de-encontros-'));
  const jobs = new Map<string, ProcessingJob>();
  let active = 0;
  let storedBytes = 0;
  async function withSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= limits.maxConcurrentJobs) throw fail(429, 'Limite de processamentos simultâneos atingido. Tente novamente após a conclusão.');
    active++;
    try { return await operation(); }
    finally { active--; }
  }
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    const { signal } = controller;
    const onClose = (): void => { if (!res.writableFinished) controller.abort(); };
    const onAborted = (): void => { controller.abort(); };
    res.once('close', onClose);
    req.once('aborted', onAborted);
    try {
      let url: URL;
      try { url = new URL(req.url || '/', 'http://localhost'); }
      catch { throw fail(400, 'URL inválida.'); }
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/api/health') return replyJson(res, 200, {
        status: 'ok', limits: {
          maxUploadBytes: limits.maxUploadBytes, maxRecords: limits.maxRecords,
          maxConcurrentJobs: limits.maxConcurrentJobs, requestTimeoutMs: limits.requestTimeoutMs
        }
      });
      if (req.method === 'GET' && pathname === '/api/example') {
        return await sendFile(res, EXAMPLE, 'text/plain; charset=utf-8', signal);
      }
      if (req.method === 'GET' && pathname === '/api/jobs') return replyJson(res, 200, { jobs: [...jobs.values()].map(summary) });
      if (req.method === 'POST' && pathname === '/api/inspect') {
        const filename = safeName(url.searchParams.get('filename') || '');
        const payload = await withSlot(async (): Promise<InspectResponse> => {
          const folder = await fs.promises.mkdtemp(path.join(storage, 'inspection-'));
          try {
            const input = path.join(folder, 'entrada.txt');
            const size = await receiveFile(req, input, limits.maxUploadBytes, signal);
            const inspection = await inspectFile(input, { signal, maxRecords: limits.maxRecords });
            return { filename, size, inspection };
          } finally { await fs.promises.rm(folder, { recursive: true, force: true }); }
        });
        return replyJson(res, 200, payload);
      }
      if (req.method === 'GET' && pathname === '/api/download-all') {
        const list = [...jobs.values()];
        if (!list.length) throw fail(404, 'Nenhum resultado disponível para exportação.');
        if (list.length > 65000) throw fail(400, 'Quantidade máxima de arquivos excedida.');
        // Reserve enough for both headers, descriptor and the UTF-8 name of each entry.
        const zipUpperBound = storedBytes + list.reduce((n, job) => n + 128 + Buffer.byteLength(job.filename) * 2 + 32, 22);
        if (zipUpperBound >= 0xffffffff) throw fail(413, 'O arquivo ZIP excederia 4 GB. Exporte individualmente.');
        res.writeHead(200, { ...securityHeaders(), 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="resultados-detector.zip"' });
        await streamZip(res, list);
        return;
      }
      const compareMatch = pathname.match(/^\/api\/jobs\/([\da-f-]{36})\/compare$/);
      const compareId = compareMatch?.[1];
      if (req.method === 'POST' && compareId !== undefined) {
        const job = jobs.get(compareId);
        if (!job) throw fail(404, 'Processamento não encontrado.');
        return await withSlot(async () => {
          const reference = await receiveJson(req, signal);
          if (!Array.isArray(reference)) throw fail(400, 'O gabarito deve conter um array JSON.');
          if ((await fs.promises.stat(job.output)).size > MAX_REFERENCE) throw fail(413, 'Resultado muito grande para comparação pela interface; use o comparador CLI.');
          const actual: unknown = JSON.parse(await fs.promises.readFile(job.output, { encoding: 'utf8', signal }));
          try {
            const report = compare(reference, actual);
            const issues = report.issues;
            replyJson(res, 200, { report: { ...report, issues: {
              missing: issues.missing.slice(0, 12), extra: issues.extra.slice(0, 12),
              wrongType: issues.wrongType.slice(0, 12), wrongPosition: issues.wrongPosition.slice(0, 12),
              wrongDistance: issues.wrongDistance.slice(0, 12), duplicate: issues.duplicate.slice(0, 12)
            } } });
          } catch (error) {
            throw fail(400, `Não foi possível comparar: ${error instanceof Error ? error.message : 'gabarito inválido.'}`);
          }
        });
      }
      if (req.method === 'POST' && pathname === '/api/process') {
        const filename = safeName(url.searchParams.get('filename') || '');
        const genericPolicy = url.searchParams.get('genericPolicy') || 'all';
        const mode = url.searchParams.get('mode') || 'unordered';
        if (genericPolicy !== 'all' && genericPolicy !== 'tornozeleiras') throw fail(400, 'Política de encontros genéricos inválida.');
        if (mode !== 'unordered' && mode !== 'sorted') throw fail(400, 'Modo de processamento inválido.');
        checkLength(req, limits.maxUploadBytes);
        if (jobs.size >= limits.maxJobs) throw fail(413, 'Limite de resultados da sessão atingido. Exporte os arquivos e reinicie o servidor.');
        return await withSlot(async () => {
          const id = randomUUID();
          const folder = path.join(storage, id);
          await fs.promises.mkdir(folder);
          const input = path.join(folder, 'entrada.txt');
          const output = path.join(folder, 'resultado.json');
          try {
            const size = await receiveFile(req, input, limits.maxUploadBytes, signal);
            const metrics = await processFile(input, output, { mode, genericPolicy, signal, maxRecords: limits.maxRecords, maxOutputBytes: limits.maxOutputBytes });
            const outputBytes = (await fs.promises.stat(output)).size;
            await fs.promises.unlink(input);
            signal.throwIfAborted();
            if (jobs.size >= limits.maxJobs || storedBytes + outputBytes > limits.maxStoredOutputBytes) {
              throw fail(413, 'Limite de armazenamento da sessão atingido. Exporte os arquivos e reinicie o servidor.');
            }
            const job: ProcessingJob = { id, filename, size, createdAt: new Date().toISOString(), ...metrics };
            storedBytes += outputBytes;
            jobs.set(id, job);
            replyJson(res, 201, { job: summary(job) });
          } catch (error) {
            await fs.promises.rm(folder, { recursive: true, force: true });
            throw error;
          }
        });
      }
      const match = pathname.match(/^\/api\/jobs\/([\da-f-]{36})\/(results|download|map)$/);
      const id = match?.[1];
      if (req.method === 'GET' && id !== undefined) {
        const job = jobs.get(id);
        if (!job) throw fail(404, 'Processamento não encontrado.');
        if (match?.[2] === 'download') {
          const filename = job.filename.replace(/\.txt$/i, '.json').replace(/["\\]/g, '_');
          const asciiName = filename.replace(/[^\x20-\x7E]/g, '_');
          return await sendFile(res, job.output, 'application/json; charset=utf-8', signal, {
            'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`
          });
        }
        if (match?.[2] === 'map') return replyJson(res, 200, await readMapResults(job.output, job.encounters, signal));
        return replyJson(res, 200, await readResults(job.output, { ...pagination(url), totalEncounters: job.encounters }, signal));
      }
      const mime = Object.hasOwn(MIME, pathname) ? MIME[pathname] : undefined;
      if (req.method === 'GET' && mime !== undefined) {
        const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
        return await sendFile(res, path.join(WEB, filename), mime, signal);
      }
      return replyJson(res, 404, { error: 'Recurso não encontrado.' });
    } catch (error) {
      if (res.headersSent || res.destroyed || signal.aborted) { res.destroy(); return; }
      const status = error instanceof HttpError || error instanceof DatasetError || error instanceof ResourceLimitError ? error.status : 500;
      // Drain rejected uploads without closing TCP while the browser is still
      // sending: an early reset hides the JSON/413 behind an opaque "Failed to fetch".
      // This does not buffer or store the body; requestTimeout bounds the receive.
      if (!req.complete) req.resume();
      replyJson(res, status, { error: status === 500 ? 'Erro interno ao processar arquivo.' : error instanceof Error ? error.message : 'Requisição inválida.' });
      if (status === 500) console.error('Erro inesperado:', error);
    } finally {
      res.off('close', onClose);
      req.off('aborted', onAborted);
    }
  });
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = Math.min(30_000, limits.requestTimeoutMs);
  // Processing can legitimately outlast upload time; disconnects still abort work.
  server.timeout = 0;
  server.on('close', () => {
    void fs.promises.rm(storage, { recursive: true, force: true }).catch(error => console.error('Falha ao limpar arquivos da sessão:', error));
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PORT deve estar entre 0 e 65535.');
  const host = process.env.HOST || '127.0.0.1';
  const server = createAppServer();
  server.listen(port, host, () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`Detector de Encontros: http://${host}:${address.port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
}
