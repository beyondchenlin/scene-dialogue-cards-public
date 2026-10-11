import * as THREE from '../engine/vendor/three.module.min.js';

const CACHE_LIMIT = 4;
const LOAD_TIMEOUT_MS = 20000;
const clamp = value => Math.max(0, Math.min(1, value));
const easeOut = value => 1 - (1 - clamp(value)) ** 3;
const easeInOut = value => value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
const lerp = (a, b, value) => a + (b - a) * value;
const aborted = () => Object.assign(new Error('卡牌操作已取消。'), { name: 'AbortError' });
const copyRect = rect => {
  if (!rect || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    || rect.width <= 0 || rect.height <= 0) throw new Error('卡牌显示区域无效。');
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};
const interpolateRect = (from, to, value) => ({
  left: lerp(from.left, to.left, value), top: lerp(from.top, to.top, value),
  width: lerp(from.width, to.width, value), height: lerp(from.height, to.height, value)
});

const vertexShader = `
  varying vec2 vCardUv;
  void main() {
    vCardUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const cardFragmentShader = `
  varying vec2 vCardUv;
  uniform sampler2D uMap;
  uniform vec2 uImageSize;
  uniform vec2 uCardSize;
  uniform vec3 uPaper;
  uniform vec3 uGold;
  uniform float uOpacity;
  float roundedBox(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - halfSize + vec2(radius);
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
  }
  void main() {
    vec2 p = (vCardUv - 0.5) * uCardSize;
    float radius = min(17.0, min(uCardSize.x, uCardSize.y) * 0.055);
    float edge = roundedBox(p, uCardSize * 0.5 - 0.8, radius);
    float alpha = 1.0 - smoothstep(-0.75, 0.75, edge);
    if (alpha < 0.005) discard;
    vec3 colour = uPaper;
    if (gl_FrontFacing) {
      // 图片按完整边界装入；纸边之外不裁剪人物或道具。
      // No cream inner frame: the final card follows the photograph's natural ratio.
      // Moving cards still use contain to avoid distortion as their rect changes.
      vec2 innerSize = max(vec2(1.0), uCardSize);
      float fit = min(innerSize.x / uImageSize.x, innerSize.y / uImageSize.y);
      vec2 imageSize = uImageSize * fit;
      vec2 imageUv = p / imageSize + 0.5;
      if (all(greaterThanEqual(imageUv, vec2(0.0))) && all(lessThanEqual(imageUv, vec2(1.0)))) {
        vec4 photo = texture2D(uMap, imageUv);
        colour = mix(colour, photo.rgb, photo.a);
      }
    } else {
      // 奶油纸背面仅画边框与几何花纹；说明由可访问的页面文字承载。
      float inset = min(18.0, min(uCardSize.x, uCardSize.y) * 0.065);
      float frame = roundedBox(p, uCardSize * 0.5 - inset, max(2.0, radius - 4.0));
      float rule = 1.0 - smoothstep(0.45, 1.25, abs(frame));
      float innerFrame = roundedBox(p, uCardSize * 0.5 - inset - 4.0, max(1.0, radius - 6.0));
      rule = max(rule, (1.0 - smoothstep(0.25, 0.9, abs(innerFrame))) * 0.28);
      vec2 mark = abs(p) - vec2(uCardSize.x * 0.5 - inset - 12.0, uCardSize.y * 0.5 - inset - 12.0);
      float diamond = 1.0 - smoothstep(0.45, 1.15, abs(abs(mark.x) + abs(mark.y) - 4.5));
      float grain = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      colour *= 0.988 + grain * 0.016;
      colour = mix(colour, uGold, max(rule * 0.7, diamond * 0.72));
    }
    float rim = (1.0 - smoothstep(0.5, 1.3, abs(edge + 1.1))) * 0.38;
    colour = mix(colour, uGold, rim);
    gl_FragColor = vec4(colour, alpha * uOpacity);
    #include <colorspace_fragment>
  }
`;

const shadowFragmentShader = `
  varying vec2 vCardUv;
  uniform vec2 uCardSize;
  uniform float uOpacity;
  uniform vec3 uInk;
  void main() {
    vec2 expanded = uCardSize + 48.0;
    vec2 p = (vCardUv - 0.5) * expanded;
    vec2 q = abs(p) - uCardSize * 0.5 + 14.0;
    float distanceToCard = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - 14.0;
    float shade = exp(-max(0.0, distanceToCard) / 7.0) * 0.16;
    shade *= 1.0 - smoothstep(14.0, 23.0, distanceToCard);
    gl_FragColor = vec4(uInk, shade * uOpacity);
    #include <colorspace_fragment>
  }
`;

/** 平面卡牌与短暂飞行动效。方法成功返回真，取消或降级返回假。 */
export class CardTableRenderer {
  constructor(host, { onAvailabilityChange = () => {} } = {}) {
    this.host = host;
    this.onAvailabilityChange = onAvailabilityChange;
    this.available = undefined;
    this.disposed = false;
    this.contextLost = false;
    this.epoch = 0;
    this.cache = new Map();
    this.pending = new Map();
    this.cards = new Set();
    this.display = null;
    this.animation = null;
    this.operation = null;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;visibility:hidden;';
    this.onContextLost = event => {
      event.preventDefault();
      this.unavailable(true);
    };
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.setAvailable(false);
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power'
      });
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
      this.renderer.debug.onShaderError = () => this.unavailable(true);
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 3000);
      this.camera.position.z = 1000;
      this.geometry = new THREE.PlaneGeometry(1, 1);
      host.appendChild(this.canvas);
      this.resize();
      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(host);
      }
    } catch {
      this.unavailable(true);
    }
  }

  canRender() { return Boolean(this.renderer && !this.contextLost && !this.disposed); }

  setAvailable(value) {
    this.canvas.style.visibility = value ? 'visible' : 'hidden';
    if (this.available === value) return;
    this.available = value;
    this.onAvailabilityChange(value);
  }

  unavailable(fatal = false) {
    if (fatal) {
      this.contextLost = true;
      this.operation?.controller.abort();
      this.cancelAnimation();
    }
    this.setAvailable(false);
  }

  begin(sources = []) {
    const operation = { epoch: ++this.epoch, controller: new AbortController(), sources: new Set(sources) };
    // 布局刷新只改变卡片位置时，先交接同图加载，再取消旧操作。
    // 旧调用仍会结束，但不能中止新操作正在复用的图片请求。
    for (const [src, pending] of this.pending) {
      if (operation.sources.has(src)) pending.retain(operation);
    }
    this.operation?.controller.abort();
    this.cancelAnimation();
    this.operation = operation;
    // 连续点击时，上一张牌回到已确定的终点，不留下半途悬空的旧卡。
    if (this.display) {
      this.keepOnly(this.display.card);
      this.place(this.display.card, this.display.rect, { back: this.display.back });
    }
    this.resize();
    return operation;
  }

  current(operation) {
    return this.canRender() && this.operation === operation && !operation.controller.signal.aborted;
  }

  async show({ src, rect, back = false }) {
    const operation = this.begin([src]);
    try {
      if (!this.current(operation)) return false;
      const target = copyRect(rect);
      const asset = await this.texture(src, operation);
      if (!this.current(operation)) return false;
      const card = this.makeCard(asset, 20);
      this.keepOnly(card);
      this.display = { card, src, rect: target, back: Boolean(back) };
      this.place(card, target, { back });
      return this.render();
    } catch (error) {
      if (this.current(operation) && error.name !== 'AbortError') this.unavailable();
      return false;
    }
  }

  async deal({ outgoing = null, incoming, style = 'deal', reducedMotion = false }) {
    const outgoingBack = Boolean(outgoing && this.display?.src === outgoing.src && this.display.back);
    const operation = this.begin([outgoing?.src, incoming?.src].filter(Boolean));
    try {
      if (!this.current(operation)) return false;
      const from = copyRect(incoming?.from), to = copyRect(incoming?.to);
      const outgoingFrom = outgoing ? copyRect(outgoing.from) : null;
      const outgoingTo = outgoing ? copyRect(outgoing.to) : null;
      const [newAsset, oldAsset] = await Promise.all([
        this.texture(incoming.src, operation),
        outgoing ? this.texture(outgoing.src, operation) : Promise.resolve(null)
      ]);
      if (!this.current(operation)) return false;
      const next = this.makeCard(newAsset, 40);
      const previous = oldAsset ? this.makeCard(oldAsset, 20) : null;
      this.keepOnly(next, previous);
      this.display = { card: next, src: incoming.src, rect: to, back: false };
      const duration = this.duration(style, reducedMotion);
      const direction = from.left + from.width / 2 < to.left + to.width / 2 ? -1 : 1;
      const success = await this.animate(operation, duration, progress => {
        const move = easeOut(clamp((progress - (duration ? 0.055 : 0)) / (duration ? 0.945 : 1)));
        const flourish = style === 'deal' && duration > 0;
        const arc = Math.sin(Math.PI * move);
        const nextRect = interpolateRect(from, to, move);
        nextRect.top -= arc * (flourish ? 20 : 7);
        this.place(next, nextRect, {
          rotationY: flourish ? direction * (1 - move) * 0.42 : 0,
          rotationZ: flourish ? direction * (1 - move) * 0.115 : 0,
          lift: arc * 24
        });
        if (previous) {
          const oldMove = easeInOut(clamp(progress / 0.88));
          const oldRect = interpolateRect(outgoingFrom, outgoingTo, oldMove);
          oldRect.top -= Math.sin(Math.PI * oldMove) * (flourish ? 11 : 4);
          this.place(previous, oldRect, {
            back: outgoingBack,
            rotationY: (outgoingBack ? Math.PI : 0) + (flourish ? Math.sin(Math.PI * oldMove) * 0.17 : 0),
            rotationZ: flourish ? Math.sin(Math.PI * oldMove) * -direction * 0.055 : 0,
            lift: Math.sin(Math.PI * oldMove) * 12
          });
        }
      });
      if (!success || !this.current(operation)) return false;
      this.keepOnly(next);
      this.place(next, to);
      this.trimCache();
      return this.render();
    } catch (error) {
      if (this.current(operation) && error.name !== 'AbortError') this.unavailable();
      return false;
    }
  }

  async flip({ src, rect, toBack, style = 'deal', reducedMotion = false }) {
    const wasBack = this.display?.src === src ? this.display.back : !toBack;
    const from = copyRect(this.display?.src === src ? this.display.rect : rect);
    const operation = this.begin([src]);
    try {
      if (!this.current(operation)) return false;
      const target = copyRect(rect);
      const asset = await this.texture(src, operation);
      if (!this.current(operation)) return false;
      const card = this.makeCard(asset, 40);
      this.keepOnly(card);
      this.display = { card, src, rect: target, back: Boolean(toBack) };
      const duration = wasBack === Boolean(toBack) ? 0 : this.duration(style, reducedMotion);
      const success = await this.animate(operation, duration, progress => {
        const turn = easeInOut(progress);
        const lift = duration ? Math.sin(Math.PI * progress) : 0;
        this.place(card, interpolateRect(from, target, turn), {
          rotationY: lerp(wasBack ? Math.PI : 0, toBack ? Math.PI : 0, turn),
          rotationZ: style === 'deal' ? lift * 0.018 : 0,
          lift: lift * 18,
          scale: 1 + lift * 0.012
        });
      });
      if (!success || !this.current(operation)) return false;
      this.place(card, target, { back: toBack });
      return this.render();
    } catch (error) {
      if (this.current(operation) && error.name !== 'AbortError') this.unavailable();
      return false;
    }
  }

  duration(style, reducedMotion) {
    if (reducedMotion || style === 'none' || document.hidden
      || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
    return style === 'glide' ? 360 : 470;
  }

  async texture(src, operation) {
    if (typeof src !== 'string' || !src) throw new Error('卡牌缺少图片。');
    const cached = this.cache.get(src);
    if (cached) {
      this.cache.delete(src);
      this.cache.set(src, cached);
      return cached;
    }
    let pending = this.pending.get(src);
    if (!pending) {
      pending = { operation, retain: () => {}, task: null };
      this.pending.set(src, pending);
      pending.task = new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        let signal = operation.controller.signal;
        let settled = false;
        let timer;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          img.onload = null;
          img.onerror = null;
          if (this.pending.get(src) === pending) this.pending.delete(src);
          if (error) { img.src = ''; reject(error); }
          else resolve(value);
        };
        const cancel = () => finish(aborted());
        pending.retain = next => {
          if (settled) return;
          signal.removeEventListener('abort', cancel);
          pending.operation = next;
          signal = next.controller.signal;
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
        };
        img.onload = () => {
          if (settled) return;
          if (!this.current(pending.operation)) { cancel(); return; }
          if (!img.naturalWidth || !img.naturalHeight) { finish(new Error('卡牌图片无法解码。')); return; }
          try {
            const texture = new THREE.Texture(img);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
            texture.needsUpdate = true;
            const asset = { texture, img, width: img.naturalWidth, height: img.naturalHeight };
            this.cache.set(src, asset);
            this.trimCache();
            finish(null, asset);
          } catch (error) { finish(error); }
        };
        img.onerror = () => finish(new Error('卡牌图片加载失败。'));
        timer = setTimeout(() => finish(new Error('卡牌图片加载超时。')), LOAD_TIMEOUT_MS);
        pending.retain(operation);
        if (!settled) img.src = src;
      });
      // 也清理创建图片对象等同步异常；不会把失败记录留给后续重试。
      const cleanup = () => { if (this.pending.get(src) === pending) this.pending.delete(src); };
      pending.task.then(cleanup, cleanup);
    }
    // 操作等待与图片请求分开取消：保留请求时旧调用仍立即返回取消。
    return new Promise((resolve, reject) => {
      const signal = operation.controller.signal;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(aborted());
      pending.task.then(value => finish(null, value), error => finish(error));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }

  trimCache() {
    const protectedSources = new Set([this.display?.src, ...(this.operation?.sources || [])]);
    for (const [src, asset] of this.cache) {
      if (this.cache.size <= CACHE_LIMIT) break;
      if (protectedSources.has(src)) continue;
      this.cache.delete(src);
      asset.texture.dispose();
      asset.img.src = '';
      asset.texture.image = null;
    }
  }

  makeCard(asset, order) {
    const group = new THREE.Group();
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: cardFragmentShader,
      uniforms: {
        uMap: { value: asset.texture },
        uImageSize: { value: new THREE.Vector2(asset.width, asset.height) },
        uCardSize: { value: new THREE.Vector2(1, 1) },
        uPaper: { value: new THREE.Color(0xf4efe4) },
        uGold: { value: new THREE.Color(0xa48756) },
        uOpacity: { value: 1 }
      },
      side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      forceSinglePass: true
    });
    const shadowMaterial = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: shadowFragmentShader,
      uniforms: {
        uCardSize: { value: new THREE.Vector2(1, 1) },
        uOpacity: { value: 1 }, uInk: { value: new THREE.Color(0x242019) }
      },
      side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      forceSinglePass: true
    });
    const shadow = new THREE.Mesh(this.geometry, shadowMaterial);
    const face = new THREE.Mesh(this.geometry, material);
    shadow.renderOrder = order;
    face.renderOrder = order + 1;
    group.add(shadow, face);
    this.scene.add(group);
    const card = { group, face, shadow, material, shadowMaterial };
    this.cards.add(card);
    return card;
  }

  keepOnly(...keep) {
    const retained = new Set(keep.filter(Boolean));
    for (const card of this.cards) {
      if (retained.has(card)) continue;
      this.scene.remove(card.group);
      card.material.dispose();
      card.shadowMaterial.dispose();
      this.cards.delete(card);
    }
  }

  place(card, rect, { back = false, rotationY = back ? Math.PI : 0, rotationZ = 0, lift = 0, scale = 1 } = {}) {
    if (!card || !this.bounds) return;
    card.rect = rect;
    card.pose = { back, rotationY, rotationZ, lift, scale };
    const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
    card.group.position.set(rect.left - this.bounds.left + width / 2,
      this.bounds.height - (rect.top - this.bounds.top + height / 2), 20 + lift);
    card.group.rotation.set(0, rotationY, rotationZ);
    card.group.scale.setScalar(scale);
    card.face.scale.set(width, height, 1);
    card.shadow.scale.set(width + 48, height + 48, 1);
    card.shadow.position.set(0, -(6 + lift * 0.2), -1);
    card.material.uniforms.uCardSize.value.set(width, height);
    card.shadowMaterial.uniforms.uCardSize.value.set(width, height);
  }

  animate(operation, duration, draw) {
    if (!this.current(operation)) return Promise.resolve(false);
    if (!duration) {
      draw(1);
      return Promise.resolve(this.render());
    }
    return new Promise(resolve => {
      let frame = 0;
      let settled = false;
      const started = performance.now();
      const signal = operation.controller.signal;
      const finish = success => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(frame);
        signal.removeEventListener('abort', cancel);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (this.animation?.cancel === cancel) this.animation = null;
        resolve(success);
      };
      const cancel = () => finish(false);
      const onVisibilityChange = () => {
        if (!document.hidden) return;
        if (!this.current(operation)) { finish(false); return; }
        try { draw(1); finish(this.render()); }
        catch { this.unavailable(true); finish(false); }
      };
      const tick = now => {
        if (!this.current(operation)) { finish(false); return; }
        const progress = clamp((now - started) / duration);
        try {
          draw(progress);
          if (!this.render()) { finish(false); return; }
        } catch { this.unavailable(true); finish(false); return; }
        if (progress >= 1) finish(true);
        else frame = requestAnimationFrame(tick);
      };
      this.animation = { cancel };
      signal.addEventListener('abort', cancel, { once: true });
      document.addEventListener('visibilitychange', onVisibilityChange);
      tick(started);
    });
  }

  cancelAnimation() { this.animation?.cancel(); }

  render() {
    if (!this.canRender() || !this.bounds?.width || !this.bounds?.height) {
      this.setAvailable(false);
      return false;
    }
    try {
      this.renderer.render(this.scene, this.camera);
      if (!this.canRender()) return false;
      // 只有真实图片存在且渲染完成，才通知页面撤掉图片兜底。
      if (this.display) this.setAvailable(true);
      return true;
    } catch {
      this.unavailable(true);
      return false;
    }
  }

  resize() {
    if (!this.canRender() || !this.camera) return;
    const bounds = this.host.getBoundingClientRect();
    this.bounds = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    if (!bounds.width || !bounds.height) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const sizeKey = `${bounds.width}:${bounds.height}:${ratio}`;
    if (this.sizeKey !== sizeKey) {
      this.sizeKey = sizeKey;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(bounds.width, bounds.height, false);
      this.camera.right = bounds.width;
      this.camera.top = bounds.height;
      this.camera.updateProjectionMatrix();
    }
    for (const card of this.cards) if (card.rect) this.place(card, card.rect, card.pose);
    this.render();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.operation?.controller.abort();
    this.cancelAnimation();
    this.observer?.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.keepOnly();
    this.display = null;
    for (const asset of this.cache.values()) {
      asset.texture.dispose();
      asset.img.src = '';
      asset.texture.image = null;
    }
    this.cache.clear();
    this.geometry?.dispose();
    this.renderer?.dispose();
    this.canvas.remove();
    this.setAvailable(false);
  }
}
