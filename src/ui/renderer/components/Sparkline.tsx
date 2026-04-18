export function Sparkline({ points, width = 260, height = 48 }: { points: number[]; width?: number; height?: number }) {
  if (points.length === 0) return <div className="text-xs text-muted-foreground">데이터 없음</div>;
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const path = points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(height - (v / max) * (height - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} className="block">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-primary" />
    </svg>
  );
}
