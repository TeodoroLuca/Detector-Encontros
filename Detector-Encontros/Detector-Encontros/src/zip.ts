import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

interface ZipSource { filename: string; output: string }
interface ZipEntry { name: string; size: number; crc: number; offset: number }

// STORE + data descriptors: each JSON is streamed, never buffered in full.
const TABLE = new Uint32Array(256);
const FLAGS = 0x0808; // UTF-8 filenames and trailing data descriptor.
const MAX_UINT32 = 0xffffffff;
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}
function crcUpdate(value: number, data: Uint8Array): number {
  for (const b of data) {
    // The mask always indexes one of the 256 initialized table entries.
    const entry = TABLE[(value ^ b) & 0xff];
    if (entry === undefined) throw new Error('Tabela CRC inválida.');
    value = entry ^ (value >>> 8);
  }
  return value >>> 0;
}
function u16(b: Buffer, at: number, value: number): void { b.writeUInt16LE(value, at); }
function u32(b: Buffer, at: number, value: number): void { b.writeUInt32LE(value >>> 0, at); }
function bufferLocal(name: string): Buffer {
  const nameBuf = Buffer.from(name);
  const b = Buffer.alloc(30 + nameBuf.length);
  u32(b, 0, 0x04034b50); u16(b, 4, 20); u16(b, 6, FLAGS); u16(b, 8, 0);
  u16(b, 26, nameBuf.length);
  nameBuf.copy(b, 30);
  return b;
}
function bufferCentral(item: ZipEntry): Buffer {
  const name = Buffer.from(item.name);
  const b = Buffer.alloc(46 + name.length);
  u32(b, 0, 0x02014b50); u16(b, 4, 20); u16(b, 6, 20); u16(b, 8, FLAGS);
  u32(b, 16, item.crc); u32(b, 20, item.size); u32(b, 24, item.size);
  u16(b, 28, name.length); u32(b, 42, item.offset);
  name.copy(b, 46);
  return b;
}
async function write(res: ServerResponse, data: Uint8Array): Promise<void> {
  if (res.destroyed || res.writableEnded) throw new Error('Conexão encerrada.');
  if (res.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error('Conexão encerrada.')); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (res.destroyed) onClose();
  });
}

export async function streamZip(res: ServerResponse, jobs: readonly ZipSource[]): Promise<void> {
  if (jobs.length > 65535) throw new Error('Quantidade máxima de arquivos ZIP excedida.');
  const seen = new Set<string>();
  const entries: ZipEntry[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const job of jobs) {
    const base = path.basename(job.filename).replace(/\.txt$/i, '').replace(/[^\p{L}\p{N}_.-]/gu, '_');
    let occurrence = 1;
    let name = `${base}.json`;
    while (seen.has(name)) name = `${base}_${++occurrence}.json`;
    seen.add(name);
    const size = (await fs.promises.stat(job.output)).size;
    const nameLength = Buffer.byteLength(name);
    centralSize += 46 + nameLength;
    if (nameLength > 65535 || size >= MAX_UINT32 || offset + size + 30 + nameLength + 16 + centralSize + 22 >= MAX_UINT32) {
      throw new Error('O ZIP excede o limite de 4 GiB. Exporte os JSONs individualmente.');
    }
    const start = offset;
    const header = bufferLocal(name);
    await write(res, header); offset += header.length;
    let crc = 0xffffffff;
    const source = fs.createReadStream(job.output);
    const abort = (): void => { source.destroy(new Error('Conexão encerrada.')); };
    res.once('close', abort);
    try {
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Bloco ZIP inválido.');
        crc = crcUpdate(crc, chunk);
        await write(res, chunk);
      }
    } finally {
      res.off('close', abort);
      source.destroy();
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const desc = Buffer.alloc(16);
    u32(desc, 0, 0x08074b50); u32(desc, 4, crc); u32(desc, 8, size); u32(desc, 12, size);
    await write(res, desc); offset += size + desc.length;
    entries.push({ name, size, crc, offset: start });
  }
  const centralOffset = offset;
  for (const item of entries) {
    const b = bufferCentral(item);
    await write(res, b); offset += b.length;
  }
  const end = Buffer.alloc(22);
  u32(end, 0, 0x06054b50); u16(end, 8, entries.length); u16(end, 10, entries.length);
  u32(end, 12, offset - centralOffset); u32(end, 16, centralOffset);
  await write(res, end);
  res.end();
}
