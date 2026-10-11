import { createRearCameraRequirements } from './rear-camera-rules.mjs';
import { validTransition, validTransitionDuration, verifiedOccluder } from '../engine/camera-transitions.mjs';
import { counterOcclusionRegions } from '../engine/shot-plans.js';
/** Portable Scene Dialogue Pack v1. This module has no Node or browser dependencies. */
export const PACK_FORMAT = 'scene-dialogue-pack';
export const PACK_VERSION = 1;
export const STATION_SLOTS = ['overview', 'behind_role_a', 'behind_role_b'];
export const LEGACY_STATION_SLOTS = [...STATION_SLOTS, 'left', 'right'];
export const SUPPORTED_STATION_COUNTS = Object.freeze([3, 5]);
export const LAYERS = ['body', 'medium', 'portrait'];
export const SIZES = ['full', 'medium', 'close'];
export const LIMITS = Object.freeze({ files: 128, fileBytes: 64 * 1024 * 1024, totalBytes: 384 * 1024 * 1024, manifestBytes: 2 * 1024 * 1024, imagePixels: 50_000_000, lines: 300 });
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
export const clone = value => JSON.parse(JSON.stringify(value));
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\\x00-\x1f\x7f:%?#]/.test(value) || value.startsWith('/')) throw new Error(`不安全的包内路径：${String(value).slice(0, 100)}`);
  const path = value.startsWith('./') ? value.slice(2) : value;
  if (!path || path.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' ') || p === '__proto__' || p === 'constructor' || p === 'prototype')) throw new Error(`不安全的包内路径：${value}`);
  return path;
}
export function safeId(id) { if (typeof id !== 'string' || !ID.test(id) || id.includes('__') || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('ID 仅可使用 1–64 位英文字母、数字、横线和单下划线，不能包含双下划线。'); return id; }
export function assetRecords(pack) {
  return Object.entries(pack?.scene?.stations ?? {}).flatMap(([station, node]) => [
    ...(node?.panorama ? [{ ...node.panorama, station, role: null, layer: 'panorama', slot: `${station}/panorama` }] : []),
    ...(Array.isArray(node?.details) ? node.details.map(a => ({ ...a, station, role: a?.subject, slot: `${station}/${a?.subject}/${a?.layer}` })) : [])
  ]);
}
export function expectedSlots(pack) {
  return (Array.isArray(pack?.stationOrder) ? pack.stationOrder : []).flatMap(station => [{ station, role: null, layer: 'panorama', slot: `${station}/panorama` }, ...(Array.isArray(pack?.roles) ? pack.roles : []).flatMap(role => LAYERS.map(layer => ({ station, role: role?.id, layer, slot: `${station}/${role?.id}/${layer}` }))) ]);
}
export function requiredImageCount(pack) {
  return expectedSlots(pack ?? { stationOrder: STATION_SLOTS, roles: [{ id: 'role_a' }, { id: 'role_b' }] }).length;
}
export function canonicalFilename(station, role, layer, ext = 'jpg') {
  safeId(station); if (role) safeId(role);
  if (!['panorama', ...LAYERS].includes(layer) || !['jpg','jpeg','png','webp'].includes(ext)) throw new Error('未知素材类型。');
  return `assets/${station}__${role ? `${role}__` : ''}${layer}.${ext}`;
}
/** Filenames classify slots, never establish a camera, UV transform, or anatomical bounds. */
export function classifyFilenames(paths) {
  const records = [], unknown = [], bySlot = new Map();
  for (const path of paths) {
    const name = safePath(path).split('/').at(-1);
    if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
    const ext = /\.(jpe?g|png|webp)$/i.exec(name);
    const parts = name.slice(0, -ext[0].length).split('__');
    const station = parts[0], role = parts.length === 3 ? parts[1] : null, layer = parts.at(-1).toLowerCase();
    if (!ID.test(station) || role && !ID.test(role) || !(parts.length === 2 && layer === 'panorama' || parts.length === 3 && LAYERS.includes(layer))) { unknown.push(path); continue; }
    const item = { path, station, role, layer, slot: `${station}/${role ? `${role}/` : ''}${layer}` };
    records.push(item); bySlot.set(item.slot, [...(bySlot.get(item.slot) ?? []), path]);
  }
  return { records, unknown, duplicates: [...bySlot].filter(([, v]) => v.length > 1).map(([slot, paths]) => ({ slot, paths })), calibrated: false,
    message: '文件名只能确定机位／角色／图层。缺少 scene-pack.json 中的相机内参、人物范围和对位记录；图片数量不能代替空间标定。' };
}
export function normalizeDocument(raw, supplemental = null) {
  if (raw?.format === PACK_FORMAT) return clone(raw);
  if (raw?.projection === 'equirectangular' && plain(raw.stations)) {
    const supplied = Array.isArray(supplemental) ? { dialogue: supplemental } : (supplemental ?? {});
    return { format: PACK_FORMAT, version: PACK_VERSION, id: supplied.id ?? raw.id ?? 'imported-scene', title: supplied.title ?? raw.title ?? '未命名场景',
      roles: supplied.roles ?? raw.roles ?? [], stationOrder: supplied.stationOrder ?? Object.keys(raw.stations), scene: clone(raw),
      dialogue: clone(supplied.dialogue ?? raw.dialogue ?? []) };
  }
  return clone(raw);
}
function bounds(value) { return plain(value) && ['yawMin','yawMax','pitchMin','pitchMax'].every(k => finite(value[k])) && value.yawMax > value.yawMin && value.yawMax - value.yawMin < 180 && value.pitchMax > value.pitchMin && value.pitchMin > -90 && value.pitchMax < 90; }
function point(p) { return plain(p) && finite(p.yaw) && finite(p.pitch) && Math.abs(p.pitch) < 90; }
function findUnsafeValues(value, path, add, depth = 0) {
  if (depth > 40) { add('manifest-depth', path, '元数据嵌套过深。'); return; }
  if (typeof value === 'string' && /^(?:file:|[A-Za-z]:[\\/]|\/(?:workspace|home|Users|tmp|root|mnt)\/)/.test(value)) add('local-path', path, '包中含本地绝对路径；发布前请移除来源机器路径。');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__','constructor','prototype'].includes(key)) add('unsafe-key', `${path}.${key}`, '禁止原型相关键名。');
    else findUnsafeValues(child, `${path}.${key}`, add, depth + 1);
  }
}
/** Structural validation; supplied inventory also checks exact measured file dimensions. */
export function validatePack(pack, inventory = null) {
  const errors = [], warnings = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  const warn = (code, path, message) => warnings.push({ code, path, message });
  if (!plain(pack)) return { valid: false, errors: [{ code:'manifest', path:'', message:'清单必须是 JSON 对象。' }], warnings, assetCount:0, baseAssetCount:0, actionAssetCount:0, rows:[] };
  if (pack.format !== PACK_FORMAT || pack.version !== PACK_VERSION) add('version', 'format/version', '需要 scene-dialogue-pack 版本 1 清单。');
  try { safeId(pack.id); } catch (e) { add('id', 'id', e.message); }
  if (typeof pack.title !== 'string' || !pack.title.trim() || pack.title.length > 200) add('title', 'title', '请填写 1–200 字的场景标题。');
  const roles = Array.isArray(pack.roles) ? pack.roles : [];
  if (roles.length !== 2) add('roles', 'roles', '基础包必须定义两位主要角色。');
  const roleIds = roles.map(r => r?.id);
  if (new Set(roleIds).size !== roles.length) add('duplicate-role', 'roles', '角色 ID 重复。');
  for (const [i, r] of roles.entries()) { try { safeId(r?.id); } catch (e) { add('role-id', `roles[${i}]`, e.message); } if (typeof r?.label !== 'string' || !r.label.trim() || r.label.length > 80) add('role-label', `roles[${i}]`, '角色需要显示名称。'); }
  const order = Array.isArray(pack.stationOrder) ? pack.stationOrder : [];
  const stations = plain(pack.scene?.stations) ? pack.scene.stations : {};
  if (!SUPPORTED_STATION_COUNTS.includes(order.length) || new Set(order).size !== order.length || Object.keys(stations).length !== order.length || order.some(s => !Object.hasOwn(stations, s))) add('stations', 'stationOrder', '支持 3 个机位的当前方案或 5 个机位的旧素材包；机位不得重复，且必须与场景机位表完全一致。');
  if (pack.scene?.projection !== 'equirectangular') add('projection', 'scene.projection', '全景投影必须是 equirectangular。');
  if (!order.includes(pack.scene?.initialStation) || !roleIds.includes(pack.scene?.initialView)) add('initial-view', 'scene', '初始机位或角色不存在。');
  const camera = pack.scene?.camera;
  if (!plain(camera) || !['pitchMin','pitchMax','maxVerticalFov'].every(k => finite(camera[k])) || camera.pitchMin >= camera.pitchMax || camera.pitchMin <= -90 || camera.pitchMax >= 90 || camera.maxVerticalFov <= 0 || camera.maxVerticalFov >= 180) add('camera', 'scene.camera', '缺少有效的相机范围标定。');
  const records = assetRecords(pack), paths = new Map(), slots = new Map(), detailIds = new Set();
  for (const [id, node] of Object.entries(stations)) {
    try { safeId(id); } catch (e) { add('station-id', `scene.stations.${id}`, e.message); }
    if (typeof node?.label !== 'string' || !node.label.trim()) add('station-label', id, '机位需要显示名称。');
    if (node?.transitionOccluder != null && !verifiedOccluder({ station: id, assetSrc: node.panorama?.src, occlusion: node.transitionOccluder })) add('transition-occluder', id, '条件遮挡必须引用此机位已核验的原图与有效前景裁切范围。');
    if (!plain(node?.limits) || !finite(node.limits.latitudeMin) || !finite(node.limits.latitudeMax) || node.limits.latitudeMin >= node.limits.latitudeMax || node.limits.latitudeMin <= -90 || node.limits.latitudeMax >= 90) add('latitude-band', id, '需要标定过的安全纬度范围。');
    if (Object.keys(node?.subjects ?? {}).length !== 2 || roleIds.some(r => !Object.hasOwn(node?.subjects ?? {}, r))) add('subjects', id, '此机位必须包含两位声明的角色。');
    for (const role of roleIds) {
      const person = node?.subjects?.[role], where = `${id}/${role}`;
      if (!point(person?.anchor) || !bounds(person?.headBounds)) add('subject-calibration', where, '缺少人物锚点或头部角度范围标定。');
      if (typeof person?.faceVisible !== 'boolean' || typeof person?.bodyVisible !== 'boolean') add('visibility', where, '需明确记录脸部与身体是否可见。');
      if (person?.foreground && !roleIds.includes(person.foreground)) add('foreground', where, '前景角色不存在。');
      for (const preset of ['full','natural','close']) {
        const size = person?.sizes?.[preset];
        if (!plain(size) || !(finite(size.vfov) || finite(size.hfov))) add('lens-calibration', `${where}/${preset}`, '缺少此景别的标定视场角。');
      }
      const fullMode = person?.sizes?.full?.bodyMode;
      if (Object.values(person?.sizes ?? {}).some(size => ['context', 'visible'].includes(size?.bodyMode))) {
        if (!counterOcclusionRegions(person)) add('occlusion-geometry', where, '遮挡轮廓、完整上下文或实测边界不满足相机几何要求。');
        const v = person?.bodyVisibility;
        if (!v || v.status !== 'counter_occluded' || v.occluder !== 'service_counter' || v.feetVisible !== false || person.bodyVisible !== false || v.measurementStatus !== 'measured_native_source' || !/^[0-9a-f]{64}$/i.test(v.sourceSha256 ?? '') || !Array.isArray(v.visibleRegions) || !v.visibleRegions.length || typeof v.waistVisible !== 'boolean') add('occlusion-evidence', where, '遮挡景别必须记录原生图实测证据与可见部位。');
        if (!bounds(person.visibleBodyBounds) || !Array.isArray(person.occlusionBoundary) || person.occlusionBoundary.length < 2 || !person.occlusionBoundary.every(point)) add('occlusion-bounds', where, '遮挡模式需要可见身体范围和至少两点遮挡边界。');
        if (fullMode === 'context' && !bounds(person.fullContextBounds)) add('context-bounds', where, '全景遮挡模式需要身体与吧台的完整上下文范围。');
        if (person.bodyBounds || person.feetPoints?.length) add('invented-body', where, '腿脚被遮挡时不能声明全身范围或脚部点。');
        if (v?.waistVisible === false && person.waistBounds) add('invented-waist', where, '腰部被遮挡时不能声明腰部范围。');
      } else if (fullMode === 'full' && (person?.bodyVisible !== true || !bounds(person?.bodyBounds) || !Array.isArray(person.feetPoints) || person.feetPoints.length < 2 || !person.feetPoints.every(point))) add('full-body-calibration', where, '全身景别需要真实可见全身范围与脚部点。');
    }
  }
  for (const a of records) {
    slots.set(a.slot, (slots.get(a.slot) ?? 0) + 1);
    let path; try { path = safePath(a.src); } catch (e) { add('asset-path', a.slot, e.message); continue; }
    const key = path.toLowerCase(); paths.set(key, (paths.get(key) ?? 0) + 1);
    if (!/\.(jpe?g|png|webp)$/i.test(path)) add('asset-type', path, '运行图片仅支持 JPEG、PNG、WebP。');
    if (![a.width,a.height].every(n => Number.isInteger(n) && n > 0) || a.width * a.height > LIMITS.imagePixels) add('dimensions', path, '需要真实像素尺寸，单图最多 5000 万像素。');
    if (a.layer === 'panorama') { if (a.width !== 2 * a.height) add('panorama-ratio', path, '等距柱状全景必须是 2:1。'); }
    else {
      if (!roleIds.includes(a.subject) || !LAYERS.includes(a.layer)) add('detail-slot', path, '高清图角色或图层类型不在协议中。');
      if (typeof a.id !== 'string' || !a.id || detailIds.has(a.id)) add('detail-id', path, '高清图 ID 缺失或重复。'); detailIds.add(a.id);
      const c = a.capture;
      if (!plain(c) || c.station !== a.station || !point(c) || ![c.width,c.height].every(n => finite(n) && n > 0) || !((finite(c.fx) && c.fx > 0 && finite(c.fy) && c.fy > 0 && finite(c.cx) && finite(c.cy)) || (finite(c.hfov) && c.hfov > 0 && c.hfov < 180))) add('capture-calibration', path, '缺少此机位的捕获角度、尺寸与相机内参。');
      const m = a.uvTransform;
      if (!Array.isArray(m) || m.length !== 9 || !m.every(finite) || Math.abs(m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6])) < 1e-12) add('registration', path, '高清图需要有效的 3×3 UV 对位矩阵；不得省略标定。');
    }
  }
  for (const [path, count] of paths) if (count > 1) add('duplicate-path', path, `素材路径被使用 ${count} 次；每个基础素材槽必须使用独立图片。`);
  for (const [slot, count] of slots) if (count > 1) add('duplicate-slot', slot, `此素材槽重复 ${count} 次。`);
  const rows = expectedSlots(pack).map(slot => ({ ...slot, count: slots.get(slot.slot) ?? 0, asset: records.find(a => a.slot === slot.slot) ?? null }));
  for (const row of rows) if (!row.count) add('missing-slot', row.slot, '缺少对应素材。');
  const expectedCount = requiredImageCount(pack);
  if (records.length !== expectedCount) add('asset-count', 'scene.stations', `当前 ${order.length} 个机位需要 ${expectedCount} 张基础素材，目前声明 ${records.length} 张。`);
  const lines = Array.isArray(pack.dialogue) ? pack.dialogue : [];
  if (!lines.length || lines.length > LIMITS.lines) add('dialogue', 'dialogue', '需要 1–300 句对话。');
  const lineIds = new Set();
  for (const [index,line] of lines.entries()) {
    const where = `dialogue[${index}]`;
    try { safeId(line?.id); } catch (e) { add('line-id', where, e.message); }
    if (lineIds.has(line?.id)) add('duplicate-line', where, '对话 ID 重复。'); lineIds.add(line?.id);
    if (!roleIds.includes(line?.speaker)) add('speaker', where, '说话角色不存在。');
    if (typeof line?.text !== 'string' || !line.text.trim() || line.text.length > 2000) add('line-text', where, '每句正文需要 1–2000 字。');
    if (line?.translation != null && (typeof line.translation !== 'string' || line.translation.length > 2000)) add('translation', where, '译文不能超过 2000 字。');
    const s = line?.shot;
    if (!plain(s)) { add('shot', where, '每句必须保存明确的镜头计划。'); continue; }
    if (!order.includes(s.station) || !roleIds.includes(s.subject) || !SIZES.includes(s.size) || !['left','centre','right'].includes(s.composition) || !['up','level','down'].includes(s.tilt)) add('shot-reference', where, '镜头的机位、人物、景别、构图或俯仰不合法。');
    if (!validTransitionDuration(s.durationMs, s.transition) || !Number.isInteger(s.holdMs) || s.holdMs < 300 || s.holdMs > 30000) add('shot-duration', where, '直接切镜时长为0；新预设需80–1200毫秒，旧方案兼容100–5000毫秒；停留需300–30000毫秒。');
    if (!validTransition(s.transition)) add('shot-transition', where, '转场预设、速度、曲线或推拉方向不合法；旧版转场仍需完整有效的参数。');
    if (s.subject !== line.speaker) warn('reaction-shot', where, '镜头拍摄另一位角色；将保留你的反应镜头安排。');
    if (stations[s.station]?.subjects?.[s.subject]?.faceVisible === false) warn('back-view', where, '此镜头角色面部不可见；背影将如实保留。');
  }
  findUnsafeValues(pack, 'pack', add);
  if (inventory) {
    const fileMap = new Map();
    for (const file of inventory) {
      let path; try { path = safePath(file.path); } catch (e) { add('file-path', '', e.message); continue; }
      if (fileMap.has(path.toLowerCase())) add('duplicate-file', path, '导入文件路径重复（不区分大小写）。');
      fileMap.set(path.toLowerCase(), file);
    }
    for (const a of records) {
      let path; try { path = safePath(a.src); } catch { continue; }
      const found = fileMap.get(path.toLowerCase());
      if (!found) { add('missing-file', path, '找不到清单引用的图片。'); continue; }
      if (found.path !== path) add('path-case', path, '文件路径大小写必须与清单完全一致。');
      if (found.error) add('image-decode', path, found.error);
      else if (found.width !== a.width || found.height !== a.height) add('dimension-mismatch', path, `实测 ${found.width}×${found.height}，清单 ${a.width}×${a.height}。`);
    }
    const referenced = new Set(records.map(a => { try{return safePath(a.src).toLowerCase();}catch{return '';} }));
    for (const file of inventory) if (/\.(jpe?g|png|webp)$/i.test(file.path) && !referenced.has(file.path.toLowerCase())) warn('unused-image', file.path, '额外图片不属于清单声明的运行素材，导出时不会包含。');
  }
  return { valid: !errors.length, errors, warnings, assetCount: records.length, baseAssetCount: records.length, actionAssetCount: 0, rows };
}
export function portablePack(pack) {
  const result = clone(pack);
  for (const node of Object.values(result.scene?.stations ?? {})) {
    if (node.panorama) node.panorama.src = safePath(node.panorama.src);
    for (const detail of node.details ?? []) detail.src = safePath(detail.src);
  }
  return result;
}
export function createDialogueDraft({ id = 'new-scene', title = '新的场景', roleLabels = ['角色一', '角色二'], text = '' } = {}) {
  safeId(id);
  const roles = roleLabels.map((label, i) => ({ id: i ? 'role_b' : 'role_a', label: label.trim() || `角色${i+1}` }));
  const dialogue = text.split(/\r?\n/).filter(s => s.trim()).slice(0, LIMITS.lines).map((s, i) => {
    const split = s.indexOf('：') >= 0 ? s.indexOf('：') : s.indexOf(':');
    const prefix = split >= 0 ? s.slice(0, split).trim() : '';
    const role = roles.find(r => r.label === prefix || r.id === prefix);
    return { id: `line_${String(i + 1).padStart(3,'0')}`, speaker: role?.id ?? roles[i % 2].id, text: (role ? s.slice(split+1) : s).trim(), translation: '' };
  });
  return { format: PACK_FORMAT, version: 1, id, title, roles, stationOrder: [...STATION_SLOTS], dialogue,
    generationRequest: { schemaVersion: 1, requiredImageCount: STATION_SLOTS.length * (1 + roles.length * LAYERS.length), stationSlots: [...STATION_SLOTS], requiredLayers: [...LAYERS], requiresMeasuredCalibration: true, rearCamera: createRearCameraRequirements({ roles, stationOrder: STATION_SLOTS }) } };
}


/** A generation request follows the opened draft, including intact legacy packs. */
export function createGenerationRequest(pack) {
  if (!pack || !Array.isArray(pack.roles) || pack.roles.length !== 2 || !Array.isArray(pack.stationOrder)
      || !SUPPORTED_STATION_COUNTS.includes(pack.stationOrder.length) || new Set(pack.stationOrder).size !== pack.stationOrder.length) {
    throw new Error('生成需求需要两位角色，以及三个机位或旧版五个机位。');
  }
  safeId(pack.id); pack.roles.forEach(role => safeId(role.id)); pack.stationOrder.forEach(safeId);
  const station = pack.stationOrder[0], role = pack.roles[0].id;
  return { format: 'scene-dialogue-generation-request', version: 1, id: pack.id, title: pack.title,
    roles: clone(pack.roles), stationOrder: [...pack.stationOrder], dialogue: clone(pack.dialogue ?? []),
    requiredImageCount: requiredImageCount(pack), requiredPanoramaCount: pack.stationOrder.length,
    requiredDetailCount: pack.stationOrder.length * pack.roles.length * LAYERS.length,
    requiredManifest: 'scene-pack.json', requirements: { nativeDimensions: true, calibratedCapture: true,
      uvRegistration: true, measuredSubjectBounds: true, noInventedHiddenAnatomy: true },
    rearCamera: createRearCameraRequirements(pack),
    filenameExamples: [canonicalFilename(station, null, 'panorama'), ...LAYERS.map(layer => canonicalFilename(station, role, layer))] };
}
