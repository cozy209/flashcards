// Minimal zip reader. Reads the central directory, then extracts entries on
// demand with Blob.slice + DecompressionStream, so a large zip is never loaded
// into memory all at once. Supports stored and deflated entries and Zip64.

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const view = async (blob, start, end) => new DataView(await blob.slice(start, end).arrayBuffer());
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));

export class ZipError extends Error {}

/**
 * @param {Blob} blob
 * @returns {Promise<Array<{ path: string, name: string, size: number, type: string, arrayBuffer: () => Promise<ArrayBuffer> }>>}
 * Only files are returned (no folders). `name` is the file name without folders.
 */
export async function readZip(blob) {
  // End of central directory: 22 bytes + up to 64 KB comment, at the end of the file.
  const tailStart = Math.max(0, blob.size - 22 - 0xffff);
  const tail = await view(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('Ce n\'est pas un fichier zip.');

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== ZIP64_LOCATOR) throw new ZipError('Fichier Zip64 endommagé.');
    const recOffset = u64(tail, loc + 8);
    const rec = await view(blob, recOffset, recOffset + 56);
    if (rec.getUint32(0, true) !== ZIP64_EOCD) throw new ZipError('Fichier Zip64 endommagé.');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }

  const cd = await view(blob, cdOffset, cdOffset + cdSize);
  const utf8 = new TextDecoder();
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== CENTRAL) throw new ZipError('Répertoire du zip endommagé.');
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localOffset = cd.getUint32(p + 42, true);
    const path = utf8.decode(new Uint8Array(cd.buffer, p + 46, nameLen)).normalize('NFC');

    // Zip64 extra field holds the real values of any field set to 0xFFFFFFFF.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
      }
      e += 4 + len;
    }
    p = extraEnd + commentLen;

    if (path.endsWith('/')) continue; // folder
    const name = path.split('/').pop();
    entries.push({
      path,
      name,
      size,
      type: '',
      encrypted: !!(flags & 1),
      arrayBuffer: () => extract(blob, { path, flags, method, compSize, localOffset }),
    });
  }
  return entries;
}

async function extract(blob, { path, flags, method, compSize, localOffset }) {
  if (flags & 1) throw new ZipError(`${path} est protégé par mot de passe.`);
  const local = await view(blob, localOffset, localOffset + 30);
  if (local.getUint32(0, true) !== LOCAL) throw new ZipError(`Entrée du zip endommagée : ${path}`);
  const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const data = blob.slice(start, start + compSize);
  if (method === 0) return data.arrayBuffer();
  if (method === 8) return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  throw new ZipError(`${path} utilise une méthode de compression non prise en charge (${method}).`);
}
