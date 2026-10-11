/**
 * Scratch reference implementation. No DOM, Three.js, or Site mutations.
 * Coordinate convention matches cafe-dialogue-camera's camera-math.js:
 * yaw 0 points along -X, positive yaw follows increasing panorama columns,
 * pitch is latitude, +Y is up. Capture image coordinates use a top-left origin.
 */
export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const normalize = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const finite = x => typeof x === 'number' && Number.isFinite(x);

export function directionAt(yaw, pitch) {
  const y = yaw * RAD, p = pitch * RAD;
  return [-Math.cos(p) * Math.cos(y), Math.sin(p), -Math.cos(p) * Math.sin(y)];
}

export function anglesAt(direction) {
  const d = normalize(direction);
  return { yaw: Math.atan2(-d[2], -d[0]) * DEG, pitch: Math.asin(clamp(d[1], -1, 1)) * DEG };
}

export function cameraBasis(yaw, pitch) {
  const y = yaw * RAD, p = pitch * RAD;
  return {
    forward: directionAt(yaw, pitch),
    right: [Math.sin(y), 0, -Math.cos(y)],
    up: [Math.cos(y) * Math.sin(p), Math.cos(p), Math.sin(y) * Math.sin(p)]
  };
}

export function verticalFromHorizontal(hfov, aspect) {
  return 2 * Math.atan(Math.tan(hfov * RAD / 2) / aspect) * DEG;
}

export function horizontalFromVertical(vfov, aspect) {
  return 2 * Math.atan(Math.tan(vfov * RAD / 2) * aspect) * DEG;
}

/** fy=fx is square pixels. Explicit intrinsics are required after asymmetric outpainting. */
export function captureIntrinsics(capture) {
  const { width, height } = capture;
  if (![width, height].every(finite) || width <= 0 || height <= 0) throw new Error('Capture dimensions are required.');
  const fx = capture.fx ?? width / (2 * Math.tan(capture.hfov * RAD / 2));
  const fy = capture.fy ?? fx;
  const cx = capture.cx ?? width / 2, cy = capture.cy ?? height / 2;
  if (![capture.yaw, capture.pitch, fx, fy, cx, cy].every(finite) || fx <= 0 || fy <= 0) throw new Error('Invalid capture pose or intrinsics.');
  return { width, height, fx, fy, cx, cy };
}

/** The original reference is preserved by uniform resampling and canvas expansion.
 * A generated image that moves landmarks needs registration; this does not fix it.
 */
export function expandCapture(capture, { scale = 1, left = 0, top = 0, width, height }) {
  const k = captureIntrinsics(capture);
  if (![scale, left, top, width, height].every(finite) || scale <= 0 || width <= 0 || height <= 0) throw new Error('Invalid expansion.');
  if (left < 0 || top < 0 || left + k.width * scale > width + 1e-8 || top + k.height * scale > height + 1e-8) throw new Error('The locked reference rectangle must remain inside the expanded image.');
  const expanded = {
    ...capture, width, height,
    fx: k.fx * scale, fy: k.fy * scale,
    cx: left + k.cx * scale, cy: top + k.cy * scale,
    lockedReferenceRect: { x: left, y: top, width: k.width * scale, height: k.height * scale }
  };
  // A single symmetric hfov no longer describes an off-centre principal point.
  delete expanded.hfov;
  return expanded;
}

export function capturePixelToDirection(pixel, capture) {
  const k = captureIntrinsics(capture), b = cameraBasis(capture.yaw, capture.pitch);
  const x = (pixel.x - k.cx) / k.fx, y = (k.cy - pixel.y) / k.fy;
  return normalize(b.forward.map((v, i) => v + x * b.right[i] + y * b.up[i]));
}

export function directionToCaptureUv(direction, capture) {
  const k = captureIntrinsics(capture), b = cameraBasis(capture.yaw, capture.pitch);
  const depth = dot(direction, b.forward);
  if (!(depth > 1e-8)) return null;
  const x = k.cx + k.fx * dot(direction, b.right) / depth;
  const y = k.cy - k.fy * dot(direction, b.up) / depth;
  return { u: x / k.width, v: y / k.height, x, y, depth,
    inside: x >= 0 && x <= k.width && y >= 0 && y <= k.height,
    edgePixels: Math.min(x, k.width - x, y, k.height - y) };
}

/** CPU equivalent of the shader's feather. Confidence masks multiply this alpha. */
export function patchAlpha(direction, capture, featherPixels = 32) {
  const p = directionToCaptureUv(direction, capture);
  return p && p.inside ? (featherPixels > 0 ? smoothstep(0, featherPixels, p.edgePixels) : 1) : 0;
}

/** Panorama UV uses top-left image coordinates. GPU vMapUv has the V axis reversed. */
export function panoramaUvToDirection(u, v) {
  return directionAt((u - 0.5) * 360, (0.5 - v) * 180);
}

export function rayAtNdc(x, y, shot, aspect = shot.aspect) {
  if (!finite(aspect) || aspect <= 0) throw new Error('Actual viewport aspect is required.');
  const b = cameraBasis(shot.yaw, shot.pitch), th = Math.tan(shot.hfov * RAD / 2), tv = th / aspect;
  return normalize(b.forward.map((v, i) => v + x * th * b.right[i] + y * tv * b.up[i]));
}

export function projectDirection(direction, shot, aspect = shot.aspect) {
  if (!finite(aspect) || aspect <= 0) throw new Error('Actual viewport aspect is required.');
  const b = cameraBasis(shot.yaw, shot.pitch), z = dot(direction, b.forward);
  if (z <= 1e-8) return null;
  const th = Math.tan(shot.hfov * RAD / 2);
  return { x: dot(direction, b.right) / (z * th), y: dot(direction, b.up) * aspect / (z * th), depth: z };
}

/** Solve yaw and pitch together, keeping a landmark at an exact NDC (x,y).
 * This extends the current solveYaw, which only targets screen X at a fixed pitch.
 * The regular lookAt branch is used: no camera roll, no movement of camera centre.
 */
export function cameraForAnchor(anchor, hfov, aspect, target = { x: 0, y: 0 }) {
  const th = Math.tan(hfov * RAD / 2), qx = target.x * th, qy = target.y * th / aspect;
  const ratio = Math.hypot(1, qx, qy) * Math.sin(anchor.pitch * RAD) / Math.hypot(1, qy);
  if (!finite(ratio) || Math.abs(ratio) > 1) return null;
  const p = Math.asin(ratio) - Math.atan(qy);
  if (Math.abs(p) >= 89 * RAD) return null;
  const delta = Math.atan2(qx, Math.cos(p) - qy * Math.sin(p));
  return { yaw: anchor.yaw - delta * DEG, pitch: p * DEG, hfov, aspect, vfov: verticalFromHorizontal(hfov, aspect) };
}

/** Exact visible latitude range for a symmetric no-roll rectilinear camera.
 * Evaluates vertical-edge extrema as well as the centre column. The centre-only
 * pitch +/- vfov/2 bound is safe for the current band straddling the equator, but
 * it is not generally correct for arbitrary bands wholly above/below the horizon.
 */
export function viewportLatitudeRange(shot, aspect = shot.aspect) {
  const p = shot.pitch * RAD, th = Math.tan(shot.hfov * RAD / 2), tv = th / aspect;
  const values = [];
  for (const x of [0, -1, 1]) {
    const ys = [-1, 1];
    if (Math.abs(tv * Math.sin(p)) > 1e-12) {
      const criticalY = Math.cos(p) * (1 + x * x * th * th) / (tv * Math.sin(p));
      if (criticalY > -1 && criticalY < 1) ys.push(criticalY);
    }
    for (const y of ys) values.push(Math.asin(clamp(rayAtNdc(x, y, shot, aspect)[1], -1, 1)) * DEG);
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** Angular box samples must come from image-specific calibration, never invented anatomy. */
export function sampleBounds(bounds, divisions = 8) {
  const out = [];
  for (let i = 0; i <= divisions; i++) for (let j = 0; j <= divisions; j++) out.push({
    yaw: bounds.yawMin + (bounds.yawMax - bounds.yawMin) * i / divisions,
    pitch: bounds.pitchMin + (bounds.pitchMax - bounds.pitchMin) * j / divisions
  });
  return out;
}

/** Select the tightest valid lens for an actual required body/waist/head region.
 * This is a reference solver, not a replacement for image calibration or the
 * current otherHeadsSafe/foregroundVisible checks. If impossible, return null.
 * requested size determines REQUIRED POINTS; labels alone never invent a full body.
 */
export function fitRequiredRegion({ anchor, requiredPoints, aspect, target = { x: 0, y: 0 },
  safe = { xMin: -0.92, xMax: 0.92, yMin: -0.92, yMax: 0.92 },
  band = { min: -36, max: 36 }, maxVfov = 62, minHfov = 8, maxHfov = 125,
  pitchMin = -80, pitchMax = 80, step = 0.05 }) {
  if (!requiredPoints?.length || !finite(aspect) || aspect <= 0) return null;
  const directions = requiredPoints.map(q => directionAt(q.yaw, q.pitch));
  const limitH = Math.min(maxHfov, horizontalFromVertical(maxVfov, aspect));
  for (let hfov = minHfov; hfov <= limitH + 1e-10; hfov += step) {
    const shot = cameraForAnchor(anchor, hfov, aspect, target);
    if (!shot || shot.pitch < pitchMin || shot.pitch > pitchMax) continue;
    const latitude = viewportLatitudeRange(shot, aspect);
    if (latitude.min < band.min - 1e-8 || latitude.max > band.max + 1e-8) continue;
    const projected = directions.map(d => projectDirection(d, shot, aspect));
    if (projected.some(p => !p || p.x < safe.xMin || p.x > safe.xMax || p.y < safe.yMin || p.y > safe.yMax)) continue;
    return { ...shot, safe, latitude, projectedBounds: {
      xMin: Math.min(...projected.map(p => p.x)), xMax: Math.max(...projected.map(p => p.x)),
      yMin: Math.min(...projected.map(p => p.y)), yMax: Math.max(...projected.map(p => p.y))
    } };
  }
  return null;
}

/** Signal for the render loop. Fade is independent of the lesson/turn promise.
 * Slow dragging may retain detail. A rapid turn uses the original pano and blur.
 */
export function detailTargetOpacity({ angularSpeed = 0, zoomSpeed = 0, stationChanging = false, decoded = true,
  priority = 1, dwellMs = 300 }) {
  if (!decoded || stationChanging) return 0;
  const rotation = 1 - smoothstep(35, 120, Math.abs(angularSpeed));
  const zoom = 1 - smoothstep(20, 75, Math.abs(zoomSpeed));
  const dwell = smoothstep(50, 180, dwellMs);
  return clamp(priority, 0, 1) * rotation * zoom * dwell;
}

export function stepDetailOpacity(current, target, deltaMs) {
  const timeConstantMs = target > current ? 110 : 35;
  return current + (target - current) * (1 - Math.exp(-Math.max(0, deltaMs) / timeConstantMs));
}
