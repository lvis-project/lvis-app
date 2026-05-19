import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");

interface PngImage {
  width: number;
  height: number;
  rgba: Buffer;
}

function readPng(filePath: string): PngImage {
  const png = readFileSync(filePath);
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(6);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    expect(raw[rowOffset]).toBe(0);
    raw.copy(rgba, y * stride, rowOffset + 1, rowOffset + 1 + stride);
  }
  return { width, height, rgba };
}

function pixel(image: PngImage, x: number, y: number): [number, number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [
    image.rgba[offset],
    image.rgba[offset + 1],
    image.rgba[offset + 2],
    image.rgba[offset + 3],
  ];
}

function visiblePixels(image: PngImage): Array<[number, number, number, number]> {
  const pixels: Array<[number, number, number, number]> = [];
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const px = pixel(image, x, y);
      if (px[3] > 0) pixels.push(px);
    }
  }
  return pixels;
}

describe("app icon assets", () => {
  it("uses a standard transparent canvas with a white rounded app background", () => {
    const svg = readFileSync(join(root, "build", "icon.svg"), "utf8");
    expect(svg).toContain('<rect x="64" y="64" width="896" height="896" rx="192" fill="#ffffff"/>');
    expect(svg).not.toContain('fill="#08111f"');

    const image = readPng(join(root, "build", "icon.png"));
    expect(image.width).toBe(1024);
    expect(image.height).toBe(1024);
    expect(pixel(image, 0, 0)[3]).toBe(0);
    expect(pixel(image, 32, 32)[3]).toBe(0);
    expect(pixel(image, 512, 72)).toEqual([255, 255, 255, 255]);
  });

  it("ships white and macOS template line-art tray icons", () => {
    const white = readPng(join(root, "build", "tray-icon.png"));
    const white2x = readPng(join(root, "build", "tray-icon@2x.png"));
    const template = readPng(join(root, "build", "tray-iconTemplate.png"));
    const template2x = readPng(join(root, "build", "tray-iconTemplate@2x.png"));

    expect([white.width, white.height]).toEqual([18, 18]);
    expect([white2x.width, white2x.height]).toEqual([36, 36]);
    expect([template.width, template.height]).toEqual([18, 18]);
    expect([template2x.width, template2x.height]).toEqual([36, 36]);

    const whiteVisible = visiblePixels(white);
    const templateVisible = visiblePixels(template);
    expect(whiteVisible.length).toBeGreaterThan(24);
    expect(whiteVisible.length).toBeLessThan(white.width * white.height * 0.65);
    expect(templateVisible.length).toBe(whiteVisible.length);
    expect(whiteVisible.every(([r, g, b]) => r === 255 && g === 255 && b === 255)).toBe(true);
    expect(templateVisible.every(([r, g, b]) => r === 0 && g === 0 && b === 0)).toBe(true);
    expect(pixel(white, 0, 0)[3]).toBe(0);
    expect(pixel(template, 0, 0)[3]).toBe(0);
  });
});
