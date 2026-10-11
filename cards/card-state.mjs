/** Pure lesson validation and progress state; rendering and audio live elsewhere. */

const SCHEMA = 'scene-dialogue-cards';
const SHOT_SIZES = new Set(['wide', 'medium', 'close']);
const MODES = new Set(['watch', 'type']);
const BUILTIN_ASSET_PREFIX = '../compact/assets/';

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象。`);
  }
  return value;
}

function text(value, label, { singleLine = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label}必须是非空文字。`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
      || (singleLine && /[\r\n\u2028\u2029]/u.test(value))) {
    throw new TypeError(`${label}包含不支持的控制字符或换行。`);
  }
  return value.trim();
}

function imagePath(value, label) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`${label}必须是安全的相对图片路径。`);
  }
  let path = value.trim();
  if (!path || /[\\:%?#]/u.test(path) || path.startsWith('/')) {
    throw new TypeError(`${label}只允许相对路径，不接受网址、编码路径或反斜杠。`);
  }
  if (path.startsWith('./')) path = path.slice(2);
  const localPath = path.startsWith(BUILTIN_ASSET_PREFIX)
    ? path.slice(BUILTIN_ASSET_PREFIX.length)
    : path;
  if (!localPath || localPath.split('/').some(part => !part || part === '.' || part === '..'
      || part !== part.trim() || part.endsWith('.'))) {
    throw new TypeError(`${label}包含无效目录或越界路径。`);
  }
  return path;
}

/** Ignore case, width, punctuation and apostrophe style while preserving words. */
export function normalizeAnswer(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/gu, '')
    .replace(/['‘’`´]/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

/** Return a detached, known-field-only lesson; malformed lessons throw TypeError. */
export function validateCardLesson(input) {
  const value = record(input, '课程');
  if (value.schema !== SCHEMA || value.version !== 1) {
    throw new TypeError('课程格式或版本不受支持。');
  }
  if (!Array.isArray(value.cards) || value.cards.length < 1 || value.cards.length > 100) {
    throw new TypeError('课程必须包含一至一百张镜头卡。');
  }
  const ids = new Set();
  const lesson = {
    schema: SCHEMA,
    version: 1,
    id: text(value.id, '课程编号', { singleLine: true }),
    title: text(value.title, '课程标题', { singleLine: true }),
    description: text(value.description, '课程介绍'),
    sourceNote: text(value.sourceNote, '素材来源说明'),
    cards: Array.from(value.cards, (item, index) => {
      const label = `第${index + 1}张卡片`;
      const card = record(item, label);
      const id = text(card.id, `${label}编号`, { singleLine: true });
      if (ids.has(id)) throw new TypeError('卡片编号必须各不相同。');
      ids.add(id);
      if (!SHOT_SIZES.has(card.shotSize)) {
        throw new TypeError(`${label}景别必须是全景、中景或近景。`);
      }
      const explanation = record(card.explanation, `${label}解释`);
      const clean = {
        id,
        speaker: text(card.speaker, `${label}人物`, { singleLine: true }),
        english: text(card.english, `${label}英文台词`, { singleLine: true }),
        translation: text(card.translation, `${label}中文翻译`),
        shotSize: card.shotSize,
        image: imagePath(card.image, `${label}图片`),
        alt: text(card.alt, `${label}画面说明`),
        explanation: {
          meaning: text(explanation.meaning, `${label}句意`),
          usage: text(explanation.usage, `${label}用法`),
          focus: text(explanation.focus, `${label}学习重点`),
          example: text(explanation.example, `${label}例句`),
          exampleTranslation: text(explanation.exampleTranslation, `${label}例句翻译`)
        }
      };
      if (!normalizeAnswer(clean.english)) {
        throw new TypeError(`${label}英文台词必须包含文字或数字。`);
      }
      if (card.portraitImage !== undefined) {
        clean.portraitImage = imagePath(card.portraitImage, `${label}竖屏图片`);
      }
      return clean;
    })
  };
  return lesson;
}

function freezeLesson(lesson) {
  for (const card of lesson.cards) {
    Object.freeze(card.explanation);
    Object.freeze(card);
  }
  Object.freeze(lesson.cards);
  return Object.freeze(lesson);
}

/** Mutators report acceptance with a boolean; submit reports { correct, reason }. */
export class CardLessonState {
  #index = 0;
  #focusIndex = 0;
  #flipped = false;
  #completed = false;
  #visitedIds = new Set();
  #practiceDoneIds = new Set();
  #mode = 'watch';

  constructor(lesson) {
    Object.defineProperty(this, 'lesson', {
      value: freezeLesson(validateCardLesson(lesson)), enumerable: true
    });
  }

  snapshot() {
    return {
      index: this.#index,
      focusIndex: this.#focusIndex,
      reviewing: this.#focusIndex !== this.#index,
      flipped: this.#flipped,
      completed: this.#completed,
      visitedIds: [...this.#visitedIds],
      practiceDoneIds: [...this.#practiceDoneIds],
      mode: this.#mode
    };
  }

  next() {
    if (this.#completed || this.#focusIndex !== this.#index) return false;
    const card = this.lesson.cards[this.#index];
    if (this.#mode === 'type' && !this.#practiceDoneIds.has(card.id)) return false;
    this.#visitedIds.add(card.id);
    this.#flipped = false;
    if (this.#index === this.lesson.cards.length - 1) {
      this.#completed = true;
    } else {
      this.#index++;
      this.#focusIndex = this.#index;
    }
    return true;
  }

  /** Focus can move only to the current card or an already unlocked history slot. */
  open(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.lesson.cards.length
        || (!this.#completed && index > this.#index)) return false;
    this.#focusIndex = index;
    this.#flipped = false;
    return true;
  }

  previousFocus() {
    return this.open(this.#focusIndex - 1);
  }

  returnToProgress() {
    this.#focusIndex = this.#index;
    this.#flipped = false;
    return true;
  }

  flip() {
    this.#flipped = !this.#flipped;
    return true;
  }

  restart() {
    this.#index = 0;
    this.#focusIndex = 0;
    this.#flipped = false;
    this.#completed = false;
    this.#visitedIds.clear();
    this.#practiceDoneIds.clear();
    return true;
  }

  setMode(mode) {
    if (!MODES.has(mode)) return false;
    this.#mode = mode;
    return true;
  }

  submit(answer) {
    if (this.#mode !== 'type') return { correct: false, reason: 'wrong-mode' };
    if (this.#focusIndex !== this.#index) return { correct: false, reason: 'reviewing' };
    if (this.#completed) return { correct: false, reason: 'completed' };
    const normalized = normalizeAnswer(answer);
    if (!normalized) return { correct: false, reason: 'empty' };
    const card = this.lesson.cards[this.#index];
    if (normalized !== normalizeAnswer(card.english)) return { correct: false, reason: 'mismatch' };
    this.#practiceDoneIds.add(card.id);
    return { correct: true, reason: 'correct' };
  }
}
