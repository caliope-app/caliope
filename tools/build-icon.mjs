// Builds assets/Caliope.ico from web/icon.svg (PNG images inside an ICO container).
// Usage: node tools/build-icon.mjs <path to node_modules/sharp>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sharpPath = process.argv[2];
if (!sharpPath) {
  console.error('Pass the path to node_modules/sharp.');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const sharp = require(sharpPath);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'web', 'icon.svg'));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of sizes) images.push(await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer());

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + 16 * images.length;
images.forEach((image, index) => {
  const size = sizes[index];
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += image.length;
  entries.push(entry);
});
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'Caliope.ico'), Buffer.concat([header, ...entries, ...images]));
fs.writeFileSync(path.join(root, 'web', 'icon-256.png'), images[images.length - 1]);
console.log(`Wrote assets/Caliope.ico (${sizes.join(', ')} px)`);
