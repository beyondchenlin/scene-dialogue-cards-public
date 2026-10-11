import { CardLessonState, validateCardLesson } from './card-state.mjs';
import { CardTableRenderer } from './card-renderer.mjs';
import { readCardPackage, writeCardPackage } from './card-package.mjs';
import { visibleViewport } from '../engine/viewport-layout.js';

const $ = id => document.getElementById(id);
const app = $('app'), table = $('table'), slot = $('image-slot'), picture = $('card-image');
const grid = $('memory-grid'), back = $('card-back'), answer = $('answer');
const settings = $('settings-dialog'), about = $('about-dialog');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const shotNames = { wide: '全景', medium: '中景', close: '近景' };
let state, lesson, renderer, busy = true, importBusy = false;
let orientation = innerWidth < innerHeight ? 'portrait' : 'landscape';
let lastViewportDirection = orientation, inputGroupFocused = false, forceLayout = false;
let graphicsReady = false, layoutDirty = false, resizeFrame = 0, disposed = false;
let assetUrls = new Map(), importedAssets = new Map(), drafts = new Map(), recordings = new Map();
let speechEpoch = 0, sequenceEpoch = 0, playing = false, speechFinish = null;
let micEpoch = 0, micPending = false, micFinalizing = false, micStream = null, recorder = null, recordingTimer = 0;
let imageEpoch = 0, transitionEpoch = 0;
let pendingMemoryFocus = null;
let swipeStart = null;
const thumbnailPortrait = () => innerWidth >= innerHeight || innerWidth > 1100;
// Cache the actual dimensions of decoded photographs, including imported lessons.
const imageRatios = new Map();

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const focused = () => lesson.cards[state.snapshot().focusIndex];
const imagePath = card => orientation === 'portrait' && card.portraitImage ? card.portraitImage : card.image;
const assetUrl = src => assetUrls.get(src) || new URL(src, location.href).href;
const currentSrc = () => assetUrl(imagePath(focused()));
function currentImageRatio() {
  // The first viewport measurement runs before the example lesson is loaded.
  if (!lesson || !state) return orientation === 'portrait' ? 3 / 4 : 16 / 9;
  const src = currentSrc();
  // Never reuse the preceding photo's dimensions while the new shot is loading.
  if (picture.currentSrc === src && picture.naturalWidth > 0 && picture.naturalHeight > 0) {
    return picture.naturalWidth / picture.naturalHeight;
  }
  return imageRatios.get(src) || (orientation === 'portrait' && focused().portraitImage ? 3 / 4 : 16 / 9);
}
const rect = element => {
  const value = element.getBoundingClientRect();
  return { left: value.left, top: value.top, width: value.width, height: value.height };
};
const micActive = () => micPending || micFinalizing || recorder?.state === 'recording' || recorder?.state === 'paused';
const reduced = () => $('reduce-motion').checked || motionPreference.matches;
const pad = value => String(value).padStart(2, '0');

function feedback(message, tone = '', source = 'general') {
  $('feedback').textContent = message;
  $('feedback').className = `feedback ${tone}`;
  $('feedback').dataset.source = source;
}

function setLayoutMode(viewport = visibleViewport(window)) {
  app.dataset.layout = state?.snapshot().flipped ? 'reading'
    : viewport.width >= 560 && viewport.height <= 560 ? 'split' : 'stack';
}

function memoryRect(index) {
  const item = grid.querySelector(`[data-index="${index}"]`);
  if (!item) return rect($('deck-anchor'));
  const photo = item.querySelector('img') || item.querySelector('.blank-card') || item;
  const area = photo.getBoundingClientRect(), viewport = grid.getBoundingClientRect(), bounds = table.getBoundingClientRect();
  if (area.left < Math.max(viewport.left, bounds.left) || area.right > Math.min(viewport.right, bounds.right)
    || area.top < Math.max(viewport.top, bounds.top) || area.bottom > Math.min(viewport.bottom, bounds.bottom)) return rect($('deck-anchor'));
  return rect(photo);
}

function revealMemory(index) {
  const item = grid.querySelector(`[data-index="${index}"]`);
  if (!item) return;
  const box = item.getBoundingClientRect(), view = grid.getBoundingClientRect();
  if (box.left < view.left + 8) grid.scrollLeft += box.left - view.left - 8;
  else if (box.right > view.right - 8) grid.scrollLeft += box.right - view.right + 8;
}

function fitActiveCard() {
  const play = $('play-area'), stage = table.querySelector('.stage-column'), zone = $('focus-zone');
  const playBounds = play.getBoundingClientRect(), style = getComputedStyle(zone);
  const playStyle = getComputedStyle(play), split = app.dataset.layout === 'split';
  const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  // The answer area takes its readable size first; the picture fits the remaining space.
  const gap = parseFloat(playStyle.rowGap) || 0;
  const learningHeight = table.querySelector('.learning-panel').getBoundingClientRect().height;
  const roomHeight = split ? playBounds.height : playBounds.height - learningHeight - gap;
  const width = Math.max(1, stage.getBoundingClientRect().width - paddingX);
  const height = Math.max(1, roomHeight - paddingY);
  const card = $('active-card');
  if (app.dataset.layout === 'reading') {
    // The explanation needs a readable page, independent of the photo's ratio.
    const cardHeight = Math.min(height, 560);
    stage.style.height = `${cardHeight + paddingY}px`;
    card.style.width = `${Math.min(width, 680)}px`; card.style.height = `${cardHeight}px`;
    return;
  }
  const viewport = visibleViewport(window), phone = viewport.width <= 690;
  const ratio = currentImageRatio();
  // Cap the desired size before fitting; shrinking the remaining area again would
  // make a phone's picture unusable after the rail and input have grown.
  const targetWidth = split ? 260 : orientation === 'portrait'
    ? Math.min(phone ? 228 : 320, viewport.height * (phone ? .235 : .265))
    : Math.min(840, viewport.height * .58);
  const cardWidth = Math.min(width, height * ratio, targetWidth);
  stage.style.height = split ? '100%' : `${cardWidth / ratio + paddingY}px`;
  card.style.width = `${cardWidth}px`; card.style.height = `${cardWidth / ratio}px`;
}

function measureViewport() {
  const viewport = visibleViewport(window);
  for (const [key, value] of Object.entries(viewport)) app.style.setProperty(`--visual-${key}`, `${value}px`);
  // VisualViewport shrinks on real soft keyboards without necessarily changing innerHeight.
  // Reserve space for a usable answer field; compact the rail/photo rather than scrolling the page.
  app.dataset.keyboard = String(document.activeElement === answer
    && (innerHeight - viewport.height >= Math.max(100, innerHeight * 0.16)
      || viewport.height <= 470));
  app.dataset.short = String(viewport.height <= 560);
  setLayoutMode(viewport);
  const active = document.activeElement;
  if (active?.closest('#practice-form')) inputGroupFocused = true;
  else if (!active?.closest('.control-dock')) inputGroupFocused = false;
  if (state && (state.snapshot().mode !== 'type' || state.snapshot().completed || state.snapshot().flipped)) inputGroupFocused = false;
  app.dataset.inputFocus = String(inputGroupFocused);
  // A smaller visible height while typing is a keyboard, not a new card direction.
  const direction = innerWidth < innerHeight ? 'portrait' : 'landscape';
  if (!inputGroupFocused && !micActive() && direction !== lastViewportDirection) {
    lastViewportDirection = direction;
    orientation = direction; table.classList.toggle('portrait', orientation === 'portrait');
    if (state) renderUI({ scheduleLayout: false });
  }
  fitActiveCard();
}

function makeRenderer() {
  renderer?.dispose();
  renderer = new CardTableRenderer($('render-layer'), {
    onAvailabilityChange(value) {
      graphicsReady = value;
      slot.classList.toggle('rendered', value);
      $('render-status').textContent = value ? '立体卡牌动效已就绪' : '当前使用静态图片，学习操作仍然可用。';
      app.dataset.renderer = value ? 'webgl' : 'static';
    }
  });
}

function renderGrid() {
  const s = state.snapshot(), scroll = grid.scrollLeft;
  const focusedButton = grid.contains(document.activeElement) ? document.activeElement.closest('[data-index]')?.dataset.index : null;
  if (focusedButton !== null && focusedButton !== undefined) pendingMemoryFocus = Number(focusedButton);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < lesson.cards.length; index++) {
    const card = lesson.cards[index], unlocked = s.visitedIds.includes(card.id);
    const verticalThumb = thumbnailPortrait();
    if (!unlocked) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'memory-card'; button.dataset.index = String(index);
    button.disabled = busy || importBusy || micActive();
    button.classList.toggle('locked', !unlocked);
    button.classList.toggle('current', index === s.index && !s.completed);
    button.classList.toggle('focused', index === s.focusIndex && unlocked);
    button.classList.toggle('portrait-thumb', verticalThumb);
    button.setAttribute('aria-label', `第${index + 1}镜，${unlocked ? card.speaker + '，' + shotNames[card.shotSize] : '尚未解锁'}`);
    if (index === s.focusIndex) button.setAttribute('aria-current', 'true');
    if (unlocked) {
      const img = document.createElement('img');
      img.src = assetUrl(verticalThumb ? (card.portraitImage || card.image) : card.image);
      img.alt = '';
      img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false; button.append(img);
    } else {
      const blank = document.createElement('div'); blank.className = 'blank-card'; blank.textContent = pad(index + 1); button.append(blank);
    }
    const label = document.createElement('div'); label.className = 'memory-name';
    const name = document.createElement('span'); name.textContent = unlocked ? card.speaker : '等待登场';
    const number = document.createElement('b'); number.textContent = pad(index + 1);
    label.append(name, number); button.append(label); fragment.append(button);
  }
  grid.replaceChildren(fragment); grid.scrollLeft = scroll;
  if (pendingMemoryFocus !== null && !busy && !importBusy && !micActive()) {
    const target = grid.querySelector(`[data-index="${pendingMemoryFocus}"]`);
    if (target && !target.disabled) target.focus({ preventScroll: true });
    pendingMemoryFocus = null;
  }
  $('memory-count').textContent = `${s.visitedIds.length} 张已看`;
  app.dataset.archived = String(s.visitedIds.length);
}

function updateImage() {
  const token = ++imageEpoch, card = focused(), src = currentSrc();
  $('image-error').hidden = true;
  picture.alt = card.alt;
  $('scene-backdrop').style.backgroundImage = `url(${JSON.stringify(src)})`;
  picture.onload = () => {
    if (token !== imageEpoch) return;
    $('image-error').hidden = true;
    // Match the outer card to the original photo ratio; never crop characters or scenery.
    const ratio = picture.naturalWidth / picture.naturalHeight;
    if (Number.isFinite(ratio) && ratio > 0 && imageRatios.get(src) !== ratio) {
      imageRatios.set(src, ratio);
      queueLayout();
    }
  };
  picture.onerror = () => {
    if (token !== imageEpoch) return;
    $('image-error').hidden = state.snapshot().flipped;
    slot.classList.remove('rendered');
    feedback('这张图片加载失败。可重新加载，或继续查看其他镜头。', 'error');
  };
  if (picture.src !== src) picture.src = src;
  else if (picture.complete && !picture.naturalWidth) picture.onerror();
}

function renderUI({ image = true, scheduleLayout = true } = {}) {
  if (!state) return;
  const s = state.snapshot(), card = focused(), locked = busy || importBusy || micActive();
  app.dataset.index = String(s.index); app.dataset.focus = String(s.focusIndex);
  app.dataset.mode = s.mode; app.dataset.completed = String(s.completed);
  app.dataset.flipped = String(s.flipped); setLayoutMode();
  if (s.flipped) { inputGroupFocused = false; app.dataset.inputFocus = 'false'; }
  app.setAttribute('aria-busy', String(busy || importBusy));
  table.classList.toggle('table-busy', busy); table.classList.toggle('finishing', s.completed);
  table.classList.toggle('portrait', orientation === 'portrait');
  table.classList.toggle('portrait-fallback', orientation === 'portrait' && !card.portraitImage);
  $('lesson-title').firstChild.textContent = lesson.title;
  $('lesson-description').textContent = lesson.description;
  $('source-note').textContent = lesson.sourceNote;
  const count = document.createElement('span'); count.textContent = `/ ${pad(lesson.cards.length)}`;
  $('progress-number').replaceChildren(document.createTextNode(pad(s.index + 1) + ' '), count);
  $('progress-caption').textContent = s.completed ? '全部已看' : '当前进度';
  $('progress-fill').style.width = `${(s.completed ? lesson.cards.length : s.index + 1) / lesson.cards.length * 100}%`;
  $('card-number').textContent = `镜头 ${pad(s.focusIndex + 1)}`;
  $('shot-label').textContent = shotNames[card.shotSize];
  $('card-speaker').textContent = card.speaker;
  $('card-english').textContent = card.english;
  $('card-translation').textContent = card.translation;
  $('card-translation').hidden = !$('show-translation').checked;
  $('back-meaning').textContent = card.explanation.meaning;
  $('back-usage').textContent = card.explanation.usage;
  $('back-focus').textContent = card.explanation.focus;
  $('back-example').textContent = card.explanation.example;
  $('back-example-translation').textContent = card.explanation.exampleTranslation;
  back.hidden = !s.flipped;
  const flipLabel = s.flipped ? '翻回画面' : '翻牌看解释';
  $('flip-label').textContent = flipLabel; $('flip-button').setAttribute('aria-label', flipLabel); $('flip-button').title = flipLabel;
  $('flip-button').disabled = locked;
  $('viewing-label').textContent = s.reviewing ? '回看中，进度保留' : s.completed ? '故事已收齐' : '正在学习';
  $('review-notice').hidden = !s.reviewing;
  $('return-button').disabled = locked;
  $('watch-mode').setAttribute('aria-pressed', String(s.mode === 'watch'));
  $('type-mode').setAttribute('aria-pressed', String(s.mode === 'type'));
  $('watch-mode').disabled = $('type-mode').disabled = locked;
  $('practice-form').hidden = s.mode !== 'type' || s.reviewing || s.completed || s.flipped;
  answer.disabled = $('check-answer').disabled = locked;
  const passed = s.practiceDoneIds.includes(card.id);
  $('next-button').disabled = locked || s.completed || s.reviewing || (s.mode === 'type' && !passed);
  $('next-button').firstElementChild.textContent = s.index === lesson.cards.length - 1 ? '收齐' : '下一张';
  $('next-button').setAttribute('aria-label', s.index === lesson.cards.length - 1 ? '收好最后一张' : '收好这张，进入下一镜');
  // The card gallery uses gestures, drag and arrow keys; no terminal next/restart UI.
  $('next-button').hidden = true;
  $('autoplay-button').hidden = s.completed;
  $('autoplay-button').disabled = (locked && !playing) || s.mode === 'type' || s.reviewing;
  const playLabel = playing ? '暂停连续播放' : '连续播放';
  $('autoplay-label').textContent = playLabel; $('autoplay-button').setAttribute('aria-label', playLabel); $('autoplay-button').title = playLabel;
  $('autoplay-button').classList.toggle('playing', playing);
  $('listen-button').disabled = locked;
  $('speech-rate').disabled = locked;
  $('record-button').disabled = busy || importBusy || micFinalizing || (!micActive() && s.completed);
  const recordLabel = micFinalizing ? '保存录音' : micPending ? '取消话筒' : micActive() ? '结束录音' : '录一遍跟读';
  $('record-label').textContent = recordLabel; $('record-button').setAttribute('aria-label', recordLabel); $('record-button').title = recordLabel;
  $('record-button').parentElement.classList.toggle('recording', micActive());
  $('record-caption').textContent = micActive() ? '请先结束录音再换镜' : '仅在本页回放';
  $('recording-audio').hidden = !recordings.has(card.id) || micActive();
  if (recordings.has(card.id) && $('recording-audio').src !== recordings.get(card.id)) $('recording-audio').src = recordings.get(card.id);
  $('landscape-button').disabled = $('portrait-button').disabled = locked || s.flipped;
  $('landscape-button').setAttribute('aria-pressed', String(orientation === 'landscape'));
  $('portrait-button').setAttribute('aria-pressed', String(orientation === 'portrait'));
  $('motion-style').disabled = $('reduce-motion').disabled = locked;
  $('package-file').disabled = $('download-package').disabled = locked;
  $('reset-course').disabled = $('restart-button').disabled = $('restore-example').disabled = locked;
  $('completion').hidden = true;
  $('restart-button').hidden = true;
  $('completion-copy').textContent = s.practiceDoneIds.length ? `你已看完 ${lesson.cards.length} 镜，并输入答对 ${s.practiceDoneIds.length} 句。` : '点开任意一张卡，再回味一句。';
  $('shot-context').textContent = orientation === 'portrait' && !card.portraitImage ? '原图完整显示 · 人物与道具保留' : `${shotNames[card.shotSize]} · 一张画面，一句对白。`;
  renderGrid();
  if (image) updateImage();
  fitActiveCard();
  if (scheduleLayout) queueLayout();
}

function saveDraft() { if (state && !state.snapshot().reviewing) drafts.set(focused().id, answer.value); }
function restoreDraft() { answer.value = drafts.get(focused().id) || ''; }

function stopSpeech() {
  speechEpoch++;
  speechFinish?.(false); speechFinish = null;
  globalThis.speechSynthesis?.cancel();
  table.classList.remove('audio-active');
  $('recording-audio').pause();
}

function stopSequence() {
  sequenceEpoch++; playing = false; stopSpeech();
  if (state) renderUI({ image: false });
}


/** Swipe/drag/arrow navigation is circular and never discards correct-answer records. */
async function browse(direction, { automatic = false } = {}) {
  if (!state || state.snapshot().flipped || busy || importBusy || micActive()) return false;
  if (document.activeElement === answer) answer.blur();
  return navigate(() => state.browse(direction), { kind: 'swipe', swipeDirection: direction, automatic });
}

function swipeAllowed(event) {
  if (!state || busy || importBusy || micActive() || state.snapshot().flipped
      || settings.open || about.open || !event.isPrimary) return false;
  if (event.pointerType === 'mouse' && event.button !== 0) return false;
  if (event.target.closest('button,a,input,textarea,select,audio,[role="button"]')) return false;
  return true;
}
for (const surface of [$('focus-zone'), document.querySelector('.card-caption')]) {
  surface.addEventListener('pointerdown', event => {
    if (!swipeAllowed(event)) return;
    swipeStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      startedAt: performance.now(), surface };
  }, { passive: true });
}
window.addEventListener('pointerup', event => {
  if (!swipeStart || swipeStart.pointerId !== event.pointerId) return;
  const origin = swipeStart; swipeStart = null;
  if (!state || state.snapshot().flipped || busy || importBusy || micActive()) return;
  const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.35
      || performance.now() - origin.startedAt > 1250) return;
  // Left drags move forward; right drags move back, with both ends linked.
  event.preventDefault();
  void browse(dx < 0 ? 1 : -1);
}, { passive: false });
window.addEventListener('pointercancel', () => { swipeStart = null; }, { passive: true });

async function navigate(action, { kind = 'next', automatic = false, swipeDirection = 1 } = {}) {
  if (busy || importBusy || micActive()) return false;
  if (!automatic) stopSequence(); else stopSpeech();
  saveDraft();
  const previous = focused(), oldIndex = state.snapshot().focusIndex, oldSource = currentSrc(), oldRect = rect(slot);
  if (!action()) return false;
  const token = ++transitionEpoch;
  busy = true; restoreDraft(); renderUI();
  if (kind === 'next' || kind === 'swipe') revealMemory(oldIndex);
  else if (['review', 'return'].includes(kind)) revealMemory(state.snapshot().focusIndex);
  await nextFrame();
  if (disposed || token !== transitionEpoch) return false;
  const nextIndex = state.snapshot().focusIndex;
  try {
    if (kind === 'swipe') {
      const swapped = await renderer.fan({
        outgoing: { src: oldSource, rect: oldRect },
        incoming: { src: currentSrc(), rect: rect(slot) },
        direction: swipeDirection,
        style: $('motion-style').value,
        reducedMotion: reduced()
      });
      if (!swapped && !reduced()) {
        const dir = swipeDirection > 0 ? 1 : -1;
        await $('active-card').animate([
          { opacity: 0.55, transform: `translateX(${dir * 38}px) rotate(${dir * 11}deg)` },
          { opacity: 1, transform: 'translateX(0) rotate(0)' }
        ], { duration: 270, easing: 'cubic-bezier(.17,.78,.26,1)' }).finished.catch(() => {});
      }
    } else if (oldIndex !== nextIndex || kind === 'next') {
      await renderer.deal({
        outgoing: { src: oldSource, from: oldRect, to: memoryRect(oldIndex) },
        incoming: { src: currentSrc(), from: ['review', 'return'].includes(kind) ? memoryRect(nextIndex) : state.snapshot().completed ? rect(slot) : rect($('deck-anchor')), to: rect(slot) },
        style: $('motion-style').value, reducedMotion: reduced()
      });
    } else {
      await renderer.show({ src: currentSrc(), rect: rect(slot), back: state.snapshot().flipped });
    }
  } finally {
    if (token === transitionEpoch && !disposed) {
      busy = false; renderUI({ image: false });
      const s = state.snapshot();
      feedback(s.reviewing ? `正在回看第${s.focusIndex + 1}镜，学习进度仍在第${s.index + 1}镜。` : s.completed ? '这一段已看完。看过与输入答对分别记录。' : '听清这一句，再按自己的节奏进入下一镜。');
      if (layoutDirty) refreshLayout();
      const upcoming = lesson.cards[s.index + 1];
      if (upcoming) { const image = new Image(); image.src = assetUrl(imagePath(upcoming)); }
    }
  }
  return previous.id !== focused().id || state.snapshot().completed;
}

async function flipCard() {
  if (busy || importBusy || micActive()) return;
  stopSequence(); state.flip(); busy = true; renderUI({ image: false });
  if (state.snapshot().flipped) back.querySelector('.explanation-scroll').scrollTop = 0;
  try { await renderer.flip({ src: currentSrc(), rect: rect(slot), toBack: state.snapshot().flipped, style: $('motion-style').value, reducedMotion: reduced() }); }
  finally {
    busy = false; renderUI({ image: false }); if (layoutDirty) refreshLayout();
    if (!disposed) (state.snapshot().flipped ? back.querySelector('.explanation-scroll') : $('flip-button')).focus({ preventScroll: true });
  }
}

async function refreshLayout({ immediate = false } = {}) {
  if (!state || disposed) return;
  fitActiveCard();
  if (busy && !immediate) { layoutDirty = true; return; }
  layoutDirty = false;
  renderer.resize();
  await renderer.show({ src: currentSrc(), rect: rect(slot), back: state.snapshot().flipped });
}

function queueLayout({ immediate = false } = {}) {
  forceLayout ||= immediate;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0; const now = forceLayout; forceLayout = false;
    measureViewport(); void refreshLayout({ immediate: now });
  });
}

function changeOrientation(value) {
  if (busy || importBusy || micActive() || state.snapshot().flipped || orientation === value) return;
  stopSequence(); saveDraft(); orientation = value;
  table.classList.toggle('portrait', value === 'portrait'); renderUI();
  // renderUI already schedules the resized card. A second show here would
  // cancel that operation while the same image is still loading.
}

function say(card) {
  stopSpeech();
  if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) {
    feedback('当前浏览器不支持语音听读。你仍可看图、输入和手动换镜。', 'error');
    return Promise.resolve(false);
  }
  const voices = speechSynthesis.getVoices().filter(voice => /^en(?:[-_]|$)/i.test(voice.lang));
  if (!voices.length) {
    feedback('当前浏览器没有可用的英语语音。请在支持英语语音的浏览器中听读。', 'error');
    return Promise.resolve(false);
  }
  const token = ++speechEpoch;
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(card.english);
    utterance.lang = voices[0].lang; utterance.voice = voices[0]; utterance.rate = Number($('speech-rate').value);
    let done = false;
    const finish = ok => {
      if (done) return; done = true; clearTimeout(timer);
      utterance.onend = utterance.onerror = null;
      if (speechFinish === finish) speechFinish = null;
      if (token === speechEpoch) { table.classList.remove('audio-active'); if (ok) feedback('听完了。你可以跟读一遍，再进入下一镜。'); }
      resolve(ok && token === speechEpoch);
    };
    const timer = setTimeout(() => {
      if (token !== speechEpoch) return finish(false);
      feedback('浏览器语音没有完成播放，请重试或手动换镜。', 'error'); finish(false); speechSynthesis.cancel();
    }, Math.max(15000, card.english.length * 280));
    speechFinish = finish;
    utterance.onend = () => finish(true);
    utterance.onerror = () => {
      if (token === speechEpoch) feedback('这句语音播放失败，请重试或手动换镜。', 'error');
      finish(false);
    };
    table.classList.add('audio-active'); feedback('正在听这一句…');
    speechSynthesis.speak(utterance);
  });
}

async function runSequence() {
  if (playing) { stopSequence(); feedback('已暂停，当前镜头保留。'); return; }
  if (busy || importBusy || micActive() || state.snapshot().mode !== 'watch' || state.snapshot().reviewing || state.snapshot().completed) return;
  const token = ++sequenceEpoch; playing = true; renderUI({ image: false });
  while (playing && token === sequenceEpoch && !disposed) {
    const spoken = await say(focused());
    if (!spoken || token !== sequenceEpoch) break;
    await new Promise(resolve => setTimeout(resolve, 650));
    if (!playing || token !== sequenceEpoch) break;
    await browse(1, { automatic: true });
  }
  if (token === sequenceEpoch) { playing = false; renderUI({ image: false }); }
}

function closeMicrophone() {
  clearTimeout(recordingTimer);
  if (recorder?.state === 'recording' || recorder?.state === 'paused') { micFinalizing = true; recorder.stop(); }
  micStream?.getTracks().forEach(track => track.stop());
  micStream = null;
  if (state && !disposed) renderUI({ image: false });
}

async function toggleRecording() {
  if (micFinalizing) return;
  if (micPending) {
    micEpoch++; micPending = false; renderUI({ image: false });
    feedback('已取消等待。稍后到达的话筒授权不会开启录音。'); return;
  }
  if (micActive()) { closeMicrophone(); return; }
  if (busy || importBusy) return;
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    feedback('当前浏览器不支持本页录音。你可以继续听读和输入练习。', 'error'); return;
  }
  stopSequence(); micPending = true; const token = ++micEpoch, cardId = focused().id;
  renderUI({ image: false }); feedback('请允许使用话筒。录音只在本页回放。');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (token !== micEpoch || disposed) { stream.getTracks().forEach(track => track.stop()); return; }
    micStream = stream; micPending = false;
    const supported = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    const current = new MediaRecorder(stream, supported ? { mimeType: supported } : undefined);
    recorder = current;
    const chunks = []; let bytes = 0, failed = false;
    current.ondataavailable = event => {
      if (event.data.size && token === micEpoch) { chunks.push(event.data); bytes += event.data.size; if (bytes > 20 * 1024 * 1024) closeMicrophone(); }
    };
    current.onerror = () => { failed = true; closeMicrophone(); feedback('录音失败，请检查话筒后重试。', 'error'); };
    current.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (recorder === current) { clearTimeout(recordingTimer); recorder = null; micFinalizing = false; }
      if (micStream === stream) micStream = null;
      if (token !== micEpoch || disposed) { if (!disposed && state) renderUI({ image: false }); return; }
      if (!failed && chunks.length) {
        if (recordings.has(cardId)) URL.revokeObjectURL(recordings.get(cardId));
        recordings.set(cardId, URL.createObjectURL(new Blob(chunks, { type: current.mimeType || chunks[0].type })));
        feedback('跟读已录好。点播放听听自己的表达；本页不上传、不评分。', 'success');
      } else if (!failed) feedback('没有收到录音内容，请再试一次。', 'error');
      renderUI({ image: false });
    };
    current.start(250);
    recordingTimer = setTimeout(() => { closeMicrophone(); }, 60000);
    renderUI({ image: false }); feedback('正在录音。说完后点“结束录音”，最长一分钟。');
  } catch {
    if (token !== micEpoch || disposed) return;
    closeMicrophone(); micPending = false; micFinalizing = false; recorder = null;
    renderUI({ image: false }); feedback('没有取得话筒权限或话筒不可用。请检查浏览器权限后重试。', 'error');
  }
}

async function installLesson(input, assets = new Map()) {
  const clean = validateCardLesson(input);
  const nextUrls = new Map();
  try { for (const [src, asset] of assets) nextUrls.set(src, URL.createObjectURL(new Blob([asset.bytes], { type: asset.type }))); }
  catch (error) { for (const url of nextUrls.values()) URL.revokeObjectURL(url); throw error; }
  stopSequence(); closeMicrophone(); micEpoch++;
  renderer?.dispose();
  for (const url of assetUrls.values()) URL.revokeObjectURL(url);
  for (const url of recordings.values()) URL.revokeObjectURL(url);
  assetUrls = nextUrls; importedAssets = assets; drafts = new Map(); recordings = new Map();
  pendingMemoryFocus = null;
  state = new CardLessonState(clean); lesson = state.lesson; answer.value = '';
  $('recording-audio').removeAttribute('src'); $('recording-audio').load();
  $('restore-example').hidden = !assets.size;
  makeRenderer(); renderUI(); document.title = `${lesson.title} · 镜头卡牌`;
  measureViewport();
  await nextFrame();
  busy = true; renderUI({ image: false });
  await renderer.deal({ incoming: { src: currentSrc(), from: rect($('deck-anchor')), to: rect(slot) }, style: $('motion-style').value, reducedMotion: reduced() });
  busy = false; renderUI({ image: false });
  feedback(`第一张卡已到手。左右滑动换镜，${lesson.cards.length} 张卡可循环。`);
}

async function loadExample() {
  const response = await fetch(new URL('lesson.json', import.meta.url));
  if (!response.ok) throw new Error('示例课程读取失败。');
  await installLesson(await response.json());
}

async function importPackage(file) {
  if (!file || busy || importBusy || micActive()) return;
  stopSequence(); importBusy = true; renderUI({ image: false });
  $('import-status').textContent = '正在检查课程和全部图片…';
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error('故事包不能超过32兆字节。');
    const result = await readCardPackage(await file.arrayBuffer());
    await installLesson(result.lesson, result.assets);
    $('import-status').textContent = `已导入“${lesson.title}”，共${lesson.cards.length}张卡。`;
  } catch (error) {
    $('import-status').textContent = `没有替换当前故事：${error.message}`;
  } finally { importBusy = false; $('package-file').value = ''; renderUI({ image: false }); }
}

async function downloadPackage() {
  if (busy || importBusy || micActive()) return;
  importBusy = true; renderUI({ image: false }); $('import-status').textContent = '正在打包当前故事与图片…';
  try {
    const bytes = await writeCardPackage(lesson, async src => {
      if (importedAssets.has(src)) return importedAssets.get(src).bytes;
      const response = await fetch(assetUrl(src));
      if (!response.ok) throw new Error('图片读取失败，未导出不完整素材包。');
      return new Uint8Array(await response.arrayBuffer());
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const link = document.createElement('a'); link.href = url; link.download = '镜头故事包.zip'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('import-status').textContent = '完整故事包已交给浏览器下载，可在本页重新导入。';
  } catch (error) { $('import-status').textContent = error.message; }
  finally { importBusy = false; renderUI({ image: false }); }
}

async function restart() {
  if (busy || importBusy || micActive()) return;
  stopSequence(); drafts.clear(); answer.value = '';
  await navigate(() => state.restart(), { kind: 'restart' });
  answer.value = ''; feedback('回到第一张。再慢慢走一遍这段故事。');
}

$('next-button').addEventListener('click', () => void navigate(() => state.next()));
$('flip-button').addEventListener('click', () => void flipCard());
$('return-button').addEventListener('click', () => void navigate(() => state.returnToProgress(), { kind: 'return' }));
grid.addEventListener('click', event => {
  const button = event.target.closest('button[data-index]');
  if (button && !button.disabled) void navigate(() => state.open(Number(button.dataset.index)), { kind: 'review' });
});
for (const [id, mode] of [['watch-mode', 'watch'], ['type-mode', 'type']]) $(id).addEventListener('click', () => {
  if (busy || importBusy || micActive()) return;
  stopSequence(); saveDraft(); state.setMode(mode); renderUI({ image: false }); restoreDraft();
  feedback(mode === 'type' ? '输入英文可检查准确度，也可以随时左右滑动换镜。' : '左右滑动换镜，翻牌可看解释。');
});
answer.addEventListener('input', () => {
  saveDraft();
  if ($('feedback').dataset.source === 'answer') feedback('');
});
$('practice-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || importBusy || micActive()) return;
  saveDraft(); const result = state.submit(answer.value);
  renderUI({ image: false });
  feedback(result.correct ? '这一句输入正确。左右滑动可切换镜头。' : result.reason === 'empty' ? '先输入这一句，再来检查。' : '还差一点。对照原句检查单词，不必修改大小写和标点。', result.correct ? 'success' : 'error', 'answer');
});
$('listen-button').addEventListener('click', () => { if (busy || importBusy || micActive()) return; stopSequence(); void say(focused()); });
$('autoplay-button').addEventListener('click', () => void runSequence());
$('speech-rate').addEventListener('change', () => { stopSequence(); feedback('语速已更新，下次听读使用这个速度。'); });
$('record-button').addEventListener('click', () => void toggleRecording());
$('recording-audio').addEventListener('play', () => { sequenceEpoch++; playing = false; speechEpoch++; speechFinish?.(false); globalThis.speechSynthesis?.cancel(); table.classList.remove('audio-active'); renderUI({ image: false }); });
$('landscape-button').addEventListener('click', () => void changeOrientation('landscape'));
$('portrait-button').addEventListener('click', () => void changeOrientation('portrait'));
$('show-translation').addEventListener('change', () => renderUI({ image: false }));
$('reduce-motion').checked = motionPreference.matches;
motionPreference.addEventListener('change', () => { $('system-motion').textContent = motionPreference.matches ? '设备已开启减少动画，卡牌立即切换。' : '跟随设备的减少动画偏好'; });
$('settings-button').addEventListener('click', () => { stopSequence(); settings.showModal(); });
$('about-button').addEventListener('click', () => { stopSequence(); settings.close(); about.showModal(); });
$('package-file').addEventListener('change', event => void importPackage(event.target.files[0]));
$('download-package').addEventListener('click', () => void downloadPackage());
$('restart-button').addEventListener('click', () => void restart());
$('reset-course').addEventListener('click', () => { settings.close(); void restart(); });
$('restore-example').addEventListener('click', async () => {
  if (busy || importBusy || micActive()) return;
  importBusy = true; renderUI({ image: false });
  try { await loadExample(); $('import-status').textContent = '已回到咖啡店示例。'; }
  catch (error) { $('import-status').textContent = error.message; }
  finally { importBusy = false; renderUI({ image: false }); }
});
$('retry-image').addEventListener('click', async () => {
  if (busy || importBusy || micActive()) return;
  picture.removeAttribute('src'); updateImage(); await refreshLayout();
});
$('reload-button').addEventListener('click', () => location.reload());
window.addEventListener('resize', () => queueLayout({ immediate: true }), { passive: true });
window.addEventListener('scroll', () => queueLayout({ immediate: true }), { passive: true });
window.visualViewport?.addEventListener('resize', () => queueLayout({ immediate: true }), { passive: true });
window.visualViewport?.addEventListener('scroll', () => queueLayout({ immediate: true }), { passive: true });
document.addEventListener('focusin', () => queueLayout());
document.addEventListener('focusout', () => queueLayout());
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  $('fullscreen-button').setAttribute('aria-pressed', String(active));
  $('fullscreen-button').setAttribute('aria-label', active ? '退出全屏' : '进入全屏');
  $('fullscreen-button').title = active ? '退出全屏' : '进入全屏';
  queueLayout({ immediate: true });
});
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else feedback('当前浏览器不支持全屏，页面已自动适应可见区域。', 'notice');
  } catch { feedback('暂时无法进入全屏，学习进度已保留。', 'notice'); }
});
new ResizeObserver(queueLayout).observe(slot);
document.addEventListener('keydown', event => {
  if (!state || event.repeat || event.altKey || event.ctrlKey || event.metaKey || settings.open || about.open) return;
  if (state.snapshot().flipped && event.key === 'Escape') { event.preventDefault(); void flipCard(); return; }
  if (event.target.closest('input,textarea,select,button,a,audio')) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); void flipCard(); return; }
  // Keep arrow keys available for scrolling the focused explanation.
  if (state.snapshot().flipped) return;
  if (event.key === 'ArrowRight') { event.preventDefault(); void browse(1); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); void browse(-1); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopSequence(); if (micPending) { micEpoch++; micPending = false; } closeMicrophone(); if (state) renderUI({ image: false }); } });
window.addEventListener('pagehide', event => {
  stopSequence(); micEpoch++; micPending = false; closeMicrophone();
  if (event.persisted) { if (state) renderUI({ image: false }); return; }
  disposed = true; transitionEpoch++; renderer?.dispose();
  cancelAnimationFrame(resizeFrame);
  for (const url of [...assetUrls.values(), ...recordings.values()]) URL.revokeObjectURL(url);
});
window.addEventListener('pageshow', event => { if (event.persisted) { renderUI({ image: false }); queueLayout(); } });

measureViewport();
try { await loadExample(); }
catch (error) { app.hidden = true; $('fatal-error').hidden = false; $('fatal-message').textContent = error.message; }
