import {JPEG_BACKGROUND, JPEG_QUALITY, mimeTypeFor, normalizeOutputFormat} from '../shared/formats.js';
import { validateOutput } from '../shared/limits.js';
import { ERROR_CODE, MESSAGE, OUTPUT_FORMAT } from '../shared/protocol.js';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class ComposerSession {
  constructor({ createCanvas, decodeImage, createObjectURL, revokeObjectURL }) {
    this.createCanvas = createCanvas;
    this.decodeImage = decodeImage;
    this.createObjectURL = createObjectURL;
    this.revokeObjectURL = revokeObjectURL;
    this.canvas = null;
    this.context = null;
    this.objectUrl = null;
    this.state = 'idle';
    this.generation = 0;
  }

  async begin({ cssWidth, cssHeight, firstDataUrl, innerWidth, innerHeight }) {
    this.#requireState('begin', 'idle');
    const generation = ++this.generation;
    this.state = 'beginning';
    let bitmap;
    try {
      bitmap = await this.decodeImage(firstDataUrl);
      this.#requireGeneration(generation);
      // innerWidth/innerHeight 必须是**标签页视口**尺寸（captureVisibleTab 的截图范围），
      // 不是内部滚动容器的尺寸；cssWidth/cssHeight 则是选区的视觉尺寸。
      const scaleX = bitmap.width / innerWidth;
      const scaleY = bitmap.height / innerHeight;
      const width = Math.round(cssWidth * scaleX);
      const height = Math.round(cssHeight * scaleY);
      const validation = validateOutput(width, height);
      if (!validation.ok) {
        throw codedError(ERROR_CODE.OUTPUT_TOO_LARGE, `Output is too large: ${validation.reason}`);
      }

      const canvas = this.createCanvas(width, height);
      canvas.width = width;
      canvas.height = height;
      this.#requireGeneration(generation);
      this.canvas = canvas;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Unable to create 2D canvas context');
      this.#requireGeneration(generation);
      // 输出格式在截图完成后才由用户选择，所以拼接画布统一铺白底：
      // JPEG 不支持透明通道（不铺白底会发黑），网页截图本身也基本不透明。
      context.fillStyle = JPEG_BACKGROUND;
      context.fillRect(0, 0, width, height);
      this.#requireGeneration(generation);
      this.context = context;
      this.state = 'begun';
      return { scaleX, scaleY, width, height };
    } catch (error) {
      if (generation === this.generation) {
        this.#clearResources();
        this.state = 'failed';
      }
      throw error;
    } finally {
      bitmap?.close?.();
    }
  }

  async add({ dataUrl, placement }) {
    this.#requireState('add', 'begun');
    const generation = this.generation;
    this.state = 'adding';
    let bitmap;
    try {
      bitmap = await this.decodeImage(dataUrl);
      this.#requireGeneration(generation);
      if (this.state !== 'adding') throw new Error('Composer operation invalidated');
      const { sx, sy, sw, sh, dx, dy, dw, dh } = placement;
      this.context.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
      this.#requireGeneration(generation);
      if (this.state !== 'adding') throw new Error('Composer operation invalidated');
      this.state = 'begun';
    } catch (error) {
      if (generation === this.generation && this.state === 'adding') this.state = 'failed';
      throw error;
    } finally {
      bitmap?.close?.();
    }
  }

  finish(format) {
    try {
      this.#requireState('finish', 'begun');
    } catch (error) {
      return Promise.reject(error);
    }
    const generation = this.generation;
    const canvas = this.canvas;
    const outputFormat = normalizeOutputFormat(format);
    this.state = 'finishing';
    return new Promise((resolve, reject) => {
      const fail = error => {
        if (generation === this.generation && this.state === 'finishing') this.state = 'failed';
        reject(error);
      };
      const onBlob = blob => {
        try {
          this.#requireGeneration(generation);
          if (this.state !== 'finishing') throw new Error('Composer operation invalidated');
          if (!blob) {
            fail(new Error('Failed to encode screenshot'));
            return;
          }

          let objectUrl;
          try {
            objectUrl = this.createObjectURL(blob);
          } catch (error) {
            fail(error);
            return;
          }
          if (generation !== this.generation || this.state !== 'finishing') {
            this.revokeObjectURL(objectUrl);
            reject(new Error('Composer operation invalidated'));
            return;
          }
          this.objectUrl = objectUrl;
          this.state = 'finished';
          resolve(objectUrl);
        } catch (error) {
          fail(error);
        }
      };
      try {
        canvas.toBlob(onBlob, mimeTypeFor(outputFormat),
          outputFormat === OUTPUT_FORMAT.JPEG ? JPEG_QUALITY : undefined);
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * 导出为 PNG data URL 供页面写入剪贴板。
   * 固定用 PNG：Chrome 的 ClipboardItem 写图片只稳定支持 image/png。
   */
  exportDataUrl() {
    if (this.state !== 'begun' && this.state !== 'finished') {
      throw new Error(`Cannot export while ${this.state}`);
    }
    if (!this.canvas) throw new Error('Composer canvas is not available');
    return this.canvas.toDataURL('image/png');
  }

  release() {
    ++this.generation;
    this.#clearResources();
    this.state = 'idle';
  }

  abort() {
    this.release();
  }

  #requireState(action, expected) {
    if (this.state !== expected) throw new Error(`Cannot ${action} while ${this.state}`);
  }

  #requireGeneration(generation) {
    if (generation !== this.generation) throw new Error('Composer operation invalidated');
  }

  #clearResources() {
    if (this.objectUrl) {
      this.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
    this.context = null;
  }
}

const COMPOSER_TYPES = new Set([
  MESSAGE.COMPOSER_BEGIN,
  MESSAGE.COMPOSER_ADD,
  MESSAGE.COMPOSER_FINISH,
  MESSAGE.COMPOSER_EXPORT,
  MESSAGE.COMPOSER_RELEASE,
  MESSAGE.COMPOSER_ABORT
]);

function serializedError(error) {
  return {
    ok: false,
    code: error?.code ?? ERROR_CODE.CAPTURE_FAILED,
    message: error?.message ?? String(error)
  };
}

export function createComposerMessageHandler(session) {
  let currentTaskId = null;
  let lastTerminatedTaskId = null;
  let taskGeneration = 0;

  const staleResponse = () => serializedError(codedError(ERROR_CODE.STALE_TASK, 'Stale composer task'));
  const isCurrent = (taskId, generation) =>
    currentTaskId === taskId && taskGeneration === generation;

  return async function handleMessage(message) {
    if (message?.source !== 'longshot' || !COMPOSER_TYPES.has(message.type)) return undefined;

    const { type, taskId, payload = {} } = message;
    const isTerminal = type === MESSAGE.COMPOSER_RELEASE || type === MESSAGE.COMPOSER_ABORT;
    if (isTerminal) {
      if (currentTaskId === null) {
        if (taskId !== lastTerminatedTaskId) return staleResponse();
      } else if (taskId !== currentTaskId) {
        return staleResponse();
      } else {
        ++taskGeneration;
        currentTaskId = null;
        lastTerminatedTaskId = taskId;
      }
      try {
        if (type === MESSAGE.COMPOSER_RELEASE) session.release();
        else session.abort();
        return { ok: true };
      } catch (error) {
        return serializedError(error);
      }
    }

    if (currentTaskId !== null && taskId !== currentTaskId) {
      // 旧任务的结果可能因 Service Worker 被回收而失去登记，没人会再来
      // RELEASE/ABORT。此时若一直回 stale，新的 BEGIN 永远无法开始，
      // 扩展会卡死到重载为止。无人推进的旧会话直接丢弃（与「新任务开始时
      // 自动丢弃旧结果」的策略一致）；仍在编码/绘制中的旧会话则继续保护。
      const abandoned = ['begun', 'finished', 'failed'].includes(session.state);
      if (type !== MESSAGE.COMPOSER_BEGIN || !abandoned) return staleResponse();
      lastTerminatedTaskId = currentTaskId;
      currentTaskId = null;
      ++taskGeneration;
      try {
        session.abort();
      } catch {
        // 丢弃失败也要继续开始新任务，否则后续截图全部不可用。
      }
    }
    if (currentTaskId === null && type !== MESSAGE.COMPOSER_BEGIN) return staleResponse();
    if (currentTaskId === null) {
      currentTaskId = taskId;
      ++taskGeneration;
    }
    const operationGeneration = taskGeneration;

    try {
      switch (type) {
        case MESSAGE.COMPOSER_BEGIN: {
          const result = await session.begin(payload);
          if (!isCurrent(taskId, operationGeneration)) return staleResponse();
          return { ok: true, ...result };
        }
        case MESSAGE.COMPOSER_ADD:
          await session.add(payload);
          if (!isCurrent(taskId, operationGeneration)) return staleResponse();
          return { ok: true };
        case MESSAGE.COMPOSER_FINISH: {
          const objectUrl = await session.finish(payload.format);
          if (!isCurrent(taskId, operationGeneration)) return staleResponse();
          return { ok: true, objectUrl };
        }
        case MESSAGE.COMPOSER_EXPORT: {
          const dataUrl = session.exportDataUrl();
          if (!isCurrent(taskId, operationGeneration)) return staleResponse();
          return { ok: true, dataUrl };
        }
        default:
          return undefined;
      }
    } catch (error) {
      if (!isCurrent(taskId, operationGeneration)) return staleResponse();
      return serializedError(error);
    }
  };
}

function createBrowserSession() {
  return new ComposerSession({
    createCanvas: () => document.createElement('canvas'),
    decodeImage: async dataUrl => createImageBitmap(await (await fetch(dataUrl)).blob()),
    createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: objectUrl => URL.revokeObjectURL(objectUrl)
  });
}

export function registerComposerMessageListener(onMessage, handleMessage) {
  onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source !== 'longshot' || !COMPOSER_TYPES.has(message.type)) return false;
    Promise.resolve()
      .then(() => handleMessage(message))
      .then(sendResponse, error => sendResponse(serializedError(error)));
    return true;
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && typeof document !== 'undefined') {
  registerComposerMessageListener(
    chrome.runtime.onMessage,
    createComposerMessageHandler(createBrowserSession())
  );
}
