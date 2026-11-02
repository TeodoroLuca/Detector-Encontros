/** Benchmark isolado, determinístico e reproduzível; sem dependências de runtime. */
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

if (process.argv[2] === '--worker') {
  const [source, input, output, mode, policy, repetitionsText] = process.argv.slice(3);
  const { processFile } = await import(pathToFileURL(path.join(source, 'cli.js')).href);
  const { parseLine, isHeader } = await import(pathToFileURL(path.join(source, 'parser.js')).href);
  const { detectGroup } = await import(pathToFileURL(path.join(source, 'algorithm.js')).href);
  const opts = { mode, genericPolicy: policy };
  await processFile(input, output, opts); // aquecimento idêntico para cada implementação
  const runs = [];
  for (let i = 0; i < Number(repetitionsText); i++) {
    const result = await processFile(input, output, opts);
    runs.push({ durationMs: result.durationMs, rssBytes: process.memoryUsage().rss });
  }
  // Leitura + parsing em passe isolado; não somar este tempo ao tempo total.
  const parseStart = performance.now();
  let rows = 0;
  for await (const line of createInterface({ input: fs.createReadStream(input, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (!line.trim() || isHeader(line)) continue;
    parseLine(line, ++rows);
  }
  const readParseMs = performance.now() - parseStart;
  // Todos cenários do benchmark têm timestamps ordenados. Mede só o motor, sem escrita.
  let group = [];
  let timestamp;
  let geospatialMs = 0;
  let encounters = 0;
  const metrics = { potentialPairs: 0, candidatePairs: 0, haversineCalculations: 0, directGroups: 0, spatialGroups: 0 };
  function flush() {
    if (!group.length) return;
    const start = performance.now();
    for (const ignored of detectGroup(group, { genericPolicy: policy, metrics })) encounters++;
    geospatialMs += performance.now() - start;
    group = [];
  }
  for await (const line of createInterface({ input: fs.createReadStream(input, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (!line.trim() || isHeader(line)) continue;
    const row = parseLine(line);
    if (timestamp !== undefined && timestamp !== row.timestamp) flush();
    timestamp = row.timestamp;
    group.push(row);
  }
  flush();
  const hash = await digest(output);
  console.log(JSON.stringify({ rows, encounters, metrics, runs, medianMs: median(runs.map(r => r.durationMs)), readParseMs, geospatialMs, peakRssBytes: process.resourceUsage().maxRSS * 1024, outputSha256: hash }));
} else {
  const args = process.argv.slice(2);
  const legacyIndex = args.indexOf('--legacy');
  const repetitionsIndex = args.indexOf('--repetitions');
  const repetitions = repetitionsIndex < 0 ? 3 : Number(args[repetitionsIndex + 1]);
  if (!Number.isSafeInteger(repetitions) || repetitions < 3) throw new Error('Use ao menos 3 repetições.');
  const legacy = legacyIndex >= 0 ? path.resolve(args[legacyIndex + 1]) : fs.existsSync(path.join(root, 'src/cli.js')) ? path.join(root, 'src') : null;
  const implementations = [...(legacy ? [{ name: 'javascript-original', source: legacy }] : []), { name: 'typescript-compilado', source: path.join(root, 'dist/src') }];
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'detector-benchmark-'));
  const results = [];
  const scenarios = [{ name: 'dataset1', input: path.join(root, 'datasets/dataset1.txt'), mode: 'unordered', policy: 'all' }, { name: 'dataset1-tornozeleiras', input: path.join(root, 'datasets/dataset1.txt'), mode: 'unordered', policy: 'tornozeleiras' }];
  let seed = 0x51ace;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  async function generate(count, density) {
    seed = 0x51ace;
    const input = path.join(folder, `${density}-${count}.txt`);
    const stream = fs.createWriteStream(input);
    const finished = new Promise((resolve, reject) => { stream.once('finish', resolve); stream.once('error', reject); });
    async function write(text) { if (!stream.write(text)) await once(stream, 'drain'); }
    await write('idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida\n');
    for (let i = 0; i < count; i++) {
      const group = Math.floor(i / 128);
      const timestamp = new Date(Date.UTC(2024, 0, 1) + group * 1000).toISOString().slice(0, 19).replace('T', ' ');
      // Denso: 16 aglomerados de 8 posições por timestamp; esparso: globo inteiro.
      const cluster = Math.floor((i % 128) / 8);
      const lat = density === 'dense' ? -25 + cluster * 0.01 + random() * 0.00005 : -85 + random() * 170;
      const lon = density === 'dense' ? -49 + random() * 0.00005 : -180 + random() * 360;
      await write(`${i + 1};${i % 3};${timestamp};${lat};${lon};false;\n`);
    }
    stream.end();
    await finished;
    return input;
  }
  try {
    if (!args.includes('--quick')) {
      for (const count of [5000, 10000, 100000, ...(args.includes('--million') ? [1000000] : [])]) {
        for (const density of ['sparse', 'dense']) {
          const input = await generate(count, density);
          scenarios.push({ name: `${density}-${count}`, input, mode: 'unordered', policy: 'all' });
          if (count >= 100000) scenarios.push({ name: `${density}-${count}-sorted`, input, mode: 'sorted', policy: 'all' });
        }
      }
    }
    for (const [index, scenario] of scenarios.entries()) {
      let expectedHash;
      // Alternar a ordem reduz viés de cache entre implementações; cada filho ainda aquece.
      const ordered = index % 2 ? [...implementations].reverse() : implementations;
      for (const implementation of ordered) {
        process.stderr.write(`${scenario.name}: ${implementation.name}\n`);
        const proc = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', implementation.source, scenario.input, path.join(folder, 'result.json'), scenario.mode, scenario.policy, String(repetitions)], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        if (proc.error) throw proc.error;
        if (proc.status !== 0) throw new Error(proc.stderr || `Benchmark terminou: ${proc.status}`);
        const result = JSON.parse(proc.stdout);
        if (expectedHash && result.outputSha256 !== expectedHash) throw new Error(`Divergência de output em ${scenario.name}`);
        expectedHash = result.outputSha256;
        results.push({ scenario: scenario.name, implementation: implementation.name, mode: scenario.mode, policy: scenario.policy, ...result });
      }
    }
    const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), repetitions, warmups: 1, seed: '0x51ace', stageTiming: 'readParseMs e geospatialMs são passes isolados, diagnósticos não aditivos; peakRssBytes inclui aquecimento e todos passes do filho', exactOutputEquality: implementations.length === 2, results };
    const reportName = implementations.length === 2 ? 'comparison.json' : 'latest.json';
    await fsp.writeFile(path.join(root, 'benchmarks', reportName), JSON.stringify(report, null, 2) + '\n');
    console.table(results.map(r => ({ scenario: r.scenario, implementation: r.implementation, medianMs: +r.medianMs.toFixed(2), peakRssMiB: +(r.peakRssBytes / 1048576).toFixed(1), encounters: r.encounters })));
    console.log(`Relatório: benchmarks/${reportName}`);
  } finally {
    // Diretório criado pelo próprio benchmark, sem relação com dados do usuário.
    await fsp.rm(folder, { recursive: true, force: true });
  }
}
