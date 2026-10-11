import { safeRectFromInsets } from './adaptive-framing.mjs';

// CSS-pixel layout math, independent of device names or a preferred aspect ratio.
// The selected rectangle protects important content; the canvas still fills the screen.
export function contentRect({ width, height, top = 0, dock = null, padding = 12 }) {
  if (!(width > 0 && height > 0)) return null;
  const candidates = [];
  const add = (right = 0, bottom = 0) => {
    const rect = safeRectFromInsets({ width, height, top, right, bottom, padding });
    if (!rect) return;
    const w = (rect.xMax - rect.xMin) * width / 2;
    const h = (rect.yMax - rect.yMin) * height / 2;
    // Avoid favoring a very thin sliver over a balanced region for a person.
    const shape = Math.min(1, w / 180, h / 180);
    candidates.push({ rect, score: w * h * shape });
  };
  if (dock && dock.width > 0 && dock.height > 0) {
    add(0, Math.max(0, height - dock.top));
    if (dock.left > padding * 2) add(Math.max(0, width - dock.left), 0);
  } else add();
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.rect ?? null;
}

export function visibleViewport({ innerWidth, innerHeight, visualViewport }) {
  const v = visualViewport;
  // Pinch zoom remains browser zoom. Avoid fighting it with layout changes.
  const useVisual = v && (!Number.isFinite(v.scale) || Math.abs(v.scale - 1) < .01);
  return {
    width: Math.max(1, useVisual ? v.width : innerWidth),
    height: Math.max(1, useVisual ? v.height : innerHeight),
    left: useVisual ? v.offsetLeft || 0 : 0,
    top: useVisual ? v.offsetTop || 0 : 0
  };
}
