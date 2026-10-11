import { directionAt, nearestYaw } from './camera-math.js';
import { normalizeSafeRect, safeRectKey, targetInSafeRect, sampleAngularBounds, sampleAngularOutline, containsProjectedBounds, fitSafeRegion } from './adaptive-framing.mjs';
import { verticalFromHorizontal } from './detail-projection.mjs';

// A station is a separately authored panorama. Composition and tilt only rotate
// the camera at that station; they never invent a raised/lowered camera position.
export const presetLabels = Object.freeze({
  full: '人物全身', environment: '环境人物', natural: '自然中景', close: '人物近景', detail: '表情特写'
});
export const lensPreset = Object.freeze({ full: 'full', wide: 'environment', medium: 'natural', close: 'close' });
export const compositionLabels = Object.freeze({ left: '人物偏左', centre: '人物居中', right: '人物偏右' });
export const tiltLabels = Object.freeze({ up: '上倾取景', level: '平视取景', down: '下倾取景' });

const RAD = Math.PI / 180;
const ASPECT = 2;
const HEAD_EDGE = 0.94;
const BODY_EDGE = 0.92;
const COMPOSITION_TOLERANCE = 0.025;
const PRESETS = Object.keys(presetLabels);
const COMPOSITIONS = Object.keys(compositionLabels);
const TILTS = ['down', 'level', 'up'];
const SUBJECT_LABELS = { customer: '顾客', barista: '咖啡师' };
const FACE_X = { left: -0.24, centre: 0, right: 0.24 };
const PITCH_OFFSET = { up: 3, level: 0, down: -3 };
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const stableCompare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const positiveModulo = (value, length) => ((value % length) + length) % length;
const matches = (value, filter) => filter == null || (Array.isArray(filter) ? filter.includes(value) : value === filter);

/** A calibrated back view is a usable manual view, without inventing a face. */
export function isSubjectViewable(person) {
  return !!person && (person.viewable === true || (person.faceVisible === true && person.facing !== 'back'));
}

function subjectView(person) {
  const dialogueEligible = person?.faceVisible === true && person?.facing !== 'back';
  const viewType = person?.facing === 'back' ? 'back' : dialogueEligible
    ? person.facing === 'profile' ? 'profile' : 'front' : 'body';
  return { viewType, dialogueEligible, faceVisible: person?.faceVisible === true };
}

function subjectLabel(subject, viewType) {
  return `${SUBJECT_LABELS[subject] ?? subject}${viewType === 'back' ? '背影' : ''}`;
}

function dialogueFilter(filters, options) {
  return filters.dialogueEligible ?? options.dialogueEligible ?? (options.purpose === 'dialogue' ? true : undefined);
}

function cameraBasis(yaw, pitch) {
  const y = yaw * RAD, p = pitch * RAD;
  return {
    forward: directionAt(yaw, pitch),
    right: [Math.sin(y), 0, -Math.cos(y)],
    up: [Math.cos(y) * Math.sin(p), Math.cos(p), Math.sin(y) * Math.sin(p)]
  };
}

// Matches PerspectiveCamera.lookAt(directionAt(yaw, pitch)), with world-up +Y.
// This helper is DOM-free; depth <= 0 means the point is behind the camera.
export function projectPanoramaPoint(point, shot, aspect = shot?.aspect ?? ASPECT) {
  const hfov = shot.hfov ?? shot.horizontalFov;
  if (![point?.yaw, point?.pitch, shot?.yaw, shot?.pitch, hfov, aspect].every(isFiniteNumber) || hfov <= 0 || hfov >= 180 || aspect <= 0) return null;
  const basis = cameraBasis(shot.yaw, shot.pitch);
  const direction = directionAt(point.yaw, point.pitch);
  const depth = dot(direction, basis.forward);
  if (depth <= 1e-8) return null;
  const tanHorizontal = Math.tan(hfov * RAD / 2);
  return {
    x: dot(direction, basis.right) / (depth * tanHorizontal),
    y: dot(direction, basis.up) * aspect / (depth * tanHorizontal),
    depth
  };
}

export function viewportAspect(config, options = {}) {
  const aspect = options.aspect ?? config?.viewportAspect ?? ASPECT;
  return isFiniteNumber(aspect) && aspect > 0 ? aspect : null;
}

function sizeForAspect(base, aspect) {
  if (!base || typeof base !== 'object') return null;
  const format = aspect < 1 ? 'portrait' : 'landscape';
  if (base[format] === false || base[format]?.enabled === false) return null;
  return { ...base, ...(base[format] ?? {}) };
}

// Existing hfov values are authored at referenceAspect=2. Preserve their VFOV,
// then derive the actual HFOV for the viewport. Portrait-specific sizes may set
// an explicit vfov/pitchOffset. Never clamp a planned shot into a different shot.
export function fitShotLens(config, station, base, aspect) {
  if (!base || !isFiniteNumber(aspect) || aspect <= 0) return null;
  const configuredMax = station?.limits?.maxVerticalFov ?? station?.camera?.maxVerticalFov ?? config.camera?.maxVerticalFov;
  const maxVfov = isFiniteNumber(configuredMax) ? configuredMax : 64;
  const referenceAspect = base.referenceAspect ?? config.referenceAspect ?? ASPECT;
  const requestedHfov = base.hfov ?? base.horizontalFov;
  const vfov = base.vfov ?? (isFiniteNumber(requestedHfov) && requestedHfov > 0 && requestedHfov < 180 && referenceAspect > 0
    ? 2 * Math.atan(Math.tan(requestedHfov * RAD / 2) / referenceAspect) / RAD : null);
  if (!isFiniteNumber(vfov) || vfov <= 0 || vfov >= 180 || vfov > maxVfov + 1e-8) return null;
  const hfov = 2 * Math.atan(Math.tan(vfov * RAD / 2) * aspect) / RAD;
  if (!isFiniteNumber(hfov) || hfov <= 0 || hfov >= 180) return null;
  return { hfov, vfov, aspect };
}

function validBand(station) {
  const min = station.limits?.latitudeMin ?? -50;
  const max = station.limits?.latitudeMax ?? 50;
  if (![min, max].every(isFiniteNumber) || min <= -90 || max >= 90 || min >= max) return null;
  return { min, max };
}

function boundsAroundAnchor(person, field = 'headBounds') {
  const a = person.anchor, b = person[field];
  if (!a || !b || ![a.yaw, a.pitch, b.yawMin, b.yawMax, b.pitchMin, b.pitchMax].every(isFiniteNumber)) return null;
  if (Math.abs(a.pitch) >= 89 || b.pitchMin <= -90 || b.pitchMax >= 90 || b.pitchMax <= b.pitchMin) return null;
  const y1 = nearestYaw(a.yaw, b.yawMin), y2 = nearestYaw(a.yaw, b.yawMax);
  const yawMin = Math.min(y1, y2), yawMax = Math.max(y1, y2);
  if (yawMax <= yawMin || yawMax - yawMin >= 180 || a.yaw < yawMin - 1e-7 || a.yaw > yawMax + 1e-7 || a.pitch < b.pitchMin - 1e-7 || a.pitch > b.pitchMax + 1e-7) return null;
  return { yawMin, yawMax, pitchMin: b.pitchMin, pitchMax: b.pitchMax };
}

// Solve the horizontal screen coordinate exactly at the selected pitch.
// For delta = anchorYaw - cameraYaw:
// sin(delta) - A*cos(delta) = B, using the same lookAt basis as above.
function solveYaw(anchor, pitch, hfov, targetX) {
  const p = pitch * RAD, a = anchor.pitch * RAD;
  const targetTan = targetX * Math.tan(hfov * RAD / 2);
  const A = targetTan * Math.cos(p);
  const B = targetTan * Math.tan(a) * Math.sin(p);
  const ratio = B / Math.hypot(1, A);
  if (!Number.isFinite(ratio) || Math.abs(ratio) > 1) return null;
  const delta = (Math.atan(A) + Math.asin(ratio)) / RAD;
  return anchor.yaw - delta;
}

function regionProjection(person, bounds, shot, edge = HEAD_EDGE, safeRect = null) {
  const projected = [];
  const yawValues = [], pitchValues = [];
  for (let i = 0; i <= 8; i++) {
    yawValues.push(bounds.yawMin + (bounds.yawMax - bounds.yawMin) * i / 8);
    pitchValues.push(bounds.pitchMin + (bounds.pitchMax - bounds.pitchMin) * i / 8);
  }
  yawValues.push(person.anchor.yaw);
  pitchValues.push(person.anchor.pitch);
  const alignedYaw = nearestYaw(person.anchor.yaw, shot.yaw);
  if (alignedYaw >= bounds.yawMin && alignedYaw <= bounds.yawMax) yawValues.push(alignedYaw);
  for (const yaw of yawValues) for (const pitch of pitchValues) {
    const p = projectPanoramaPoint({ yaw, pitch }, shot);
    if (!p || Math.abs(p.x) > edge + 1e-8 || Math.abs(p.y) > edge + 1e-8) return null;
    if (safeRect && (p.x < safeRect.xMin - 1e-8 || p.x > safeRect.xMax + 1e-8
      || p.y < safeRect.yMin - 1e-8 || p.y > safeRect.yMax + 1e-8)) return null;
    projected.push(p);
  }
  return {
    xMin: Math.min(...projected.map(p => p.x)), xMax: Math.max(...projected.map(p => p.x)),
    yMin: Math.min(...projected.map(p => p.y)), yMax: Math.max(...projected.map(p => p.y))
  };
}

function viewportWithinBand(shot, vfov, band) {
  // The configured bands normally straddle the horizon. The conservative bound
  // also keeps all corner rays safe when their latitude tends towards zero.
  const lower = Math.min(0, shot.pitch - vfov / 2);
  const upper = Math.max(0, shot.pitch + vfov / 2);
  return lower >= band.min - 1e-8 && upper <= band.max + 1e-8;
}

function foregroundVisible(person, head, shot) {
  const anchor = person.foregroundAnchor ?? person.shoulder;
  if (!anchor || !person.foreground || person.foreground === shot.subject) return false;
  const p = projectPanoramaPoint(anchor, shot);
  if (!p || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return false;
  const safe = shot.safeRect;
  if (safe && (p.x < safe.xMin || p.x > safe.xMax || p.y < safe.yMin || p.y > safe.yMax)) return false;
  // A single head/shoulder marker proves its marked part is in view, not the shape
  // of the entire occluder. Reject obvious overlap with the subject's head.
  return !(p.x >= head.xMin - 0.02 && p.x <= head.xMax + 0.02 && p.y >= head.yMin - 0.02 && p.y <= head.yMax + 0.02);
}

// A secondary main character must be wholly framed or wholly outside the image.
// New scenes can explicitly include back-facing heads; legacy scenes retain
// their face-only policy unless headFramingRequired is authored as true.
function otherHeadsSafe(station, subject, shot) {
  for (const [key, person] of Object.entries(station.subjects ?? {})) {
    if (key === subject || (person.headFramingRequired !== true && (!person.faceVisible || person.facing === 'back'))) continue;
    const bounds = boundsAroundAnchor(person); if (!bounds) continue;
    const points = [];
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const p = projectPanoramaPoint({
        yaw: bounds.yawMin + (bounds.yawMax - bounds.yawMin) * i / 8,
        pitch: bounds.pitchMin + (bounds.pitchMax - bounds.pitchMin) * j / 8
      }, shot);
      if (p) points.push(p);
    }
    if (!points.length) continue;
    const xMin = Math.min(...points.map(p => p.x)), xMax = Math.max(...points.map(p => p.x));
    const yMin = Math.min(...points.map(p => p.y)), yMax = Math.max(...points.map(p => p.y));
    if (xMax < -1 || xMin > 1 || yMax < -1 || yMin > 1) continue;
    if (xMin < -HEAD_EDGE || xMax > HEAD_EDGE || yMin < -HEAD_EDGE || yMax > HEAD_EDGE) return false;
  }
  return true;
}

/** An occluded contextual view is explicitly measured; it never proves feet. */
export function counterOcclusionRegions(person) {
  const visibility = person?.bodyVisibility;
  if (person?.bodyVisible !== false || person.bodyBounds != null || person.feetPoints != null
    || visibility?.status !== 'counter_occluded' || visibility.occluder !== 'service_counter'
    || typeof visibility.waistVisible !== 'boolean' || visibility.feetVisible !== false
    || visibility.measurementStatus !== 'measured_native_source' || !/^[a-f0-9]{64}$/i.test(visibility.sourceSha256 ?? '')
    || !Array.isArray(visibility.visibleRegions) || !visibility.visibleRegions.includes('head')
    || visibility.visibleRegions.length < 2 || visibility.visibleRegions.some(value => typeof value !== 'string' || !value
      || ['legs', 'feet'].includes(value) || value === 'waist' && !visibility.waistVisible)) return null;
  const visible = boundsAroundAnchor(person, 'visibleBodyBounds'), context = boundsAroundAnchor(person, 'fullContextBounds');
  if (!visible || !context || context.yawMin > visible.yawMin || context.yawMax < visible.yawMax
    || context.pitchMin >= visible.pitchMin || context.pitchMax < visible.pitchMax) return null;
  const visiblePoints = sampleAngularOutline(person.visibleBodyOutline, person.anchor, visible);
  const contextPoints = sampleAngularOutline(person.fullContextOutline, person.anchor, context);
  const boundary = person.occlusionBoundary;
  if (!visiblePoints.length || !contextPoints.length || !Array.isArray(boundary) || boundary.length < 2 || boundary.length > 64
    || boundary.some(point => !point || ![point.yaw, point.pitch].every(isFiniteNumber)
      || point.pitch < context.pitchMin || point.pitch > context.pitchMax
      || nearestYaw(person.anchor.yaw, point.yaw) < context.yawMin
      || nearestYaw(person.anchor.yaw, point.yaw) > context.yawMax)
    || !boundary.some(point => Math.hypot(nearestYaw(boundary[0].yaw, point.yaw) - boundary[0].yaw, point.pitch - boundary[0].pitch) > 1e-6)) return null;
  return { visible, context, visiblePoints, contextPoints: [...contextPoints, ...visiblePoints, ...boundary], visibility };
}

export function framingPresetLabel(preset, bodyMode) {
  if (preset === 'full' && bodyMode === 'context') return '全景（吧台遮挡）';
  return `${presetLabels[preset]}${bodyMode === 'visible' ? '（吧台遮挡）' : ''}`;
}

function fullPresetMode(preset, bodyMode) {
  return preset === 'full' ? ['full', 'context'].includes(bodyMode) : bodyMode !== 'context';
}

function bodyRegion(person, bodyMode) {
  if (bodyMode === 'head') return null;
  if (bodyMode === 'context' || bodyMode === 'visible') {
    const measured = counterOcclusionRegions(person);
    return measured ? measured[bodyMode === 'context' ? 'context' : 'visible'] : false;
  }
  if (bodyMode === 'full' && person.bodyVisible !== true) return false;
  if (bodyMode === 'waist' && person.bodyVisibility?.waistVisible === false) return false;
  const field = bodyMode === 'full' ? 'bodyBounds' : bodyMode === 'waist' ? 'waistBounds' : null;
  return field ? boundsAroundAnchor(person, field) ?? false : false;
}

function bodySamples(person, bodyMode, body) {
  if (!body) return { points: [], geometry: 'none' };
  if (bodyMode === 'context' || bodyMode === 'visible') {
    const measured = counterOcclusionRegions(person);
    return measured ? { points: measured[bodyMode === 'context' ? 'contextPoints' : 'visiblePoints'], geometry: `${bodyMode}-outline` } : null;
  }
  if (bodyMode !== 'full' || person.bodyOutline == null) return { points: sampleAngularBounds(body, person.anchor), geometry: 'bounds' };
  const outline = sampleAngularOutline(person.bodyOutline, person.anchor, body);
  const feet = person.feetPoints;
  // An outline is optional, but using it requires both calibrated foot markers.
  // Missing/invalid contour metadata must never turn into a head-only full shot.
  if (!outline.length || !Array.isArray(feet) || feet.length < 2 || feet.some(point =>
    !point || ![point.yaw, point.pitch].every(isFiniteNumber) || point.pitch < body.pitchMin - 1e-6
    || point.pitch > body.pitchMax + 1e-6 || nearestYaw(person.anchor.yaw, point.yaw) < body.yawMin - 1e-6
    || nearestYaw(person.anchor.yaw, point.yaw) > body.yawMax + 1e-6)) return null;
  return { points: [...outline, ...feet.map(point => ({ yaw: point.yaw, pitch: point.pitch }))], geometry: 'outline' };
}

function bodyProjectionSafe(person, body, samples, shot, edge, safe) {
  if (!body) return true;
  // The fitter projected every dense contour and foot sample, together with the
  // complete head region, into projectedBounds. Empty bbox corners are omitted.
  if (['outline', 'context-outline', 'visible-outline'].includes(samples.geometry)) return containsProjectedBounds({
    xMin: Math.max(safe.xMin, -edge), xMax: Math.min(safe.xMax, edge),
    yMin: Math.max(safe.yMin, -edge), yMax: Math.min(safe.yMax, edge)
  }, shot.projectedBounds);
  return !!regionProjection(person, body, shot, edge, safe);
}

function pitchWithinLimits(config, station, pitch) {
  const min = station.limits?.pitchMin ?? config.camera?.pitchMin ?? -89;
  const max = station.limits?.pitchMax ?? config.camera?.pitchMax ?? 89;
  return pitch >= min - 1e-8 && pitch <= max + 1e-8;
}

const hasSafeRect = options => !!options && Object.prototype.hasOwnProperty.call(options, 'safeRect');
const ADAPTIVE_CACHE = new WeakMap();
const CACHE_LIMIT = 8;

/** Configs are immutable after load; invalidate explicitly after authoring edits. */
export function clearShotCache(config) { if (config && typeof config === 'object') ADAPTIVE_CACHE.delete(config); }

export function shotGeometryKey(aspect, safeRect) {
  return `${aspect.toFixed(6)}/${safeRectKey(safeRect)}`;
}

function freezeShot(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeShot(item);
    Object.freeze(value);
  }
  return value;
}

function preferredLens(config, base) {
  if (isFiniteNumber(base.vfov) && base.vfov > 0 && base.vfov < 180) return base.vfov;
  const h = base.hfov ?? base.horizontalFov, reference = base.referenceAspect ?? config.referenceAspect ?? ASPECT;
  return isFiniteNumber(h) && h > 0 && h < 180 && isFiniteNumber(reference) && reference > 0
    ? verticalFromHorizontal(h, reference) : null;
}

function adaptiveLimits(config, station, base, preset, bodyMode) {
  const stationMax = station.limits?.maxVerticalFov ?? station.camera?.maxVerticalFov ?? config.camera?.maxVerticalFov ?? 64;
  const body = bodyMode !== 'head', near = ['close', 'detail'].includes(preset);
  return {
    minVfov: base.minVfov ?? 8,
    maxVfov: Math.min(stationMax, base.maxVfov ?? base.maxVerticalFov ?? stationMax),
    maxHfov: Math.min(station.limits?.maxHorizontalFov ?? config.camera?.maxHorizontalFov ?? 179,
      base.maxHfov ?? base.maxHorizontalFov ?? (body ? 126 : near ? 100 : 120)),
    maxFocusOffAxis: base.maxFocusOffAxis ?? (body ? 48 : near ? 26 : 34),
    pitchMin: station.limits?.pitchMin ?? config.camera?.pitchMin ?? -80,
    pitchMax: station.limits?.pitchMax ?? config.camera?.pitchMax ?? 80
  };
}

function framingAnchor(base, person, body) {
  return base.compositionAnchor ?? (body ? {
    yaw: (body.yawMin + body.yawMax) / 2,
    pitch: (body.pitchMin + body.pitchMax) / 2
  } : person.anchor);
}

function relativeTargetY(base, body, preferredVfov, tilt = 'level') {
  const tan = Math.tan(preferredVfov * RAD / 2);
  const authored = base.targetY ?? base.compositionY;
  if (authored != null && (!isFiniteNumber(authored) || Math.abs(authored) > .8)) return null;
  // Legacy pitch offsets become a screen-placement preference. The actual
  // camera yaw/pitch is solved against the overlay-safe rectangle afterward.
  const nominal = authored ?? (body ? 0 : Math.max(-.5, Math.min(.5,
    Math.tan(-(base.pitchOffset ?? 0) * RAD) / tan)));
  return Math.max(-.8, Math.min(.8, nominal - Math.tan(PITCH_OFFSET[tilt] * RAD) / tan));
}

function finalizeAdaptiveShot(shot, station, aspect, safe) {
  shot.baseId = [shot.station, shot.subject, shot.kind, shot.preset, shot.composition, shot.tilt].join('/');
  shot.geometryKey = shotGeometryKey(aspect, safe);
  shot.id = `${shot.baseId}/g${shot.geometryKey}`;
  shot.label = [station.label ?? shot.station, subjectLabel(shot.subject, shot.viewType),
    framingPresetLabel(shot.preset, shot.bodyMode), compositionLabels[shot.composition], tiltLabels[shot.tilt]].join(' · ');
  return freezeShot(shot);
}

function enumerateAdaptiveShots(config, aspect, safe) {
  const result = [];
  for (const [stationId, station] of Object.entries(config.stations)) {
    const band = validBand(station); if (!band) continue;
    for (const [subject, person] of Object.entries(station.subjects ?? {})) {
      if (!isSubjectViewable(person)) continue;
      const view = subjectView(person);
      const headBounds = boundsAroundAnchor(person); if (!headBounds) continue;
      const headPoints = sampleAngularBounds(headBounds, person.anchor);
      for (const [preset, authored] of Object.entries(person.sizes ?? {})) {
        if (!presetLabels[preset]) continue;
        const base = sizeForAspect(authored, aspect); if (!base || !isFiniteNumber(base.pitchOffset ?? 0)) continue;
        const preferredVfov = preferredLens(config, base); if (!preferredVfov) continue;
        const bodyMode = base.bodyMode ?? (preset === 'full' ? 'full' : 'head');
        const bodyEdge = base.bodyEdge ?? BODY_EDGE;
        if (!isFiniteNumber(bodyEdge) || bodyEdge <= 0 || bodyEdge > .98) continue;
        const body = bodyRegion(person, bodyMode);
        if (body === false || !fullPresetMode(preset, bodyMode)) continue;
        const samples = bodySamples(person, bodyMode, body); if (!samples) continue;
        const anchor = framingAnchor(base, person, body);
        if (![anchor?.yaw, anchor?.pitch].every(isFiniteNumber) || Math.abs(anchor.pitch) >= 89) continue;
        const kind = base.kind ?? person.kind ?? 'single';
        if (!['single', 'overShoulder'].includes(kind)) continue;
        const requiredPoints = [...headPoints, ...samples.points];
        const limits = adaptiveLimits(config, station, base, preset, bodyMode);
        for (const composition of COMPOSITIONS) for (const tilt of TILTS) {
          const y = relativeTargetY(base, body, preferredVfov, tilt); if (y == null) continue;
          const target = targetInSafeRect(safe, { x: FACE_X[composition], y });
          const metadata = { station: stationId, subject, preset, composition, tilt, kind, bodyMode, bodyEdge, bodyGeometry: samples.geometry, ...view,
            compositionAnchor: { ...anchor },
            foreground: kind === 'overShoulder' ? person.foreground ?? null : null,
            foregroundRegion: kind === 'overShoulder' ? person.foregroundAnchor?.region ?? (person.shoulder ? 'shoulder' : null) : null,
            format: aspect < 1 ? 'portrait' : 'landscape' };
          if (bodyMode === 'context' || bodyMode === 'visible') metadata.bodyVisibility = {
            ...person.bodyVisibility, visibleRegions: [...person.bodyVisibility.visibleRegions]
          };
          const fit = fitSafeRegion({ anchor, focus: person.anchor, requiredPoints, aspect, safeRect: safe,
            target, preferredVfov, ...limits, band,
            validate: geometry => {
              const shot = { ...metadata, ...geometry };
              const head = regionProjection(person, headBounds, shot, HEAD_EDGE, safe);
              return !!head && bodyProjectionSafe(person, body, samples, shot, bodyEdge, safe)
                && (kind !== 'overShoulder' || foregroundVisible(person, head, shot))
                && otherHeadsSafe(station, subject, shot);
            }
          });
          if (fit) result.push(finalizeAdaptiveShot({ ...metadata, ...fit }, station, aspect, safe));
        }
      }
    }
  }
  return Object.freeze(result.sort(stableCompare));
}

/** Presence matters: `{safeRect:null}` must not silently enter the old planner. */
export function enumerateShots(config, filters = {}, options = {}) {
  if (!config?.stations || !filters || typeof filters !== 'object' || !options || typeof options !== 'object') return [];
  if (!hasSafeRect(options)) return enumerateLegacyShots(config, filters, options);
  const aspect = viewportAspect(config, { aspect: options.aspect ?? filters.aspect });
  const safe = options.safeRect == null ? null : normalizeSafeRect(options.safeRect);
  if (aspect == null || !safe) return [];
  const key = shotGeometryKey(aspect, safe);
  let cache = ADAPTIVE_CACHE.get(config), pool = options.cache === false ? null : cache?.get(key);
  if (!pool) {
    pool = enumerateAdaptiveShots(config, aspect, safe);
    if (options.cache !== false) {
      if (!cache) { cache = new Map(); ADAPTIVE_CACHE.set(config, cache); }
      cache.set(key, pool);
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    }
  } else { cache.delete(key); cache.set(key, pool); }
  return pool.filter(shot => matches(shot.station, filters.station) && matches(shot.subject, filters.subject)
    && matches(shot.preset, filters.preset) && matches(shot.composition, filters.composition)
    && matches(shot.tilt, filters.tilt) && matches(shot.kind, filters.kind)
    && matches(shot.bodyMode, filters.bodyMode ?? options.bodyMode)
    && matches(shot.viewType, filters.viewType) && matches(shot.dialogueEligible, dialogueFilter(filters, options)));
}

function resolveAdaptiveEnvironment(config, stationId, options) {
  const station = config?.stations?.[stationId], aspect = viewportAspect(config, options);
  const safe = options.safeRect == null ? null : normalizeSafeRect(options.safeRect);
  if (!station || aspect == null || !safe) return null;
  const base = sizeForAspect(station.environment, aspect), band = validBand(station);
  if (!base || !band || ![base.yaw, base.pitch].every(isFiniteNumber)) return null;
  const bodyMode = options.bodyMode ?? base.bodyMode ?? 'head';
  if (!['head', 'waist', 'full'].includes(bodyMode)) return null;
  const preferredVfov = preferredLens(config, base); if (!preferredVfov) return null;
  const kind = base.kind ?? 'environment';
  const anchor = base.compositionAnchor ?? { yaw: base.yaw, pitch: base.pitch };
  const people = Object.values(station.subjects ?? {}).filter(person => person.faceVisible === true && person.facing !== 'back');
  const overShoulder = kind === 'overShoulder';
  const primaryEntry = overShoulder ? Object.entries(station.subjects ?? {}).find(([, person]) =>
    person.faceVisible === true && person.facing !== 'back' && person.foreground) : null;
  if (overShoulder && !primaryEntry) return null;
  const regions = [], requiredPoints = [];
  if (kind === 'twoShot' || overShoulder) {
    if (kind === 'twoShot' && people.length < 2) return null;
    for (const person of overShoulder ? [primaryEntry[1]] : people) {
      const head = boundsAroundAnchor(person), body = bodyRegion(person, bodyMode);
      if (!head || body === false) return null;
      const samples = bodySamples(person, bodyMode, body); if (!samples) return null;
      regions.push({ person, head, body, samples }); requiredPoints.push(...sampleAngularBounds(head, person.anchor), ...samples.points);
    }
  } else requiredPoints.push(anchor);
  const limits = adaptiveLimits(config, station, base, 'environment', bodyMode);
  const y = relativeTargetY(base, bodyMode !== 'head', preferredVfov); if (y == null) return null;
  const metadata = { station: stationId, subject: 'environment', preset: 'environment', composition: 'centre', tilt: 'level',
    kind, bodyMode, compositionAnchor: { ...anchor }, format: aspect < 1 ? 'portrait' : 'landscape' };
  if (overShoulder) Object.assign(metadata, { primarySubject: primaryEntry[0], foreground: primaryEntry[1].foreground,
    foregroundRegion: primaryEntry[1].foregroundAnchor?.region ?? (primaryEntry[1].shoulder ? 'shoulder' : null) });
  const fit = fitSafeRegion({ anchor, focus: overShoulder ? primaryEntry[1].anchor : anchor, requiredPoints, aspect, safeRect: safe,
    target: targetInSafeRect(safe, { y }), preferredVfov, ...limits, band,
    validate: geometry => {
      const shot = { ...metadata, ...geometry };
      if (kind !== 'twoShot' && !overShoulder) return otherHeadsSafe(station, 'environment', shot);
      for (const { person, head, body, samples } of regions) {
        const offAxis = Math.acos(Math.max(-1, Math.min(1, dot(directionAt(person.anchor.yaw, person.anchor.pitch),
          directionAt(shot.yaw, shot.pitch))))) / RAD;
        if (offAxis > limits.maxFocusOffAxis + 1e-8 || !regionProjection(person, head, shot, HEAD_EDGE, safe)
          || !bodyProjectionSafe(person, body, samples, shot, BODY_EDGE, safe)) return false;
      }
      if (overShoulder) {
        const primary = primaryEntry[1], head = regionProjection(primary, regions[0].head, shot, HEAD_EDGE, safe);
        return !!head && foregroundVisible(primary, head, shot) && otherHeadsSafe(station, primaryEntry[0], shot);
      }
      return true;
    }
  });
  if (!fit) return null;
  const shot = { ...metadata, ...fit, baseId: `${stationId}/environment`, geometryKey: shotGeometryKey(aspect, safe) };
  shot.id = `${shot.baseId}/g${shot.geometryKey}`;
  shot.label = `${station.label ?? stationId} · ${kind === 'twoShot' ? bodyMode === 'full' ? '双人全身' : '双人全景' : '空间全景'}`;
  return freezeShot(shot);
}

function enumerateLegacyShots(config, filters = {}, options = {}) {
  if (!config?.stations || !filters || typeof filters !== 'object') return [];
  const aspect = viewportAspect(config, { aspect: options.aspect ?? filters.aspect });
  if (aspect == null) return [];
  const result = [];
  for (const [stationId, station] of Object.entries(config.stations)) {
    if (!matches(stationId, filters.station)) continue;
    const band = validBand(station);
    if (!band) continue;
    for (const [subject, person] of Object.entries(station.subjects ?? {})) {
      if (!matches(subject, filters.subject) || !isSubjectViewable(person)) continue;
      const view = subjectView(person);
      if (!matches(view.viewType, filters.viewType) || !matches(view.dialogueEligible, dialogueFilter(filters, options))) continue;
      const bounds = boundsAroundAnchor(person);
      if (!bounds) continue;
      for (const [preset, authoredSize] of Object.entries(person.sizes ?? {})) {
        if (!presetLabels[preset] || !matches(preset, filters.preset)) continue;
        const base = sizeForAspect(authoredSize, aspect);
        if (!base) continue;
        const lens = fitShotLens(config, station, base, aspect);
        if (!lens || !isFiniteNumber(base.pitchOffset ?? 0)) continue;
        const bodyMode = base.bodyMode ?? (preset === 'full' ? 'full' : 'head');
        const bodyEdge = base.bodyEdge ?? BODY_EDGE;
        if (!isFiniteNumber(bodyEdge) || bodyEdge <= 0 || bodyEdge > 0.98) continue;
        if (!matches(bodyMode, filters.bodyMode ?? options.bodyMode)) continue;
        const body = bodyRegion(person, bodyMode);
        if (body === false || !fullPresetMode(preset, bodyMode)) continue;
        // An authored body-composition marker may differ slightly from the face
        // anchor. This shifts framing only; original head/body bounds stay intact.
        const compositionAnchor = base.compositionAnchor ?? person.anchor;
        if (![compositionAnchor?.yaw, compositionAnchor?.pitch].every(isFiniteNumber) || Math.abs(compositionAnchor.pitch) >= 89) continue;
        const kind = base.kind ?? person.kind ?? 'single';
        if (!['single', 'overShoulder'].includes(kind) || !matches(kind, filters.kind)) continue;
        for (const composition of COMPOSITIONS) {
          if (!matches(composition, filters.composition)) continue;
          for (const tilt of TILTS) {
            if (!matches(tilt, filters.tilt)) continue;
            const pitch = person.anchor.pitch + (base.pitchOffset ?? 0) + PITCH_OFFSET[tilt];
            if (Math.abs(pitch) >= 89 || !pitchWithinLimits(config, station, pitch)) continue;
            const yaw = solveYaw(compositionAnchor, pitch, lens.hfov, FACE_X[composition]);
            if (yaw == null) continue;
            const shot = {
              station: stationId, subject, preset, composition, tilt, kind, bodyMode, bodyEdge, ...view,
              compositionAnchor: { ...compositionAnchor },
              foreground: kind === 'overShoulder' ? person.foreground ?? null : null,
              foregroundRegion: kind === 'overShoulder' ? person.foregroundAnchor?.region ?? (person.shoulder ? 'shoulder' : null) : null,
              yaw, pitch, hfov: lens.hfov, horizontalFov: lens.hfov, vfov: lens.vfov, aspect,
              format: aspect < 1 ? 'portrait' : 'landscape'
            };
            if (bodyMode === 'context' || bodyMode === 'visible') shot.bodyVisibility = {
              ...person.bodyVisibility, visibleRegions: [...person.bodyVisibility.visibleRegions]
            };
            if (!viewportWithinBand(shot, lens.vfov, band)) continue;
            const placement = projectPanoramaPoint(compositionAnchor, shot);
            if (!placement || Math.abs(placement.x - FACE_X[composition]) > COMPOSITION_TOLERANCE) continue;
            const head = regionProjection(person, bounds, shot);
            if (!head || (kind === 'overShoulder' && !foregroundVisible(person, head, shot))) continue;
            if (body && !regionProjection(person, body, shot, bodyEdge)) continue;
            if (!otherHeadsSafe(station, subject, shot)) continue;
            shot.baseId = [stationId, subject, kind, preset, composition, tilt].join('/');
            shot.id = `${shot.baseId}/a${aspect.toFixed(6)}`;
            shot.label = [station.label ?? stationId, subjectLabel(subject, shot.viewType), framingPresetLabel(preset, bodyMode), compositionLabels[composition], tiltLabels[tilt]].join(' · ');
            result.push(shot);
          }
        }
      }
    }
  }
  return result.sort(stableCompare);
}

function preferenceCost(shot, desired) {
  const sizeDifference = Math.abs(PRESETS.indexOf(shot.preset) - PRESETS.indexOf(desired.preset));
  const compositionDifference = Math.abs(COMPOSITIONS.indexOf(shot.composition) - COMPOSITIONS.indexOf(desired.composition));
  const tiltDifference = Math.abs(TILTS.indexOf(shot.tilt) - TILTS.indexOf(desired.tilt));
  return (shot.station === desired.station ? 0 : 1000) + sizeDifference * 100 + compositionDifference * 10 + tiltDifference;
}

function bestShot(candidates, desired, previous = null) {
  return [...candidates].sort((a, b) => {
    const scoreA = preferenceCost(a, desired) + (a.station === previous?.station ? 0.25 : 0);
    const scoreB = preferenceCost(b, desired) + (b.station === previous?.station ? 0.25 : 0);
    return scoreA - scoreB || stableCompare(a, b);
  })[0] ?? null;
}

// Explicit station and preset are hard constraints. Only a caller that opts in
// with allowPresetFallback:true may substitute another size at that station.
// Explicit bodyMode:'full' keeps its full-body requirement. The full preset may
// use a separately authored context mode, which is labeled as counter occluded.
export function resolveShot(config, subject, preset = 'environment', options = {}) {
  if (!presetLabels[preset] || !options || typeof options !== 'object') return null;
  const composition = options.composition ?? 'centre', tilt = options.tilt ?? 'level';
  if (!compositionLabels[composition] || !tiltLabels[tilt]) return null;
  const bodyMode = options.bodyMode;
  const candidates = enumerateShots(config, { subject, bodyMode,
    ...(options.allowPresetFallback !== true || options.strictPreset === true || preset === 'full' ? { preset } : {}),
    ...(options.station != null ? { station: options.station } : {}) }, options);
  if (!candidates.length) return null;
  const station = options.station ?? config.initialStation ?? 'centre';
  return bestShot(candidates, { station, preset, composition, tilt });
}

function unavailableReason(config, station, person, preset, aspect, options) {
  if (!person) return 'unknown_subject';
  if (!isSubjectViewable(person)) return 'subject_not_viewable';
  if (dialogueFilter({}, options) === true && !subjectView(person).dialogueEligible) return 'dialogue_face_unavailable';
  if (!validBand(station)) return 'invalid_source_band';
  if (!boundsAroundAnchor(person)) return 'head_bounds_unavailable';
  const authored = person.sizes?.[preset];
  if (!authored) return 'preset_not_authored';
  const base = sizeForAspect(authored, aspect);
  if (!base) return 'format_disabled';
  if (!preferredLens(config, base) || !isFiniteNumber(base.pitchOffset ?? 0)) return 'invalid_size_metadata';
  const mode = base.bodyMode ?? (preset === 'full' ? 'full' : 'head');
  if (!fullPresetMode(preset, mode)) return 'full_body_required';
  if (['context', 'visible'].includes(mode) && !counterOcclusionRegions(person)) return 'occlusion_metadata_invalid';
  if (mode === 'full' && person.bodyVisible !== true) return 'body_not_visible';
  const body = bodyRegion(person, mode);
  if (body === false) return mode === 'waist' ? 'waist_bounds_unavailable' : 'body_bounds_unavailable';
  if (!bodySamples(person, mode, body)) return 'body_outline_invalid';
  if (options.bodyMode != null && mode !== options.bodyMode) return 'body_mode_mismatch';
  return 'no_safe_framing';
}

/**
 * Exact per-preset geometry availability for the current role, station and DOM
 * safe rectangle. Counts never include another preset, role, station or an HD
 * existence claim. `shot` is the same preferred exact result as resolveShot.
 * Configs are immutable after load; use clearShotCache after authoring edits.
 */
export function getShotAvailability(config, subject, options = {}) {
  const validOptions = !!options && typeof options === 'object';
  const opts = validOptions ? options : {};
  const aspect = viewportAspect(config, opts);
  const stationId = opts.station ?? null;
  const entries = config?.stations ? Object.entries(config.stations).filter(([id]) => stationId == null || id === stationId) : [];
  const safe = hasSafeRect(opts) ? opts.safeRect == null ? null : normalizeSafeRect(opts.safeRect) : undefined;
  const commonReason = !validOptions || aspect == null ? 'invalid_viewport'
    : !entries.length ? 'unknown_station' : hasSafeRect(opts) && !safe ? 'no_safe_region' : null;
  const pool = commonReason ? [] : enumerateShots(config, { subject,
    ...(stationId != null ? { station: stationId } : {}) }, opts);
  const preferred = { station: stationId ?? config?.initialStation ?? 'centre',
    composition: opts.composition ?? 'centre', tilt: opts.tilt ?? 'level' };
  const onlyPerson = entries.length === 1 ? entries[0][1].subjects?.[subject] : null;
  return Object.fromEntries(PRESETS.map(preset => {
    const candidates = pool.filter(shot => shot.preset === preset);
    const shot = candidates.length ? bestShot(candidates, { ...preferred, preset }) : null;
    const reasons = shot ? [] : [...new Set(commonReason ? [commonReason] : entries.map(([, station]) =>
      unavailableReason(config, station, station.subjects?.[subject], preset, aspect, opts)))];
    return [preset, { available: !!shot, count: candidates.length, reason: reasons[0] ?? null, reasons, shot,
      label: framingPresetLabel(preset, shot?.bodyMode ?? onlyPerson?.sizes?.[preset]?.bodyMode),
      viewType: shot?.viewType ?? (onlyPerson ? subjectView(onlyPerson).viewType : null),
      dialogueEligible: shot?.dialogueEligible ?? (onlyPerson ? subjectView(onlyPerson).dialogueEligible : false) }];
  }));
}

const DIALOGUE_PREFERENCES = {
  barista: [
    { station: 'centre', preset: 'full', composition: 'centre', tilt: 'level' },
    { station: 'behind_customer', preset: 'natural', composition: 'right', tilt: 'level' },
    { station: 'right_side', preset: 'natural', composition: 'right', tilt: 'down' },
    { station: 'behind_customer', preset: 'close', composition: 'right', tilt: 'up' }
  ],
  customer: [
    { station: 'behind_barista', preset: 'full', composition: 'left', tilt: 'level' },
    { station: 'left_side', preset: 'natural', composition: 'left', tilt: 'up' },
    { station: 'centre', preset: 'close', composition: 'left', tilt: 'level' },
    { station: 'behind_barista', preset: 'close', composition: 'right', tilt: 'down' }
  ]
};

// Precompute by line index. Interrupted transitions and replays cannot consume
// a mutable random/history counter. Missing subject assets yield null, never a
// shot of the wrong person; the caller can keep the current scene and report it.
export function planLesson(config, lines, variation = 0, options = {}) {
  if (!Array.isArray(lines)) return [];
  const variant = Number.isFinite(variation) ? Math.trunc(variation) : 0;
  const pool = enumerateShots(config, { dialogueEligible: true }, options), occurrences = new Map(), lastBySubject = new Map();
  let previous = null;
  return lines.map(line => {
    const subject = line?.shot;
    const occurrence = occurrences.get(subject) ?? 0;
    occurrences.set(subject, occurrence + 1);
    const patterns = config.dialoguePreferences?.[subject] ?? DIALOGUE_PREFERENCES[subject] ?? [{ station: config.initialStation ?? 'centre', preset: 'natural', composition: 'centre', tilt: 'level' }];
    const desired = { ...patterns[positiveModulo(occurrence + variant, patterns.length)] };
    desired.composition = COMPOSITIONS[positiveModulo(COMPOSITIONS.indexOf(desired.composition) + Math.floor(variant / 4), COMPOSITIONS.length)];
    desired.tilt = TILTS[positiveModulo(TILTS.indexOf(desired.tilt) + Math.floor(variant / 12), TILTS.length)];
    let candidates = pool.filter(shot => shot.subject === subject);
    const alternatives = candidates.filter(shot => shot.id !== lastBySubject.get(subject)?.id);
    if (alternatives.length) candidates = alternatives;
    const shot = bestShot(candidates, desired, previous);
    if (shot) { lastBySubject.set(subject, shot); previous = shot; }
    return shot;
  });
}

// Compatible with the previous five arguments. Manual selection can also pass
// { preset, station, composition, tilt } so a chosen station remains explicit.
export function lessonShot(config, lines, index, automatic = true, selected = 'environment', variation = 0, options = {}) {
  if (!Number.isInteger(index) || index < 0 || !lines?.[index]) return null;
  if (automatic) return planLesson(config, lines, variation, options)[index] ?? null;
  if (typeof selected === 'object' && selected) return resolveShot(config, lines[index].shot, selected.preset ?? 'environment', { ...options, ...selected });
  return resolveShot(config, lines[index].shot, selected ?? 'environment', options);
}

/** Environment shots used to bypass all projection checks in CameraStage.
 * This resolver retains an explicit authored yaw/pitch and validates both visible
 * main characters for a twoShot. Unsupported portrait combinations return null.
 */
export function resolveEnvironmentShot(config, stationId, options = {}) {
  if (hasSafeRect(options)) return resolveAdaptiveEnvironment(config, stationId, options);
  const station = config?.stations?.[stationId];
  if (!station) return null;
  const aspect = viewportAspect(config, options);
  if (aspect == null) return null;
  const base = sizeForAspect(station.environment, aspect), band = validBand(station);
  if (!base || !band) return null;
  const lens = fitShotLens(config, station, base, aspect);
  if (!lens || ![base.yaw, base.pitch].every(isFiniteNumber) || !pitchWithinLimits(config, station, base.pitch)) return null;
  const bodyMode = options.bodyMode ?? base.bodyMode ?? 'head';
  if (!['head', 'waist', 'full'].includes(bodyMode)) return null;
  const shot = { station: stationId, subject: 'environment', preset: 'environment', composition: 'centre', tilt: 'level',
    kind: base.kind ?? 'environment', bodyMode, yaw: base.yaw, pitch: base.pitch,
    hfov: lens.hfov, horizontalFov: lens.hfov, vfov: lens.vfov, aspect, format: aspect < 1 ? 'portrait' : 'landscape' };
  if (!viewportWithinBand(shot, lens.vfov, band)) return null;
  if (shot.kind === 'twoShot') {
    const people = Object.values(station.subjects ?? {}).filter(person => person.faceVisible === true && person.facing !== 'back');
    if (people.length < 2) return null;
    for (const person of people) {
      const head = boundsAroundAnchor(person);
      if (!head || !regionProjection(person, head, shot)) return null;
      const body = bodyRegion(person, bodyMode);
      if (body === false || (body && !regionProjection(person, body, shot, BODY_EDGE))) return null;
    }
  } else if (!otherHeadsSafe(station, 'environment', shot)) return null;
  shot.baseId = `${stationId}/environment`;
  shot.id = `${shot.baseId}/a${aspect.toFixed(6)}`;
  shot.label = `${station.label ?? stationId} · ${shot.kind === 'twoShot' ? bodyMode === 'full' ? '双人全身' : '双人全景' : '空间全景'}`;
  return shot;
}
