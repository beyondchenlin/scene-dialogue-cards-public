/**
 * DOM-free framing for a full-screen panorama with overlay UI.
 *
 * The canvas always renders its real width/height. safeRect is only a composition
 * constraint in full-canvas NDC; it is never a scissor, crop, CSS aspect ratio, or
 * viewport size. Returned yaw/pitch are real no-roll lookAt angles.
 *
 * Copy next to the existing detail-projection.mjs. No renderer changes required.
 */
import {
  RAD, DEG, clamp, dot, directionAt, cameraBasis, cameraForAnchor,
  horizontalFromVertical, verticalFromHorizontal, viewportLatitudeRange
} from './detail-projection.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const EPSILON = 1e-8;
export const DEFAULT_SAFE_RECT = Object.freeze({ xMin: -.94, xMax: .94, yMin: -.94, yMax: .94 });

/** Invalid/fully occluded rectangles remain unavailable; never invent free space. */
export function normalizeSafeRect(rect = DEFAULT_SAFE_RECT) {
  if (!rect || !['xMin', 'xMax', 'yMin', 'yMax'].every(key => finite(rect[key]))) return null;
  const safe = Object.fromEntries(Object.entries(rect).filter(([key]) => ['xMin', 'xMax', 'yMin', 'yMax'].includes(key))
    .map(([key, value]) => [key, clamp(value, -1, 1)]));
  if (safe.xMax - safe.xMin < .02 || safe.yMax - safe.yMin < .02) return null;
  return safe;
}

/**
 * The caller measures actual opaque overlay bounds in CSS pixels. For example,
 * top = header.bottom - canvas.top; bottom = canvas.bottom - dock.top.
 * Side padding is not a new letterbox: the panorama still fills those pixels.
 */
export function safeRectFromInsets({ width, height, top = 0, right = 0, bottom = 0, left = 0, padding = 12 }) {
  if (![width, height, top, right, bottom, left, padding].every(finite)
    || width <= 0 || height <= 0 || [top, right, bottom, left, padding].some(value => value < 0)) return null;
  return normalizeSafeRect({
    xMin: 2 * (left + padding) / width - 1,
    xMax: 1 - 2 * (right + padding) / width,
    yMin: 2 * (bottom + padding) / height - 1,
    yMax: 1 - 2 * (top + padding) / height
  });
}

/** Geometry identity also changes when a dock expands at an unchanged aspect. */
export function safeRectKey(rect) {
  const safe = normalizeSafeRect(rect);
  return safe ? ['xMin', 'xMax', 'yMin', 'yMax'].map(key => safe[key].toFixed(4)).join(',') : 'occluded';
}

/** x/y here are coordinates within the safe region, not the whole screen. */
export function targetInSafeRect(rect, { x = 0, y = 0 } = {}) {
  const safe = normalizeSafeRect(rect);
  if (!safe || ![x, y].every(finite) || Math.abs(x) > 1 || Math.abs(y) > 1) return null;
  return {
    x: (safe.xMin + safe.xMax) / 2 + x * (safe.xMax - safe.xMin) / 2,
    y: (safe.yMin + safe.yMax) / 2 + y * (safe.yMax - safe.yMin) / 2
  };
}

/** Wrap a calibrated angular box onto the branch containing its anchor. */
export function sampleAngularBounds(bounds, anchor, divisions = 8) {
  if (!bounds || !anchor || ![anchor.yaw, anchor.pitch, bounds.yawMin, bounds.yawMax, bounds.pitchMin, bounds.pitchMax].every(finite)
    || !Number.isInteger(divisions) || divisions < 1 || divisions > 64) return [];
  const near = value => anchor.yaw + ((value - anchor.yaw + 180) % 360 + 360) % 360 - 180;
  const ys = [near(bounds.yawMin), near(bounds.yawMax)], yawMin = Math.min(...ys), yawMax = Math.max(...ys);
  if (yawMax <= yawMin || yawMax - yawMin >= 180 || bounds.pitchMin <= -90 || bounds.pitchMax >= 90
    || bounds.pitchMin >= bounds.pitchMax) return [];
  const points = [];
  for (let i = 0; i <= divisions; i++) for (let j = 0; j <= divisions; j++) points.push({
    yaw: yawMin + (yawMax - yawMin) * i / divisions,
    pitch: bounds.pitchMin + (bounds.pitchMax - bounds.pitchMin) * j / divisions
  });
  return points;
}

/**
 * Densely sample a calibrated closed silhouette in the panorama's angular
 * image coordinates. Each consecutive pair and the closing edge are included.
 * Bounds are still required: an outline cannot silently redefine source extent.
 * This samples the supplied contour; correctness of the traced anatomy remains
 * an image-calibration responsibility. No convex hull or bbox corners are added.
 */
export function sampleAngularOutline(outline, anchor, bounds, stepDegrees = .5) {
  if (!Array.isArray(outline) || outline.length < 3 || outline.length > 256 || !anchor || !bounds
    || ![anchor.yaw, anchor.pitch, bounds.yawMin, bounds.yawMax, bounds.pitchMin, bounds.pitchMax, stepDegrees].every(finite)
    || stepDegrees < .1 || stepDegrees > 2 || bounds.pitchMin <= -90 || bounds.pitchMax >= 90
    || bounds.pitchMin >= bounds.pitchMax) return [];
  const near = value => anchor.yaw + ((value - anchor.yaw + 180) % 360 + 360) % 360 - 180;
  const yawEnds = [near(bounds.yawMin), near(bounds.yawMax)], lo = Math.min(...yawEnds), hi = Math.max(...yawEnds);
  if (hi <= lo || hi - lo >= 180) return [];
  const vertices = [];
  for (const point of outline) {
    if (!point || ![point.yaw, point.pitch].every(finite)) return [];
    const p = { yaw: near(point.yaw), pitch: point.pitch };
    if (p.yaw < lo - 1e-6 || p.yaw > hi + 1e-6 || p.pitch < bounds.pitchMin - 1e-6 || p.pitch > bounds.pitchMax + 1e-6) return [];
    const previous = vertices.at(-1);
    if (!previous || Math.hypot(p.yaw - previous.yaw, p.pitch - previous.pitch) > 1e-8) vertices.push(p);
  }
  if (vertices.length > 1 && Math.hypot(vertices[0].yaw - vertices.at(-1).yaw, vertices[0].pitch - vertices.at(-1).pitch) < 1e-8) vertices.pop();
  if (vertices.length < 3) return [];
  let twiceArea = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    twiceArea += a.yaw * b.pitch - b.yaw * a.pitch;
  }
  if (Math.abs(twiceArea) < 1e-5) return [];
  const result = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    const count = Math.max(1, Math.ceil(Math.hypot(b.yaw - a.yaw, b.pitch - a.pitch) / stepDegrees));
    if (result.length + count > 4096) return [];
    for (let j = 0; j < count; j++) result.push({ yaw: a.yaw + (b.yaw - a.yaw) * j / count,
      pitch: a.pitch + (b.pitch - a.pitch) * j / count });
  }
  return result;
}

function boundsOfDirections(directions, shot) {
  const b = cameraBasis(shot.yaw, shot.pitch), tx = Math.tan(shot.hfov * RAD / 2), ty = tx / shot.aspect;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const direction of directions) {
    const depth = dot(direction, b.forward);
    if (depth <= EPSILON) return null;
    const x = dot(direction, b.right) / (depth * tx), y = dot(direction, b.up) / (depth * ty);
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
  }
  return { xMin, xMax, yMin, yMax };
}

export function containsProjectedBounds(rect, bounds, epsilon = EPSILON) {
  const safe = normalizeSafeRect(rect);
  return !!safe && !!bounds && bounds.xMin >= safe.xMin - epsilon && bounds.xMax <= safe.xMax + epsilon
    && bounds.yMin >= safe.yMin - epsilon && bounds.yMax <= safe.yMax + epsilon;
}

/**
 * Keep the preferred visual scale if it fits, then find the closest valid FOV.
 * Full/waist/head are selected by the caller's REQUIRED POINTS, never by a label.
 *
 * maxHfov is independent of maxVfov: a very wide phone must not turn a natural
 * portrait into a 150-degree rectilinear view. `focus` can be the head anchor
 * while `anchor` is a full-body midpoint; maxFocusOffAxis constrains edge stretch.
 *
 * `validate` optionally enforces the existing secondary-head/OTS conditions for
 * each candidate, so finding the first region fit does not discard a later safe
 * lens. It must be a pure predicate. Return null means this particular framing
 * is unavailable at these actual dimensions and limits.
 *
 * The bounded 1-degree search refines the first feasible boundary to ~.00025°.
 * It does not promise to find an artificially narrower-than-step feasible window.
 */
export function fitSafeRegion({ anchor, requiredPoints, aspect, safeRect = DEFAULT_SAFE_RECT,
  target, preferredVfov = 48, minVfov = 8, maxVfov = 82, maxHfov = 120,
  pitchMin = -80, pitchMax = 80, band = { min: -85, max: 85 },
  focus = anchor, maxFocusOffAxis = 89, fovStep = 1, validate } = {}) {
  const safe = normalizeSafeRect(safeRect);
  target ??= targetInSafeRect(safe);
  if (!safe || !anchor || !target || !focus || !Array.isArray(requiredPoints) || !requiredPoints.length
    || ![anchor.yaw, anchor.pitch, focus.yaw, focus.pitch, aspect, target.x, target.y, preferredVfov, minVfov, maxVfov,
      maxHfov, pitchMin, pitchMax, band?.min, band?.max, maxFocusOffAxis, fovStep].every(finite)
    || aspect <= 0 || minVfov <= 0 || maxVfov >= 180 || minVfov > maxVfov || maxHfov <= 0 || maxHfov >= 180
    || pitchMin > pitchMax || band.min <= -90 || band.max >= 90 || band.min >= band.max || fovStep < .05
    || maxFocusOffAxis <= 0 || maxFocusOffAxis >= 90 || (validate != null && typeof validate !== 'function')
    || requiredPoints.some(point => !point || ![point.yaw, point.pitch].every(finite) || Math.abs(point.pitch) >= 90)) return null;
  const upper = Math.min(maxVfov, verticalFromHorizontal(maxHfov, aspect));
  if (upper < minVfov - EPSILON) return null;
  const preferred = clamp(preferredVfov, minVfov, upper);
  const directions = requiredPoints.map(point => directionAt(point.yaw, point.pitch));
  const focusDirection = directionAt(focus.yaw, focus.pitch);

  const evaluate = vfov => {
    const shot = cameraForAnchor(anchor, horizontalFromVertical(vfov, aspect), aspect, target);
    if (!shot || shot.pitch < pitchMin - EPSILON || shot.pitch > pitchMax + EPSILON) return null;
    const latitude = viewportLatitudeRange(shot, aspect);
    if (latitude.min < band.min - EPSILON || latitude.max > band.max + EPSILON) return null;
    const focusOffAxis = Math.acos(clamp(dot(focusDirection, directionAt(shot.yaw, shot.pitch)), -1, 1)) * DEG;
    if (focusOffAxis > maxFocusOffAxis + EPSILON) return null;
    const projectedBounds = boundsOfDirections(directions, shot);
    if (!containsProjectedBounds(safe, projectedBounds)) return null;
    const candidate = { ...shot, horizontalFov: shot.hfov, verticalFov: shot.vfov,
      safeRect: { ...safe }, target: { ...target }, projectedBounds, latitude, focusOffAxis,
      preferredVfov, adapted: Math.abs(shot.vfov - preferredVfov) > 1e-6 };
    return validate && !validate(candidate) ? null : candidate;
  };

  const initial = evaluate(preferred);
  if (initial) return initial;
  const probes = [];
  for (let value = preferred + fovStep; value < upper - EPSILON; value += fovStep) probes.push(value);
  for (let value = preferred - fovStep; value > minVfov + EPSILON; value -= fovStep) probes.push(value);
  if (upper > preferred + EPSILON) probes.push(upper);
  if (minVfov < preferred - EPSILON) probes.push(minVfov);
  probes.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || b - a);
  let failedHigher = preferred, failedLower = preferred;
  for (const value of probes) {
    const candidate = evaluate(value), higher = value > preferred;
    if (!candidate) { if (higher) failedHigher = value; else failedLower = value; continue; }
    let failed = higher ? failedHigher : failedLower, succeeded = value, result = candidate;
    for (let i = 0; i < 12; i++) {
      const middle = (failed + succeeded) / 2, fit = evaluate(middle);
      if (fit) { succeeded = middle; result = fit; } else failed = middle;
    }
    return result;
  }
  return null;
}
