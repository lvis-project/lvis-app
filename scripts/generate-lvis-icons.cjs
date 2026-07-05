const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { deflateSync } = require("node:zlib");

const root = resolve(__dirname, "..");
const buildDir = join(root, "build");
const logoSourcePath = join(root, "src", "shared", "lvis-logo.ts");

const TARGET_SIZE = 1024;
const SUPERSAMPLE = 2;
const ICON_CARD_INSET = 64;
const ICON_CARD_RADIUS = 192;
const LOGO_SAFE_PADDING = 192;
const ICON_BACKGROUND = [255, 255, 255, 255];
const TRAY_ICON_BASE_SIZE = 18;
const TRAY_ICON_SCALE_FACTORS = [1, 2];
const TRAY_ICON_PADDING_RATIO = 0.12;
const TRAY_ICON_STROKE_RATIO = 0.028;
const WINDOWS_ICO_SIZES = [16, 32, 64, 128, 256];
const GRADIENT_STOPS = [
  { at: 0, color: [255, 75, 46] },
  { at: 0.56, color: [255, 63, 110] },
  { at: 1, color: [217, 70, 239] },
];

function readLogoConst(source, name) {
  const match = source.match(new RegExp(`export const ${name} =\\s*"([\\s\\S]*?)";`));
  if (!match) {
    throw new Error(`Unable to find ${name} in ${logoSourcePath}`);
  }
  return match[1];
}

function iconGeometry(viewBox, targetSize = TARGET_SIZE, safePadding = LOGO_SAFE_PADDING) {
  const [, , logoWidthText, logoHeightText] = viewBox.split(/\s+/);
  const logoWidth = Number(logoWidthText);
  const logoHeight = Number(logoHeightText);
  const scale = (targetSize - safePadding * 2) / Math.max(logoWidth, logoHeight);
  const x = (targetSize - logoWidth * scale) / 2;
  const y = (targetSize - logoHeight * scale) / 2;
  return { logoWidth, logoHeight, x, y, scale };
}

function buildIconSvg(logoPath, geometry) {
  const { logoWidth, logoHeight, x, y, scale } = geometry;
  const cardSize = TARGET_SIZE - ICON_CARD_INSET * 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${TARGET_SIZE}" height="${TARGET_SIZE}" viewBox="0 0 ${TARGET_SIZE} ${TARGET_SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="lvis-icon-mark" x1="${x}" y1="${y}" x2="${x + logoWidth * scale}" y2="${y + logoHeight * scale}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff4b2e"/>
      <stop offset="0.56" stop-color="#ff3f6e"/>
      <stop offset="1" stop-color="#d946ef"/>
    </linearGradient>
  </defs>
  <rect x="${ICON_CARD_INSET}" y="${ICON_CARD_INSET}" width="${cardSize}" height="${cardSize}" rx="${ICON_CARD_RADIUS}" fill="#ffffff"/>
  <path d="${logoPath}" fill="url(#lvis-icon-mark)" transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(6)})"/>
</svg>
`;
}

function tokenizePath(pathData) {
  return pathData.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) ?? [];
}

function isCommand(token) {
  return /^[a-zA-Z]$/.test(token);
}

function cubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return (
    mt * mt * mt * p0 +
    3 * mt * mt * t * p1 +
    3 * mt * t * t * p2 +
    t * t * t * p3
  );
}

function parsePath(pathData) {
  const tokens = tokenizePath(pathData);
  const subpaths = [];
  let i = 0;
  let command = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let current = null;

  const readNumber = () => {
    const token = tokens[i++];
    if (token === undefined || isCommand(token)) {
      throw new Error(`Invalid LVIS logo path near token ${i}`);
    }
    return Number(token);
  };

  const hasMoreNumbers = () => i < tokens.length && !isCommand(tokens[i]);

  const beginSubpath = (nextX, nextY) => {
    current = [{ x: nextX, y: nextY }];
    subpaths.push(current);
    x = nextX;
    y = nextY;
    startX = nextX;
    startY = nextY;
  };

  const lineTo = (nextX, nextY) => {
    if (!current) beginSubpath(x, y);
    current.push({ x: nextX, y: nextY });
    x = nextX;
    y = nextY;
  };

  const cubicTo = (x1, y1, x2, y2, x3, y3) => {
    if (!current) beginSubpath(x, y);
    const estimatedLength =
      Math.hypot(x1 - x, y1 - y) +
      Math.hypot(x2 - x1, y2 - y1) +
      Math.hypot(x3 - x2, y3 - y2);
    const steps = Math.max(12, Math.ceil(estimatedLength / 8));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      current.push({
        x: cubicPoint(x, x1, x2, x3, t),
        y: cubicPoint(y, y1, y2, y3, t),
      });
    }
    x = x3;
    y = y3;
  };

  while (i < tokens.length) {
    if (isCommand(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase();
    const op = command.toUpperCase();

    if (op === "M") {
      const nextX = readNumber();
      const nextY = readNumber();
      beginSubpath(relative ? x + nextX : nextX, relative ? y + nextY : nextY);
      command = relative ? "l" : "L";
      while (hasMoreNumbers()) {
        const lineX = readNumber();
        const lineY = readNumber();
        lineTo(relative ? x + lineX : lineX, relative ? y + lineY : lineY);
      }
      continue;
    }

    if (op === "L") {
      while (hasMoreNumbers()) {
        const nextX = readNumber();
        const nextY = readNumber();
        lineTo(relative ? x + nextX : nextX, relative ? y + nextY : nextY);
      }
      continue;
    }

    if (op === "H") {
      while (hasMoreNumbers()) {
        const nextX = readNumber();
        lineTo(relative ? x + nextX : nextX, y);
      }
      continue;
    }

    if (op === "V") {
      while (hasMoreNumbers()) {
        const nextY = readNumber();
        lineTo(x, relative ? y + nextY : nextY);
      }
      continue;
    }

    if (op === "C") {
      while (hasMoreNumbers()) {
        const x1 = readNumber();
        const y1 = readNumber();
        const x2 = readNumber();
        const y2 = readNumber();
        const x3 = readNumber();
        const y3 = readNumber();
        cubicTo(
          relative ? x + x1 : x1,
          relative ? y + y1 : y1,
          relative ? x + x2 : x2,
          relative ? y + y2 : y2,
          relative ? x + x3 : x3,
          relative ? y + y3 : y3,
        );
      }
      continue;
    }

    if (op === "Z") {
      lineTo(startX, startY);
      current = null;
      continue;
    }

    throw new Error(`Unsupported LVIS logo path command: ${command}`);
  }

  return subpaths;
}

function transformedEdges(subpaths, geometry, factor) {
  const transformPoint = (point) => ({
    x: (geometry.x + point.x * geometry.scale) * factor,
    y: (geometry.y + point.y * geometry.scale) * factor,
  });
  const edges = [];
  for (const subpath of subpaths) {
    for (let index = 1; index < subpath.length; index += 1) {
      const p1 = transformPoint(subpath[index - 1]);
      const p2 = transformPoint(subpath[index]);
      if (Math.abs(p1.y - p2.y) < 0.0001) continue;
      edges.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    }
  }
  return edges;
}

function isInsideRoundedRect(x, y, left, top, width, height, radius) {
  const px = x + 0.5;
  const py = y + 0.5;
  const right = left + width;
  const bottom = top + height;
  if (px < left || px > right || py < top || py > bottom) return false;
  const minX = left + radius;
  const maxX = right - radius;
  const minY = top + radius;
  const maxY = bottom - radius;
  const dx = px < minX ? px - minX : px > maxX ? px - maxX : 0;
  const dy = py < minY ? py - minY : py > maxY ? py - maxY : 0;
  return dx * dx + dy * dy <= radius * radius;
}

function colorAt(x, y, geometry, factor) {
  const startX = geometry.x * factor;
  const startY = geometry.y * factor;
  const endX = (geometry.x + geometry.logoWidth * geometry.scale) * factor;
  const endY = (geometry.y + geometry.logoHeight * geometry.scale) * factor;
  const vx = endX - startX;
  const vy = endY - startY;
  const t = Math.max(0, Math.min(1, ((x - startX) * vx + (y - startY) * vy) / (vx * vx + vy * vy)));
  const nextIndex = GRADIENT_STOPS.findIndex((stop) => stop.at >= t);
  const end = GRADIENT_STOPS[nextIndex === -1 ? GRADIENT_STOPS.length - 1 : nextIndex];
  const start = GRADIENT_STOPS[Math.max(0, (nextIndex === -1 ? GRADIENT_STOPS.length - 1 : nextIndex) - 1)];
  const localT = end.at === start.at ? 0 : (t - start.at) / (end.at - start.at);
  return start.color.map((channel, index) => Math.round(channel + (end.color[index] - channel) * localT));
}

function setPixel(buffer, size, x, y, color) {
  const offset = (y * size + x) * 4;
  buffer[offset] = color[0];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[2];
  buffer[offset + 3] = color[3];
}

function rasterizeIcon(logoPath, geometry) {
  const factor = SUPERSAMPLE;
  const size = TARGET_SIZE * factor;
  const cardInset = ICON_CARD_INSET * factor;
  const cardSize = (TARGET_SIZE - ICON_CARD_INSET * 2) * factor;
  const radius = ICON_CARD_RADIUS * factor;
  const buffer = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isInsideRoundedRect(x, y, cardInset, cardInset, cardSize, cardSize, radius)) {
        setPixel(buffer, size, x, y, ICON_BACKGROUND);
      }
    }
  }

  const edges = transformedEdges(parsePath(logoPath), geometry, factor);
  for (let y = 0; y < size; y += 1) {
    const scanY = y + 0.5;
    const crossings = [];
    for (const edge of edges) {
      if ((edge.y1 <= scanY && edge.y2 > scanY) || (edge.y2 <= scanY && edge.y1 > scanY)) {
        const ratio = (scanY - edge.y1) / (edge.y2 - edge.y1);
        crossings.push({
          x: edge.x1 + ratio * (edge.x2 - edge.x1),
          winding: edge.y2 > edge.y1 ? 1 : -1,
        });
      }
    }
    crossings.sort((a, b) => a.x - b.x);

    let winding = 0;
    let spanStart = null;
    for (const crossing of crossings) {
      const previousWinding = winding;
      winding += crossing.winding;
      if (previousWinding === 0 && winding !== 0) {
        spanStart = crossing.x;
      } else if (previousWinding !== 0 && winding === 0 && spanStart !== null) {
        const from = Math.max(0, Math.ceil(spanStart));
        const to = Math.min(size - 1, Math.floor(crossing.x));
        for (let x = from; x <= to; x += 1) {
          setPixel(buffer, size, x, y, [...colorAt(x + 0.5, scanY, geometry, factor), 255]);
        }
        spanStart = null;
      }
    }
  }

  return downsample(buffer, size, factor);
}

function downsample(source, sourceSize, factor, targetSize = TARGET_SIZE, solidColor = null) {
  const target = Buffer.alloc(targetSize * targetSize * 4);
  const samples = factor * factor;
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const sourceOffset = ((y * factor + sy) * sourceSize + (x * factor + sx)) * 4;
          totals[0] += source[sourceOffset];
          totals[1] += source[sourceOffset + 1];
          totals[2] += source[sourceOffset + 2];
          totals[3] += source[sourceOffset + 3];
        }
      }
      const alpha = Math.round(totals[3] / samples);
      const targetOffset = (y * targetSize + x) * 4;
      if (solidColor && alpha > 0) {
        target[targetOffset] = solidColor[0];
        target[targetOffset + 1] = solidColor[1];
        target[targetOffset + 2] = solidColor[2];
      } else {
        target[targetOffset] = Math.round(totals[0] / samples);
        target[targetOffset + 1] = Math.round(totals[1] / samples);
        target[targetOffset + 2] = Math.round(totals[2] / samples);
      }
      target[targetOffset + 3] = alpha;
    }
  }
  return target;
}

function distanceSquaredToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSquared));
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function rasterizeTrayLineIcon(logoPath, viewBox, targetSize, color) {
  const factor = 4;
  const sourceSize = targetSize * factor;
  const padding = targetSize * TRAY_ICON_PADDING_RATIO;
  const geometry = iconGeometry(viewBox, targetSize, padding);
  const strokeWidth = Math.max(0.5, targetSize * TRAY_ICON_STROKE_RATIO) * factor;
  const radiusSquared = (strokeWidth / 2) * (strokeWidth / 2);
  const buffer = Buffer.alloc(sourceSize * sourceSize * 4);
  const transformPoint = (point) => ({
    x: (geometry.x + point.x * geometry.scale) * factor,
    y: (geometry.y + point.y * geometry.scale) * factor,
  });
  const segments = [];

  for (const subpath of parsePath(logoPath)) {
    for (let index = 1; index < subpath.length; index += 1) {
      const from = transformPoint(subpath[index - 1]);
      const to = transformPoint(subpath[index]);
      segments.push({ from, to });
    }
  }

  for (let y = 0; y < sourceSize; y += 1) {
    for (let x = 0; x < sourceSize; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let insideStroke = false;
      for (const segment of segments) {
        if (distanceSquaredToSegment(px, py, segment.from.x, segment.from.y, segment.to.x, segment.to.y) <= radiusSquared) {
          insideStroke = true;
          break;
        }
      }
      if (insideStroke) {
        setPixel(buffer, sourceSize, x, y, color);
      }
    }
  }

  return downsample(buffer, sourceSize, factor, targetSize, color.slice(0, 3));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    rgba.copy(raw, rowOffset + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND"),
  ]);
}

function encodeIco(sourceRgba, sourceSize, sizes) {
  const images = sizes.map((size) => {
    if (sourceSize % size !== 0) {
      throw new Error(`ICO size ${size} must divide source size ${sourceSize}`);
    }
    return {
      size,
      png: encodePng(size, size, downsample(sourceRgba, sourceSize, sourceSize / size, size)),
    };
  });

  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = headerSize;
  images.forEach((image, index) => {
    const entryOffset = 6 + index * 16;
    header[entryOffset] = image.size === 256 ? 0 : image.size;
    header[entryOffset + 1] = image.size === 256 ? 0 : image.size;
    header[entryOffset + 2] = 0;
    header[entryOffset + 3] = 0;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.png.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.png.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

function main() {
  mkdirSync(buildDir, { recursive: true });

  const source = readFileSync(logoSourcePath, "utf8");
  const logoPath = readLogoConst(source, "LVIS_LOGO_PATH");
  const viewBox = readLogoConst(source, "LVIS_LOGO_VIEW_BOX");
  const geometry = iconGeometry(viewBox);
  const svgPath = join(buildDir, "icon.svg");
  const pngPath = join(buildDir, "icon.png");
  const installerIconPath = join(buildDir, "installerIcon.ico");
  const installerHeaderIconPath = join(buildDir, "installerHeaderIcon.ico");
  const iconRgba = rasterizeIcon(logoPath, geometry);
  const installerIco = encodeIco(iconRgba, TARGET_SIZE, WINDOWS_ICO_SIZES);
  writeFileSync(svgPath, buildIconSvg(logoPath, geometry));
  writeFileSync(pngPath, encodePng(TARGET_SIZE, TARGET_SIZE, iconRgba));
  writeFileSync(installerIconPath, installerIco);
  writeFileSync(installerHeaderIconPath, installerIco);
  for (const scaleFactor of TRAY_ICON_SCALE_FACTORS) {
    const targetSize = TRAY_ICON_BASE_SIZE * scaleFactor;
    const suffix = scaleFactor === 1 ? "" : "@2x";
    writeFileSync(
      join(buildDir, `tray-icon${suffix}.png`),
      encodePng(targetSize, targetSize, rasterizeTrayLineIcon(logoPath, viewBox, targetSize, [255, 255, 255, 255])),
    );
    writeFileSync(
      join(buildDir, `tray-iconTemplate${suffix}.png`),
      encodePng(targetSize, targetSize, rasterizeTrayLineIcon(logoPath, viewBox, targetSize, [0, 0, 0, 255])),
    );
  }

  console.log(`Generated ${svgPath}`);
  console.log(`Generated ${pngPath}`);
  console.log(`Generated ${installerIconPath}`);
  console.log(`Generated ${installerHeaderIconPath}`);
  console.log(`Generated ${join(buildDir, "tray-icon.png")}`);
  console.log(`Generated ${join(buildDir, "tray-iconTemplate.png")}`);
}

main();
