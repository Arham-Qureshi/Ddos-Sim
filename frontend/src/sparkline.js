// sparkline.js — tiny hand-rolled sparkline for the instrument strip. No deps:
// normalizes a numeric series to a thin mono-styled polyline on a 2D context.

export function drawSparkline(ctx, points, { width = 120, height = 32, color = "#38bdf8", stroke = 1 } = {}) {
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (!points || points.length < 2) return;
  const max = Math.max(...points, 1);
  const n = points.length;
  ctx.strokeStyle = color;
  ctx.lineWidth = stroke;
  ctx.beginPath();
  points.forEach((v, i) => {
    const x = 1 + (i / (n - 1)) * (width - 2);
    const y = height - 2 - (Number(v) / max) * (height - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}