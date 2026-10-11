export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const easeTurn = t => t * t * (3 - 2 * t);
export const easeWhip = t => t < .5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);

// Image midpoint is yaw 0; increasing yaw follows increasing image columns.
// This matches the inward-facing, X-flipped Three.js SphereGeometry UV map.
export function viewAngles(view) {
  if (Number.isFinite(view.yaw) && Number.isFinite(view.pitch)) return { yaw: view.yaw, pitch: view.pitch };
  return { yaw: (view.u - .5) * 360, pitch: (.5 - view.v) * 180 };
}

export function directionAt(yaw, pitch) {
  const lon = yaw * Math.PI / 180, lat = pitch * Math.PI / 180;
  return [-Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
}

export function nearestYaw(current, target) {
  let delta = ((target - current + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(delta + 180) < 1e-9 && target - current > 0) delta = 180;
  return current + delta;
}

// Fit a perspective viewport without exposing the panorama's unchecked poles.
// These limits apply to every visible ray, not only to the camera's centre.
export function fitViewport(width, height, settings) {
  const aspect = Math.max(1, width) / Math.max(1, height);
  const radians = Math.PI / 180;
  const preferredVertical = 2 * Math.atan(Math.tan(settings.horizontalFov * radians / 2) / aspect) / radians;
  const latitudeMin = settings.latitudeMin ?? -89;
  const latitudeMax = settings.latitudeMax ?? 89;
  const verticalFov = Math.min(preferredVertical, settings.maxVerticalFov ?? 70, latitudeMax - latitudeMin);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * radians / 2) * aspect) / radians;
  const pitchMin = Math.max(settings.pitchMin, latitudeMin + verticalFov / 2);
  const pitchMax = Math.min(settings.pitchMax, latitudeMax - verticalFov / 2);
  return { aspect, horizontalFov, verticalFov, pitchMin, pitchMax };
}
