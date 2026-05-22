export type MultimodalTokenEstimatePart = {
  type: string;
  text?: string;
  image?: string;
  data?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
};

export function estimateMultimodalTokenOverhead(parts: readonly MultimodalTokenEstimatePart[]): number {
  return parts.reduce((sum, part) => {
    if (part.type === "image") return sum + estimateImageTokens(part);
    if (part.type === "file") return sum + estimateDataTokens(part.data);
    return sum;
  }, 0);
}

function estimateImageTokens(part: MultimodalTokenEstimatePart): number {
  const width = saneDimension(part.width) ?? 1024;
  const height = saneDimension(part.height) ?? 1024;
  const tiles = Math.max(1, Math.ceil(width / 512) * Math.ceil(height / 512));
  return 85 + tiles * 170;
}

function estimateDataTokens(data: string | undefined): number {
  if (!data) return 0;
  return Math.ceil(data.length / 4) + 1;
}

function saneDimension(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(8192, Math.ceil(value));
}
