/** Portable card lessons contain ordinary images, with no panorama calibration. */
import { readZip, writeZip } from '../shared/zip.mjs';
import { imageDimensions } from '../shared/images.mjs';
import { safePath } from '../shared/pack.mjs';
import { validateCardLesson } from './card-state.mjs';

const MIB = 1024 * 1024;
const ARCHIVE_BYTES = 32 * MIB;
const EXPANDED_BYTES = 160 * MIB;
const IMAGE_BYTES = 12 * MIB;
const LESSON_BYTES = 2 * MIB;
// The shared ZIP reader has a 128-file limit, including lesson.json.
const FILES = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const EXTENSIONS = Object.freeze({
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp']
});

function bytesOf(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`${label}必须是二进制字节数据。`);
}

function packagePath(value) {
  if (typeof value !== 'string' || value !== value.trim()
      || /[\u007f-\u009f]/u.test(value)
      || value.split('/').some(part => part !== part.trim())) {
    throw new TypeError('图片必须使用安全的包内相对路径。');
  }
  return safePath(value);
}

function references(lesson) {
  return lesson.cards.flatMap(card => card.portraitImage === undefined
    ? [card.image] : [card.image, card.portraitImage]);
}

function archiveLimit(bytes) {
  if (bytes > ARCHIVE_BYTES) {
    throw new Error('素材压缩包不得超过 32 兆字节（按 1024 进制计算）。');
  }
}

/** Check declared budgets before any inflation; readZip still validates all ZIP records. */
function checkDeclaredBudget(bytes) {
  archiveLimit(bytes.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50
        && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('素材压缩包的尾目录不存在或已损坏。');
  const count = view.getUint16(end + 10, true);
  const start = view.getUint32(end + 16, true);
  const size = view.getUint32(end + 12, true);
  if (count > FILES) throw new Error('素材包最多包含课程文件和 127 个独立图片文件。');
  if (start + size !== end) throw new Error('素材压缩包的目录位置无效。');
  let position = start;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) {
      throw new Error('素材压缩包的目录记录无效。');
    }
    const uncompressed = view.getUint32(position + 24, true);
    const recordLength = 46 + view.getUint16(position + 28, true)
      + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    if (position + recordLength > end) throw new Error('素材压缩包的目录记录已截断。');
    if (uncompressed > IMAGE_BYTES) {
      throw new Error('单个图片文件不得超过 12 兆字节（按 1024 进制计算）。');
    }
    total += uncompressed;
    if (total > EXPANDED_BYTES) {
      throw new Error('素材包展开后不得超过 160 兆字节（按 1024 进制计算）。');
    }
    position += recordLength;
  }
  if (position !== end) throw new Error('素材压缩包的目录大小不一致。');
}

function inspectImage(path, input) {
  const bytes = bytesOf(input, `图片 ${path}`);
  if (!bytes.length || bytes.length > IMAGE_BYTES) {
    throw new Error(`图片为空或超过 12 兆字节限制：${path}`);
  }
  let metadata;
  try {
    metadata = imageDimensions(bytes);
  } catch (error) {
    throw new Error(`图片格式或内容无效：${path}。${error.message}`, { cause: error });
  }
  const extension = /\.([a-z]+)$/iu.exec(path)?.[1].toLowerCase();
  if (!EXTENSIONS[metadata.type]?.includes(extension)) {
    throw new Error(`图片扩展名与实际格式不一致，或使用了不支持的格式：${path}`);
  }
  return { bytes, ...metadata };
}

async function decodeBitmap(entry) {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('当前环境没有图片解码能力，无法确认素材完整性。');
  }
  const bitmap = await globalThis.createImageBitmap(new Blob([entry.bytes], { type: entry.type }));
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/**
 * decode({path, bytes, type, width, height}) must return decoded {width, height, type?}.
 * No lesson or image URL is exposed until every referenced image has passed decoding.
 */
export async function readCardPackage(input, { inflate, decode = decodeBitmap } = {}) {
  const bytes = bytesOf(input, '素材压缩包');
  if (typeof decode !== 'function') throw new TypeError('图片解码器必须是函数。');
  if (inflate !== undefined && typeof inflate !== 'function') throw new TypeError('解压器必须是函数。');
  checkDeclaredBudget(bytes);
  const files = await readZip(bytes, { inflate });
  const inventory = new Map();
  let expanded = 0;
  for (const file of files) {
    expanded += file.bytes.length;
    if (expanded > EXPANDED_BYTES) throw new Error('素材包展开后超过 160 兆字节限制。');
    inventory.set(packagePath(file.path), file.bytes);
  }
  const lessonBytes = inventory.get('lesson.json');
  if (!lessonBytes) throw new Error('素材包根目录缺少 lesson.json（课程文件）。');
  if (lessonBytes.length > LESSON_BYTES) throw new Error('课程文件不得超过 2 兆字节。');
  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(lessonBytes));
  } catch (error) {
    throw new Error('课程文件不是有效的字符编码或结构化数据。', { cause: error });
  }
  const lesson = validateCardLesson(parsed);
  const paths = new Set(references(lesson).map(packagePath));
  for (const path of paths) {
    if (!inventory.has(path)) throw new Error(`素材包缺少引用的图片：${path}`);
  }
  for (const path of inventory.keys()) {
    if (path !== 'lesson.json' && !paths.has(path)) {
      throw new Error(`素材包包含未被课程引用的文件：${path}`);
    }
  }
  const assets = new Map();
  for (const path of paths) assets.set(path, inspectImage(path, inventory.get(path)));
  // Decode sequentially to keep bitmap memory bounded and always release it in the decoder.
  for (const [path, asset] of assets) {
    let actual;
    try {
      actual = await decode({ path, ...asset });
    } catch (error) {
      throw new Error(`图片解码失败：${path}。${error.message}`, { cause: error });
    }
    if (!actual || actual.width !== asset.width || actual.height !== asset.height
        || (actual.type !== undefined && actual.type !== asset.type)) {
      throw new Error(`图片解码尺寸或格式与文件内容不一致：${path}`);
    }
  }
  return { lesson, assets };
}

/** Export a detached lesson and exact source image bytes in a self-contained stored ZIP. */
export async function writeCardPackage(input, readAsset) {
  const lesson = validateCardLesson(input);
  if (typeof readAsset !== 'function') throw new TypeError('图片读取器必须是函数。');
  if (encoder.encode(JSON.stringify(lesson)).length > LESSON_BYTES) {
    throw new Error('课程文件不得超过 2 兆字节。');
  }
  const paths = [...new Set(references(lesson))];
  if (paths.length + 1 > FILES) throw new Error('素材包最多包含 127 个独立图片文件。');
  const renamed = new Map();
  const files = [];
  let imageBytes = 0;
  for (const [index, src] of paths.entries()) {
    const originalBytes = bytesOf(await readAsset(src), `图片 ${src}`);
    const metadata = inspectImage(src, originalBytes);
    const bytes = originalBytes.slice();
    imageBytes += bytes.length;
    // writeZip stores original bytes; this lower bound prevents oversized allocation.
    archiveLimit(imageBytes);
    const path = `assets/${String(index + 1).padStart(3, '0')}.${EXTENSIONS[metadata.type][0]}`;
    renamed.set(src, path);
    files.push({ path, bytes });
  }
  for (const card of lesson.cards) {
    card.image = renamed.get(card.image);
    if (card.portraitImage !== undefined) card.portraitImage = renamed.get(card.portraitImage);
  }
  const lessonBytes = encoder.encode(`${JSON.stringify(lesson, null, 2)}\n`);
  if (lessonBytes.length > LESSON_BYTES) throw new Error('课程文件不得超过 2 兆字节。');
  files.unshift({ path: 'lesson.json', bytes: lessonBytes });
  const storedSize = 22 + files.reduce((total, file) =>
    total + 76 + 2 * encoder.encode(file.path).length + file.bytes.length, 0);
  archiveLimit(storedSize);
  return writeZip(files);
}
