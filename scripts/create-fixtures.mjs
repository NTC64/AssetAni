// Original deterministic test art; no AI, image service, or raster editor required.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
const directory = 'apps/cocos-plugin/test-assets';
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
await mkdir(`${directory}/frames`, { recursive: true });
for (let frame = 0; frame < 8; frame++) {
  const pixels = Buffer.alloc(256 * (1 + 256 * 4));
  function rect(x, y, width, height, color) {
    for (let row = y; row < y + height; row++)
      for (let col = x; col < x + width; col++) {
        const offset = row * 1025 + 1 + col * 4;
        pixels.set([...color, 255], offset);
      }
  }
  const stride = [0, 8, 16, 8, 0, -8, -16, -8][frame];
  const bob = frame % 4 === 1 || frame % 4 === 2 ? -4 : 0;
  rect(104 - stride, 184, 20, 64, [24, 38, 65]);
  rect(132 + stride, 184, 20, 64, [44, 67, 98]);
  rect(100, 104 + bob, 56, 88, [33, 112, 210]);
  rect(104, 60 + bob, 56, 48, [93, 165, 230]);
  rect(140, 80 + bob, 24, 12, [18, 26, 42]);
  rect(150, 80 + bob, 6, 6, [240, 245, 255]);
  rect(144, 120 + bob, 36, 16, [180, 197, 217]);
  rect(176, 92 + bob, 8, 72, [225, 235, 244]);
  // Visible frame index marker on the shield distinguishes all eight poses.
  rect(104 + frame * 4, 132 + bob, 4, 12, [245, 196, 62]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0);
  header.writeUInt32BE(256, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  await writeFile(
    `${directory}/frames/frame_${String(frame).padStart(2, '0')}.png`,
    png,
  );
}
await writeFile(
  `${directory}/manifest.json`,
  JSON.stringify(
    {
      version: 1,
      generationId: '01996aaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      animation: 'walk',
      direction: 'right',
      fps: 12,
      loop: true,
      frameCount: 8,
      frameSize: 256,
      pivot: { x: 0.5, y: 0 },
      frames: Array.from(
        { length: 8 },
        (_, index) => `frames/frame_${String(index).padStart(2, '0')}.png`,
      ),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Wrote eight 256 x 256 transparent PNG fixtures and manifest.json.',
);
