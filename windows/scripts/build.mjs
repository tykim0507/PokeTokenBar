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
function makePng(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = y * (size * 4 + 1) + 1 + x * 4;
      const px = (x * 64) / size,
        py = (y * 64) / size;
      const inside =
        ((px - 32) / (17 + py / 16)) ** 2 + ((py - 33) / 27) ** 2 < 1;
      const spot =
        (px - 26) ** 2 + (py - 25) ** 2 < 28 ||
        (px - 39) ** 2 + (py - 43) ** 2 < 40;
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
  return png;
}
const sizes = [16, 32, 48, 256];
const images = sizes.map(makePng);
await mkdir("resources", { recursive: true });
await writeFile("resources/icon.png", images[3]);
const ico = Buffer.alloc(6 + 16 * sizes.length);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(sizes.length, 4);
let offset = ico.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  ico[entry] = size === 256 ? 0 : size;
  ico[entry + 1] = size === 256 ? 0 : size;
  ico.writeUInt16LE(1, entry + 4);
  ico.writeUInt16LE(32, entry + 6);
  ico.writeUInt32LE(images[index].length, entry + 8);
  ico.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await writeFile("resources/icon.ico", Buffer.concat([ico, ...images]));
