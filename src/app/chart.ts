/**
 * P17-3 — small SVG box plot for batch distributions.
 *
 * Renders a horizontal box plot of a single numeric vector.
 * Layout (pure SVG, no external library):
 *
 *   |min──whisker──[Q1 ──box── Q3]──whisker──max|
 *
 * Outliers (points below `Q1 - 1.5 * IQR` or above
 * `Q3 + 1.5 * IQR`) are drawn as small dots to the right of
 * the box. The function is intentionally tiny — the only
 * dependency is on the DOM `SVGElement` API.
 *
 * The factory injection (`createElementNS` + `svgNS`) keeps the
 * function testable from Node: tests pass in a fake factory.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

export type CreateSvgElement = (name: string) => SVGElement;

export const defaultCreateElementNS: CreateSvgElement = (name) => {
  // In a browser this returns a real SVG element. In Node / tests
  // it throws — callers should inject a factory.
  if (typeof document === 'undefined') {
    throw new Error('renderBoxPlot: no document — pass createElementNS in the options');
  }
  return document.createElementNS(SVG_NS, name) as unknown as SVGElement;
};

export interface BoxPlotOptions {
  /** SVG width in CSS pixels. Default 240. */
  width?: number;
  /** SVG height in CSS pixels. Default 60. */
  height?: number;
  /** Optional formatter for the axis labels. */
  format?: (n: number) => string;
  /** Optional title shown to the right of the box. */
  label?: string;
  /** Inject for tests: factory that creates a typed SVG element
   *  with the given tag name. */
  createElementNS?: CreateSvgElement;
}

export function renderBoxPlot(svg: SVGElement, data: number[], options: BoxPlotOptions = {}): void {
  const width = options.width ?? 240;
  const height = options.height ?? 60;
  const fmt = options.format ?? ((n) => n.toLocaleString('zh-CN', { maximumFractionDigits: 1 }));
  const create = options.createElementNS ?? defaultCreateElementNS;
  // Clear existing children.
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  if (data.length === 0) {
    const text = create('text');
    text.setAttribute('x', String(width / 2));
    text.setAttribute('y', String(height / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', '#6c8294');
    text.setAttribute('font-size', '11');
    text.textContent = '— 无数据 —';
    svg.appendChild(text);
    return;
  }
  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  const quantileFn = (p: number) => quantile(sorted, p);
  const q1 = quantileFn(0.25);
  const med = quantileFn(0.5);
  const q3 = quantileFn(0.75);
  const iqr = q3 - q1;
  const lo = Math.max(min, q1 - 1.5 * iqr);
  const hi = Math.min(max, q3 + 1.5 * iqr);
  const outliers = sorted.filter(v => v < lo || v > hi);
  // Map value to x. Guard against zero range.
  const range = max - min;
  const x = (v: number) => range === 0 ? width / 2 : ((v - min) / range) * (width - 24) + 12;
  // Box geometry.
  const cy = height / 2;
  const boxH = 18;
  const boxY = cy - boxH / 2;
  // Whisker line (left).
  const whiskerL = create('line');
  whiskerL.setAttribute('x1', String(x(lo)));
  whiskerL.setAttribute('x2', String(x(q1)));
  whiskerL.setAttribute('y1', String(cy));
  whiskerL.setAttribute('y2', String(cy));
  whiskerL.setAttribute('stroke', '#7eb3ad');
  whiskerL.setAttribute('stroke-width', '1');
  svg.appendChild(whiskerL);
  // Whisker line (right).
  const whiskerR = create('line');
  whiskerR.setAttribute('x1', String(x(q3)));
  whiskerR.setAttribute('x2', String(x(hi)));
  whiskerR.setAttribute('y1', String(cy));
  whiskerR.setAttribute('y2', String(cy));
  whiskerR.setAttribute('stroke', '#7eb3ad');
  whiskerR.setAttribute('stroke-width', '1');
  svg.appendChild(whiskerR);
  // Whisker caps.
  for (const cap of [x(lo), x(hi)]) {
    const line = create('line');
    line.setAttribute('x1', String(cap));
    line.setAttribute('x2', String(cap));
    line.setAttribute('y1', String(cy - 6));
    line.setAttribute('y2', String(cy + 6));
    line.setAttribute('stroke', '#7eb3ad');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }
  // Box.
  const box = create('rect');
  box.setAttribute('x', String(x(q1)));
  box.setAttribute('y', String(boxY));
  box.setAttribute('width', String(Math.max(0, x(q3) - x(q1))));
  box.setAttribute('height', String(boxH));
  box.setAttribute('fill', '#1f2f40');
  box.setAttribute('stroke', '#b3e9db');
  box.setAttribute('stroke-width', '1');
  box.setAttribute('rx', '2');
  svg.appendChild(box);
  // Median.
  const medLine = create('line');
  medLine.setAttribute('x1', String(x(med)));
  medLine.setAttribute('x2', String(x(med)));
  medLine.setAttribute('y1', String(boxY));
  medLine.setAttribute('y2', String(boxY + boxH));
  medLine.setAttribute('stroke', '#9be3b1');
  medLine.setAttribute('stroke-width', '2');
  svg.appendChild(medLine);
  // Outliers.
  for (const o of outliers) {
    const c = create('circle');
    c.setAttribute('cx', String(x(o)));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', '2');
    c.setAttribute('fill', '#c97a7a');
    svg.appendChild(c);
  }
  // Min / max labels.
  const minLabel = create('text');
  minLabel.setAttribute('x', '0');
  minLabel.setAttribute('y', String(height - 2));
  minLabel.setAttribute('fill', '#6c8294');
  minLabel.setAttribute('font-size', '9');
  minLabel.textContent = fmt(min);
  svg.appendChild(minLabel);
  const maxLabel = create('text');
  maxLabel.setAttribute('x', String(width));
  maxLabel.setAttribute('y', String(height - 2));
  maxLabel.setAttribute('text-anchor', 'end');
  maxLabel.setAttribute('fill', '#6c8294');
  maxLabel.setAttribute('font-size', '9');
  maxLabel.textContent = fmt(max);
  svg.appendChild(maxLabel);
}

function quantile(sortedXs: number[], p: number): number {
  const n = sortedXs.length;
  if (n === 0) return 0;
  if (n === 1) return sortedXs[0]!;
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedXs[lo]!;
  const t = pos - lo;
  return sortedXs[lo]! + t * (sortedXs[hi]! - sortedXs[lo]!);
}
