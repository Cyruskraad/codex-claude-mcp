#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import process from 'node:process';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= diagonalDistance ? left : aboveDistance <= diagonalDistance ? above : upperLeft;
}

function decodePng(bytes, label) {
  assert(bytes.subarray(0, 8).equals(SIGNATURE), `${label} is not a PNG.`);
  let offset = 8;
  let width;
  let height;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert(offset + 12 + length <= bytes.length, `${label} contains a truncated PNG chunk.`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert(data[8] === 8 && data[9] === 6 && data[10] === 0 && data[11] === 0 && data[12] === 0, `${label} must be an 8-bit non-interlaced RGBA PNG.`);
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  assert(Number.isInteger(width) && Number.isInteger(height) && compressed.length > 0, `${label} has an incomplete PNG structure.`);
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(compressed));
  assert(raw.length === (stride + 1) * height, `${label} has an unexpected image payload.`);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4, `${label} uses an unsupported PNG filter.`);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

function luminance(red, green, blue) {
  const channels = [red, green, blue].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(pixel, background) {
  const alpha = pixel[3] / 255;
  const composite = pixel.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
  const left = luminance(...composite);
  const right = luminance(...background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function validateImage(image, label, expectedSize, background) {
  assert(image.width === expectedSize && image.height === expectedSize, `${label} must be ${expectedSize}x${expectedSize}.`);
  let transparent = 0;
  let visible = 0;
  let contrastPixels = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const pixel = [...image.pixels.subarray(index, index + 4)];
    if (pixel[3] === 0) transparent += 1;
    if (pixel[3] >= 96) {
      visible += 1;
      if (contrast(pixel, background) >= 2.2) contrastPixels += 1;
    }
  }
  const total = image.width * image.height;
  assert(transparent / total >= 0.1, `${label} must retain a materially transparent background.`);
  assert(visible / total >= 0.05, `${label} has too little visible artwork.`);
  assert(contrastPixels / visible >= 0.2, `${label} lacks sufficient contrast on its intended background.`);

  for (const size of [16, 32, 128]) {
    let occupied = 0;
    let violet = 0;
    let cyan = 0;
    for (let targetY = 0; targetY < size; targetY += 1) {
      for (let targetX = 0; targetX < size; targetX += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor((targetX + 0.5) * image.width / size));
        const sourceY = Math.min(image.height - 1, Math.floor((targetY + 0.5) * image.height / size));
        const index = (sourceY * image.width + sourceX) * 4;
        const [red, green, blue, alpha] = image.pixels.subarray(index, index + 4);
        if (alpha >= 96) {
          occupied += 1;
          if (blue >= 90 && red >= 70 && blue + red > green * 1.35) violet += 1;
          if (blue >= 90 && green >= 90 && blue + green > red * 1.35) cyan += 1;
        }
      }
    }
    assert(occupied >= size * size * 0.04, `${label} becomes unreadable at ${size}px.`);
    assert(violet > 0 && cyan > 0, `${label} loses its violet/cyan bridge identity at ${size}px.`);
  }
}

async function main() {
  const assets = resolve(option('--assets', resolve(import.meta.dirname, '../plugins/codex-claude-mcp/assets')));
  try {
    const logo = decodePng(await readFile(join(assets, 'logo.png')), 'logo.png');
    const dark = decodePng(await readFile(join(assets, 'logo-dark.png')), 'logo-dark.png');
    const composer = decodePng(await readFile(join(assets, 'composer-icon.png')), 'composer-icon.png');
    validateImage(logo, 'logo.png', 512, [255, 255, 255]);
    validateImage(dark, 'logo-dark.png', 512, [17, 17, 17]);
    validateImage(composer, 'composer-icon.png', 128, [255, 255, 255]);
    process.stdout.write('Plugin icon assets valid at 16, 32, and 128 px.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Asset validation failed.'}\n`);
    process.exitCode = 1;
  }
}

await main();
