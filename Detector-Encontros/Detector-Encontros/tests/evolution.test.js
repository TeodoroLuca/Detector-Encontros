import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createAppServer } from '../dist/src/server.js';
import { inspectFile } from '../dist/src/inspection.js';
const header = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
const txt = [header, '10;;"2024-01-01 00:00:00";0;0;false;', '11;;"2024-01-01 00:00:00";0;0.00001;false;'].join('\n');
async function serverContext() {
 const server = createAppServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 return { server, base:`http://127.0.0.1:${server.address().port}` };
}
async function stop(server) { await new Promise(resolve => server.close(resolve)); }
test('pré-validação reporta registros, IDs, timestamps e erros detalhados', async () => {
 const { server, base } = await serverContext();
 try {
  const inspected = await fetch(`${base}/api/inspect?filename=test.txt`, { method:'POST', body:txt });
  assert.equal(inspected.status, 200);
  const { inspection } = await inspected.json();
  assert.equal(inspection.valid, true);
  assert.equal(inspection.count, 2);
  assert.equal(inspection.uniqueIds, 2);
  assert.equal(inspection.timestamps, 1);
  const broken = await fetch(`${base}/api/inspect?filename=broken.txt`, {method:'POST',body:`${header}\n12;;2024-01-01 00:00:00;xxx;2;false;`});
  const {inspection: invalid} = await broken.json();
  assert.equal(invalid.valid, false);
  assert.match(invalid.issues[0], /Linha 2: coordenadas inválidas/);
 } finally { await stop(server); }
});
test('métricas do motor, comparação e ZIP completo', async () => {
 const { server, base } = await serverContext();
 try {
  const post = await fetch(`${base}/api/process?filename=teste.txt`, {method:'POST',body:txt});
  assert.equal(post.status, 201);
  const {job} = await post.json();
  assert.equal(job.encounters, 1);
  assert.equal(job.performanceMetrics.potentialPairs, 1);
  assert.equal(job.performanceMetrics.candidatePairs, 1);
  assert.equal(job.performanceMetrics.haversineCalculations, 1);
  const reference = await (await fetch(`${base}/api/jobs/${job.id}/download`)).json();
  const compare = await fetch(`${base}/api/jobs/${job.id}/compare`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reference)});
  assert.equal(compare.status, 200);
  assert.deepEqual((await compare.json()).report.correct, 1);
  const wrong = await fetch(`${base}/api/jobs/${job.id}/compare`, {method:'POST',body:'invalid'});
  assert.equal(wrong.status, 400);
  const zip = await fetch(`${base}/api/download-all`);
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-type'), /zip/);
  // Valida ZIP STORE, diretório central, conteúdo e CRC sem depender de unzip externo.
  const archive = Buffer.from(await zip.arrayBuffer());
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt16LE(end + 10), 1);
  const central = archive.readUInt32LE(end + 16);
  assert.equal(archive.readUInt32LE(central), 0x02014b50);
  const nameLength = archive.readUInt16LE(central + 28);
  assert.equal(archive.subarray(central + 46, central + 46 + nameLength).toString('utf8'), 'teste.json');
  const local = archive.readUInt32LE(central + 42);
  assert.equal(archive.readUInt32LE(local), 0x04034b50);
  assert.equal(archive.readUInt16LE(local + 8), 0);
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const content = archive.subarray(start, start + archive.readUInt32LE(central + 24));
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  assert.equal((crc ^ 0xffffffff) >>> 0, archive.readUInt32LE(central + 16));
  assert.deepEqual(JSON.parse(content.toString('utf8')), reference);
 } finally { await stop(server); }
});
test('pré-validação duplicatas idênticas e contraditórias', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(),'inspection-'));
 try {
   const f = path.join(dir, 'a.txt');
   fs.writeFileSync(f, [txt, '10;;"2024-01-01 00:00:00";0;0;false;', '10;;"2024-01-01 00:00:00";0;0.1;false;'].join('\n'));
   const result = await inspectFile(f);
   assert.equal(result.duplicated,1);
   assert.equal(result.valid,false);
   assert.match(result.issues[0],/contraditórias/);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
