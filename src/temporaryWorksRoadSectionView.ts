type RoadSectionInputs = {
  width: number;
  hardeningDepth: number;
  treatmentDepth: number;
  slopeHeight: number;
  slopeWidth: number;
};

const dimension = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3, useGrouping: false });

/** Display the designed layers before the survey is sampled. Values are in the road's transverse plane. */
export function renderRoadSectionPreview(host: HTMLElement, section: RoadSectionInputs): void {
  const { width, hardeningDepth, treatmentDepth, slopeHeight, slopeWidth } = section;
  const depth = hardeningDepth + treatmentDepth, ratio = slopeWidth / slopeHeight;
  const mid = width + 2 * hardeningDepth * ratio, base = width + 2 * depth * ratio;
  if (![width, hardeningDepth, treatmentDepth, slopeHeight, slopeWidth, mid, base].every(Number.isFinite)
    || width <= 0 || hardeningDepth < 0 || treatmentDepth < 0 || slopeHeight <= 0 || slopeWidth < 0) {
    host.replaceChildren();
    return;
  }
  const sx = 250 / base;
  // Keep thin layers legible in a narrow panel. Written dimensions always use design metres.
  const sy = depth > 0 ? Math.min(56 / depth, Math.max(sx, 24 / depth)) : sx;
  const left = (w: number) => 145 - w * sx / 2;
  const right = (w: number) => 145 + w * sx / 2;
  const band = (upper: number, lower: number, y1: number, y2: number, fill: string) => y2 > y1
    ? `<polygon points="${left(upper)},${y1} ${right(upper)},${y1} ${right(lower)},${y2} ${left(lower)},${y2}" fill="${fill}" stroke="#c3d6dd" stroke-width="1"/>` : '';
  const yTop = 19, yMid = yTop + hardeningDepth * sy, yBottom = yTop + depth * sy;
  const n = (x: number) => dimension.format(x);
  const hint = `路面 ${n(width)} m，硬化底 ${n(mid)} m，处理底 ${n(base)} m`;
  host.innerHTML = `<figure style="margin:0;padding:7px 6px;border:1px solid #345064;border-radius:6px;background:#0b1926">
    <svg viewBox="0 0 290 ${yBottom + 24}" role="img" aria-label="${hint}" style="display:block;width:100%;max-height:128px;font:11px sans-serif" text-anchor="middle">
      <text x="145" y="12" fill="#d4ebe9">路面宽 ${n(width)} m</text>
      ${band(width, mid, yTop, yMid, '#679399')}${band(mid, base, yMid, yBottom, '#92734f')}
      <path d="M${left(width)} ${yTop}H${right(width)}" stroke="#8aede2" stroke-width="2"/>
      <path d="M${left(base)} ${yBottom + 3}v6m0 -3H${right(base)}m0 -3v6" fill="none" stroke="#9eacbd"/>
      <text x="145" y="${yBottom + 21}" fill="#dce6ef">处理底宽 ${n(base)} m</text>
    </svg>
    <figcaption style="font-size:11px;color:#acbfcd">硬化层厚 ${n(hardeningDepth)} m · 硬化底宽 ${n(mid)} m<br>地基处理深 ${n(treatmentDepth)} m · 边坡高宽比 ${n(slopeHeight)}∶${n(slopeWidth)}</figcaption>
  </figure>`;
}
