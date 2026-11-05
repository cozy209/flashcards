// Run with: node tests/zip.test.mjs
import assert from 'node:assert/strict';
import { readZip, ZipError } from '../js/zip.js';
import { deckNameFromZip, isVideoEntry } from '../js/importer.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`✓ ${name}`); };

const enc = new TextEncoder();
const deflate = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());

/** Builds a zip. files: [{ path, data: Uint8Array, deflate?: boolean }]. zip64 forces Zip64 records. */
async function makeZip(files, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const body = f.deflate ? await deflate(f.data) : f.data;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, f.deflate ? 8 : 0, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const extra = zip64 ? new DataView(new ArrayBuffer(28)) : null;
    if (extra) {
      extra.setUint16(0, 0x0001, true);
      extra.setUint16(2, 24, true);
      extra.setBigUint64(4, BigInt(f.data.length), true);
      extra.setBigUint64(12, BigInt(body.length), true);
      extra.setBigUint64(20, BigInt(offset), true);
    }
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(10, f.deflate ? 8 : 0, true);
    c.setUint32(20, zip64 ? 0xffffffff : body.length, true);
    c.setUint32(24, zip64 ? 0xffffffff : f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, extra ? 28 : 0, true);
    c.setUint32(42, zip64 ? 0xffffffff : offset, true);
    central.push(new Uint8Array(c.buffer), name, ...(extra ? [new Uint8Array(extra.buffer)] : []));
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const tail = [];
  if (zip64) {
    const rec = new DataView(new ArrayBuffer(56));
    rec.setUint32(0, 0x06064b50, true);
    rec.setBigUint64(32, BigInt(files.length), true);
    rec.setBigUint64(40, BigInt(cdSize), true);
    rec.setBigUint64(48, BigInt(offset), true);
    const loc = new DataView(new ArrayBuffer(20));
    loc.setUint32(0, 0x07064b50, true);
    loc.setBigUint64(8, BigInt(offset + cdSize), true);
    tail.push(new Uint8Array(rec.buffer), new Uint8Array(loc.buffer));
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(10, zip64 ? 0xffff : files.length, true);
  end.setUint32(12, zip64 ? 0xffffffff : cdSize, true);
  end.setUint32(16, zip64 ? 0xffffffff : offset, true);
  return new Blob([...parts, ...central, ...tail, new Uint8Array(end.buffer)]);
}

const video = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);
const text = async (e) => new Uint8Array(await e.arrayBuffer());

await test('reads stored and deflated entries, skips folders', async () => {
  const a = video(5000);
  const b = video(12345);
  const zip = await makeZip([
    { path: 'Alphabet/', data: new Uint8Array() },
    { path: 'Alphabet/a.mp4', data: a },
    { path: 'Alphabet/thank_you.mov', data: b, deflate: true },
  ]);
  const entries = await readZip(zip);
  assert.deepEqual(entries.map((e) => [e.path, e.name, e.size]), [
    ['Alphabet/a.mp4', 'a.mp4', 5000],
    ['Alphabet/thank_you.mov', 'thank_you.mov', 12345],
  ]);
  assert.deepEqual(await text(entries[0]), a);
  assert.deepEqual(await text(entries[1]), b);
});

await test('reads Zip64 archives', async () => {
  const a = video(3000);
  const entries = await readZip(await makeZip([{ path: 'x.mp4', data: new Uint8Array(10) }, { path: 'hello.mp4', data: a, deflate: true }], { zip64: true }));
  assert.equal(entries[1].size, 3000);
  assert.deepEqual(await text(entries[1]), a);
});

await test('rejects non-zip files', async () => {
  await assert.rejects(readZip(new Blob([enc.encode('not a zip at all, sorry')])), ZipError);
});

await test('deck name from zip file name', () => {
  assert.equal(deckNameFromZip('Alphabet.zip'), 'Alphabet');
  assert.equal(deckNameFromZip('Greetings (1).ZIP'), 'Greetings');
  assert.equal(deckNameFromZip('Family signs-20261105T101500Z-001.zip'), 'Family signs');
});

await test('only real videos are imported from a zip', () => {
  assert.equal(isVideoEntry('Alphabet/a.mp4'), true);
  assert.equal(isVideoEntry('A/B/thank_you.MOV'), true);
  assert.equal(isVideoEntry('__MACOSX/Alphabet/._a.mp4'), false);
  assert.equal(isVideoEntry('Alphabet/._a.mp4'), false);
  assert.equal(isVideoEntry('Alphabet/notes.txt'), false);
  assert.equal(isVideoEntry('Alphabet/.DS_Store'), false);
});

console.log(`\n${passed} passed`);
