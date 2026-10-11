import { clamp, nearestYaw, fitViewport } from './camera-math.js';

// 沿用精简版已验收的预设和曲线；此模块供完整播放器、编辑预览与静态导出共同使用。
export const TRANSITION_NAMES = Object.freeze({ auto: '分镜默认', cut: '直接切镜', whip: '快速甩镜', 'soft-blur': '柔和短模糊', pan: '缓入缓出', push: '轻微推拉', occlusion: '条件遮挡' });
export const TRANSITION_TYPES = Object.freeze(Object.keys(TRANSITION_NAMES));
export const TRANSITION_SPEEDS = Object.freeze({ slow: 1.55, normal: 1, fast: .7 });
export const MOTION_CURVES = Object.freeze(['linear', 'ease-in-out', 'ease-out']);
export const DEFAULT_TRANSITION = Object.freeze({ type: 'auto', speed: 'normal', curve: 'ease-in-out' });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function validTransition(value) {
  if (value == null) return true;
  if (!plain(value)) return false;
  // 旧包保持可导入；旧的球面偏移/长模糊参数迁移为自动短转场，不继续制造拖影。
  if (value.type == null) return value.kind === 'dialogue' && finite(value.offset) && value.offset >= 0 && value.offset <= 12
    && finite(value.blur) && value.blur >= 0 && value.blur <= 8 && (value.direction == null || [-1, 1].includes(value.direction));
  return TRANSITION_TYPES.includes(value.type) && Object.hasOwn(TRANSITION_SPEEDS, value.speed)
    && MOTION_CURVES.includes(value.curve) && (value.pushDirection == null || ['in', 'out'].includes(value.pushDirection));
}
export function validTransitionDuration(durationMs, transition) {
  if (!Number.isInteger(durationMs)) return false;
  if (transition?.type === 'cut') return durationMs === 0;
  return transition?.type ? durationMs >= 80 && durationMs <= 1200 : durationMs >= 100 && durationMs <= 5000;
}
export function normalizeTransition(value) {
  return { type: TRANSITION_TYPES.includes(value?.type) ? value.type : 'auto',
    speed: Object.hasOwn(TRANSITION_SPEEDS, value?.speed) ? value.speed : 'normal',
    curve: MOTION_CURVES.includes(value?.curve) ? value.curve : 'ease-in-out',
    ...(value?.pushDirection ? { pushDirection: value.pushDirection } : {}) };
}
export function easeMotion(value, curve = 'ease-in-out') {
  const t = clamp(Number(value) || 0, 0, 1);
  return curve === 'linear' ? t : curve === 'ease-out' ? 1 - (1 - t) ** 3 : t * t * (3 - 2 * t);
}
export function verifiedOccluder(shot) {
  const value = shot?.occlusion, bounds = value?.bounds;
  return value?.verified === true && value.station === shot.station && value.sourceAsset === shot.assetSrc
    && typeof value.sourceAsset === 'string' && value.sourceAsset.length > 0
    && ['shoulder', 'environment'].includes(value.kind) && ['left', 'right'].includes(value.side)
    && bounds && ['xMin', 'xMax', 'yMin', 'yMax'].every(key => finite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 1)
    && bounds.xMax > bounds.xMin && bounds.yMax > bounds.yMin ? value : null;
}
export function resolveCameraTransition(previous, next, value, context = {}) {
  const options = normalizeTransition(value), requested = options.type;
  const sameStation = !!previous && previous.station === next.station && !context.actionChange;
  const turn = sameStation && finite(previous.yaw) && finite(next.yaw)
    ? Math.hypot(nearestYaw(previous.yaw, next.yaw) - previous.yaw, (next.pitch ?? 0) - (previous.pitch ?? 0)) : Infinity;
  // 大角度正反打直接剪接；只有同一观察点的小幅转向才默认连续运动。
  let type = requested === 'auto' ? sameStation && turn <= 55 ? 'pan' : 'cut' : requested, reason = '';
  const occlusion = verifiedOccluder(next) ?? verifiedOccluder(previous);
  if (!previous) type = 'cut';
  if (type === 'pan' && !sameStation) { type = 'cut'; reason = '不同机位使用直接切镜；连续转向只用于同一全景。'; }
  if (type === 'occlusion' && !occlusion) { type = 'cut'; reason = '没有已核验的前景遮挡，本次使用直接切镜。'; }
  if (context.reduced) { type = 'cut'; reason = '已减少动态效果，使用直接切镜。'; }
  if (context.blurEnabled === false && ['whip', 'soft-blur'].includes(type)) { type = 'cut'; reason = '已关闭运动模糊，使用直接切镜。'; }
  const base = finite(context.durationMs) && context.durationMs > 0 ? context.durationMs : type === 'pan' ? 420 : type === 'push' ? 900 : 220;
  const durationMs = type === 'cut' ? 0 : clamp(base * TRANSITION_SPEEDS[options.speed] * (context.speedFactor ?? 1), 80, 1860);
  return { ...options, type, requested, reason, sameStation, durationMs,
    direction: next.composition === 'left' || next.subject === 'customer' ? -1 : 1,
    occlusion: type === 'occlusion' ? occlusion : null };
}
export function cameraTransitionFrame(progress, edit) {
  const t = clamp(progress, 0, 1), incoming = t >= .5;
  const result = { incoming, blur: 0, offset: 0, scale: 1, mask: 0, progress: easeMotion(t, edit.curve) };
  if (t <= 0 || t >= 1 || !['whip', 'soft-blur', 'occlusion'].includes(edit.type)) return result;
  // 模糊只存在于切点周围最多96毫秒，不拉长整段运镜，也不保留前一帧造成重影。
  const half = Math.min(.5, 48 / Math.max(80, edit.durationMs)), q = (t - .5 + half) / (2 * half);
  if (q <= 0 || q >= 1) return result;
  const pulse = easeMotion(1 - Math.abs(2 * q - 1), edit.curve) ** 2;
  if (edit.type === 'whip') {
    result.blur = 10 * pulse; result.offset = edit.direction * (incoming ? 1 : -1) * .026 * pulse; result.scale = 1 + .13 * pulse;
  } else if (edit.type === 'soft-blur') { result.blur = 3.2 * pulse; result.scale = 1 + .028 * pulse; }
  else result.mask = Math.min(1, pulse * 1.12);
  return result;
}
export function clearCameraTransition(stage) {
  stage.screenBlurPx = 0;
  if (stage.canvas?.style) { stage.canvas.style.filter = ''; stage.canvas.style.transform = ''; }
  if (stage.occlusionLayer) stage.occlusionLayer.hidden = true;
}
function paintEdit(stage, frame, edit) {
  stage.screenBlurPx = frame.blur;
  if (stage.canvas?.style) {
    stage.canvas.style.filter = frame.blur ? `blur(${frame.blur.toFixed(3)}px)` : '';
    stage.canvas.style.transform = frame.scale === 1 ? '' : `translateX(${frame.offset * 100}%) scale(${frame.scale})`;
  }
  if (!frame.mask) { if (stage.occlusionLayer) stage.occlusionLayer.hidden = true; return; }
  if (!edit.occlusion || !globalThis.document?.createElement || !stage.container?.append) return;
  if (!stage.occlusionLayer) {
    stage.occlusionLayer = document.createElement('div'); stage.occlusionLayer.setAttribute('aria-hidden', 'true');
    Object.assign(stage.occlusionLayer.style, { position: 'absolute', inset: '-3%', zIndex: '2', pointerEvents: 'none', backgroundRepeat: 'no-repeat', filter: 'blur(12px)', transform: 'scale(1.02)', willChange: 'clip-path' });
    stage.container.append(stage.occlusionLayer);
  }
  const layer = stage.occlusionLayer, o = edit.occlusion, b = o.bounds, w = b.xMax - b.xMin, h = b.yMax - b.yMin;
  layer.hidden = false; layer.style.backgroundImage = `url(${JSON.stringify(o.sourceAsset)})`;
  layer.style.backgroundSize = `${100 / w}% ${100 / h}%`;
  layer.style.backgroundPosition = `${w < 1 ? b.xMin / (1 - w) * 100 : 0}% ${h < 1 ? b.yMin / (1 - h) * 100 : 0}%`;
  layer.style.clipPath = o.side === 'right' ? `inset(0 0 0 ${(1 - frame.mask) * 100}%)` : `inset(0 ${(1 - frame.mask) * 100}% 0 0)`;
}
function pushFitsSubject(target, hfov) {
  const b = target.projectedBounds, safe = target.safeRect;
  if (!b || !safe) return true;
  // 同一姿态改变视角时，已实测轮廓的屏幕坐标按正切比例缩放。
  const scale = Math.tan(target.hfov * Math.PI / 360) / Math.tan(hfov * Math.PI / 360);
  return b.xMin * scale >= safe.xMin - 1e-8 && b.xMax * scale <= safe.xMax + 1e-8
    && b.yMin * scale >= safe.yMin - 1e-8 && b.yMax * scale <= safe.yMax + 1e-8;
}
function describe(stage, shot) {
  if (!shot) return null;
  const node = stage.config.stations[shot.station];
  return { ...shot, assetSrc: node?.panorama.src, occlusion: node?.transitionOccluder };
}
export function runCameraTransition(stage, target, { duration, transition, actionChange = false, commit, cleanup } = {}) {
  const previous = stage.currentStation ? { ...(stage.currentShot ?? {}), station: stage.currentStation, subject: stage.currentView, yaw: stage.yaw, pitch: stage.pitch } : null;
  const options = stage.transitionPreset && stage.transitionPreset !== 'auto' ? { ...normalizeTransition(transition), type: stage.transitionPreset } : transition;
  const edit = resolveCameraTransition(describe(stage, previous), describe(stage, target), options,
    { durationMs: duration ?? target.durationMs, speedFactor: stage.transitionMs / (stage.config.camera.transitionMs ?? 450), actionChange,
      reduced: stage.reduced, blurEnabled: stage.blurEnabled });
  const from = { yaw: stage.yaw, pitch: stage.pitch, hfov: stage.horizontalFov };
  if (edit.type === 'pan' && Math.hypot(nearestYaw(from.yaw, target.yaw) - from.yaw, target.pitch - from.pitch, target.hfov - from.hfov) < 1e-6) edit.durationMs = 0;
  stage.stop({ preserveStation: target.station }); stage.resolvedTransition = edit;
  if (!actionChange) stage.prepareStation(target.station);
  const intent = stage.intentId; let committed = false;
  const commitTarget = () => {
    if (!committed) { commit(); committed = true; }
    stage.yaw = edit.sameStation ? nearestYaw(stage.yaw, target.yaw) : target.yaw;
    stage.pitch = target.pitch; stage.horizontalFov = target.hfov;
  };
  if (!edit.durationMs) { commitTarget(); stage.render(); void stage.prefetchPanoramas(); return Promise.resolve({ cancelled: false }); }
  let pushStart = target.hfov * (edit.pushDirection === 'out' ? .975 : 1.025);
  if (edit.type === 'push') {
    const fit = fitViewport(stage.container.clientWidth, stage.container.clientHeight, stage.viewportSettings(target.station, pushStart));
    if (Math.abs(fit.horizontalFov - pushStart) > 1e-5 || target.pitch < fit.pitchMin || target.pitch > fit.pitchMax || !pushFitsSubject(target, pushStart)) {
      pushStart = target.hfov; edit.durationMs = 0; edit.reason = '当前取景已到安全边界，本次保持镜头稳定。';
    }
    commitTarget(); stage.horizontalFov = pushStart; stage.render();
    if (!edit.durationMs) { void stage.prefetchPanoramas(); return Promise.resolve({ cancelled: false }); }
  } else if (edit.type === 'pan') { stage.commitShot(target); }
  return new Promise(resolve => {
    const start = performance.now(), motion = { resolve, kind: edit.type === 'pan' || edit.type === 'push' ? 'rotation' : 'station', intent, targetShot: target, cleanup };
    stage.animation = motion;
    const tick = now => {
      if (stage.animation !== motion || intent !== stage.intentId) return;
      const t = clamp((now - start) / edit.durationMs, 0, 1), frame = cameraTransitionFrame(t, edit);
      if (edit.type === 'pan') {
        stage.yaw = from.yaw + (nearestYaw(from.yaw, target.yaw) - from.yaw) * frame.progress;
        stage.pitch = from.pitch + (target.pitch - from.pitch) * frame.progress;
        stage.horizontalFov = from.hfov + (target.hfov - from.hfov) * frame.progress;
      } else if (edit.type === 'push') stage.horizontalFov = pushStart + (target.hfov - pushStart) * frame.progress;
      else if (frame.incoming) commitTarget();
      // 屏幕编辑不把两个全景的经度拼成虚构路线；高清人物与背景一起短暂模糊。
      stage.blurDegrees = 0; stage.blurUniform.value = 0; paintEdit(stage, frame, edit); stage.render();
      if (stage.animation !== motion || intent !== stage.intentId) return;
      if (t < 1) stage.frameId = requestAnimationFrame(tick);
      else { commitTarget(); stage.frameId = 0; stage.animation = null; clearCameraTransition(stage); stage.render(); resolve({ cancelled: false }); void stage.prefetchPanoramas(); }
    };
    stage.frameId = requestAnimationFrame(tick);
  });
}
