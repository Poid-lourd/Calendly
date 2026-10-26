import { inflateSync } from "node:zlib";

// Conversion WOFF 1.0 vers SFNT (TrueType/OpenType), selon la spécification W3C WOFF.
// Le moteur de rendu des images ne lit que les polices SFNT ; les fichiers WOFF de la police du site sont convertis en mémoire.
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.length < 44 || woff.toString("latin1", 0, 4) !== "wOFF") throw new Error("Fichier WOFF invalide");
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);

  const tables: { tag: number; checksum: number; data: Buffer }[] = [];
  for (let i = 0; i < numTables; i++) {
    const entry = 44 + i * 20;
    const tag = woff.readUInt32BE(entry);
    const offset = woff.readUInt32BE(entry + 4);
    const compLength = woff.readUInt32BE(entry + 8);
    const origLength = woff.readUInt32BE(entry + 12);
    const checksum = woff.readUInt32BE(entry + 16);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(raw) : Buffer.from(raw);
    if (data.length !== origLength) throw new Error("Table WOFF de taille inattendue");
    tables.push({ tag, checksum, data });
  }

  let maxPow2 = 1;
  while (maxPow2 * 2 <= numTables) maxPow2 *= 2;
  const searchRange = maxPow2 * 16;
  const entrySelector = Math.log2(maxPow2);
  const rangeShift = numTables * 16 - searchRange;

  const headerSize = 12 + numTables * 16;
  const padded = (n: number) => (n + 3) & ~3;
  const total = tables.reduce((sum, t) => sum + padded(t.data.length), headerSize);
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(rangeShift, 10);

  let offset = headerSize;
  tables.forEach((t, i) => {
    const record = 12 + i * 16;
    out.writeUInt32BE(t.tag, record);
    out.writeUInt32BE(t.checksum, record + 4);
    out.writeUInt32BE(offset, record + 8);
    out.writeUInt32BE(t.data.length, record + 12);
    t.data.copy(out, offset);
    offset += padded(t.data.length);
  });
  return out;
}
