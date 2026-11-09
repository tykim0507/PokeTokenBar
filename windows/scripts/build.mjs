import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
await build({
  entryPoints: ["src/renderer.ts"],
  bundle: true,
  platform: "browser",
  target: "chrome140",
  outfile: "dist/src/renderer.js",
});
for (const file of ["index.html", "styles.css"])
  await copyFile(`src/${file}`, `dist/src/${file}`);
// Original geometric egg icon. No Pokémon artwork or data is bundled.
const size = 64,
  pixels = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const p = y * (size * 4 + 1) + 1 + x * 4;
    const inside = ((x - 32) / (17 + y / 16)) ** 2 + ((y - 33) / 27) ** 2 < 1;
    const spot =
      (x - 26) ** 2 + (y - 25) ** 2 < 28 || (x - 39) ** 2 + (y - 43) ** 2 < 40;
    pixels.set(
      inside
        ? spot
          ? [84, 130, 96, 255]
          : [244, 230, 185, 255]
        : [0, 0, 0, 0],
      p,
    );
  }
function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) {
    n ^= b;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0)),
]);
await mkdir("resources", { recursive: true });
await writeFile("resources/icon.png", png);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = size;
ico[7] = size;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await writeFile("resources/icon.ico", Buffer.concat([ico, png]));
