'use strict';

const MIME_TYPES = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getQueryValue(query, name) {
  const value = query ? query[name] : undefined;
  if (Array.isArray(value)) return value.length === 0 ? undefined : value[value.length - 1];
  return value;
}

function setStringOption(target, query, name, outputName = name) {
  const value = getQueryValue(query, name);
  if (value === undefined || value === null || value === '') return;
  target[outputName] = String(value);
}

function normalizeImageFormat(value) {
  if (value === undefined || value === null || value === '') return undefined;

  const format = String(value).trim().toLowerCase();
  if (format === 'jpg') return 'jpeg';
  if (format === 'jpeg' || format === 'png') return format;

  throw createHttpError(400, 'format must be png, jpeg, or jpg');
}

function parseInteger(value, name, options = {}) {
  if (value === undefined || value === null || value === '') return undefined;

  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw createHttpError(400, `${name} must be an integer`);
  }
  if (options.min !== undefined && number < options.min) {
    throw createHttpError(400, `${name} must be >= ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    throw createHttpError(400, `${name} must be <= ${options.max}`);
  }

  return number;
}

function parseBooleanOrString(value) {
  if (value === undefined || value === null) return undefined;

  const normalized = String(value).trim().toLowerCase();
  if (normalized === '' || normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return String(value);
}

function parseCrop(value) {
  if (value === undefined || value === null || value === '') return undefined;

  if (isPlainObject(value)) {
    return {
      x: parseInteger(value.x, 'crop.x'),
      y: parseInteger(value.y, 'crop.y'),
      w: parseInteger(value.w ?? value.width, 'crop.w', { min: 1 }),
      h: parseInteger(value.h ?? value.height, 'crop.h', { min: 1 }),
    };
  }

  const parts = String(value).split(',').map((part) => part.trim());
  if (parts.length !== 4) {
    throw createHttpError(400, 'crop must use "x,y,w,h" format');
  }

  return {
    x: parseInteger(parts[0], 'crop.x'),
    y: parseInteger(parts[1], 'crop.y'),
    w: parseInteger(parts[2], 'crop.w', { min: 1 }),
    h: parseInteger(parts[3], 'crop.h', { min: 1 }),
  };
}

function inferFormatFromMimeType(mimeType) {
  if (typeof mimeType !== 'string') return undefined;

  const normalized = mimeType.trim().toLowerCase();
  if (normalized === 'image/jpg') return 'jpeg';
  if (normalized === 'image/jpeg') return 'jpeg';
  if (normalized === 'image/png') return 'png';
  return undefined;
}

function parseCaptureQuery(query = {}) {
  const request = {};

  const mode = getQueryValue(query, 'mode');
  if (mode !== undefined && mode !== null && mode !== '') {
    request.mode = String(mode).trim().toLowerCase();
  }

  setStringOption(request, query, 'name');
  setStringOption(request, query, 'process');
  setStringOption(request, query, 'title');
  setStringOption(request, query, 'window_id');
  setStringOption(request, query, 'hwnd');

  const pid = parseInteger(getQueryValue(query, 'pid'), 'pid', { min: 0 });
  if (pid !== undefined) request.pid = pid;

  const format = normalizeImageFormat(getQueryValue(query, 'format'));
  if (format) request.format = format;

  const quality = parseInteger(getQueryValue(query, 'quality'), 'quality', { min: 1, max: 100 });
  if (quality !== undefined) request.quality = quality;

  const maxWidth = parseInteger(
    getQueryValue(query, 'max_width') ?? getQueryValue(query, 'maxWidth'),
    'max_width',
    { min: 1 }
  );
  if (maxWidth !== undefined) request.max_width = maxWidth;

  const crop = parseCrop(getQueryValue(query, 'crop'));
  if (crop) request.crop = crop;

  const annotate = parseBooleanOrString(getQueryValue(query, 'annotate'));
  if (annotate !== undefined) request.annotate = annotate;

  return request;
}

function getImageBuffer(capture) {
  if (!capture || typeof capture.image !== 'string' || capture.image.length === 0) {
    throw createHttpError(502, 'adapter.capture() did not return image data');
  }

  return Buffer.from(capture.image, 'base64');
}

function normalizeCaptureResult(capture, request = {}) {
  if (!isPlainObject(capture)) {
    throw createHttpError(502, 'adapter.capture() did not return a capture object');
  }

  const imageBuffer = getImageBuffer(capture);
  const format = normalizeImageFormat(capture.format)
    || inferFormatFromMimeType(capture.mime_type)
    || request.format
    || 'png';

  return {
    ...capture,
    size_bytes: Number.isInteger(capture.size_bytes) ? capture.size_bytes : imageBuffer.length,
    format,
    mime_type: capture.mime_type || MIME_TYPES[format],
  };
}

function getSharp(options = {}) {
  if (options.sharp) return options.sharp;
  return require('sharp');
}

async function transformCaptureIfNeeded(capture, request = {}, options = {}) {
  const normalized = normalizeCaptureResult(capture, request);
  const desiredFormat = request.format || normalized.format;
  const width = Number(normalized.width);
  const needsResize = Number.isInteger(request.max_width)
    && (!Number.isFinite(width) || width > request.max_width);
  const needsFormat = Boolean(request.format && normalized.format !== request.format);

  if (!needsResize && !needsFormat) return normalized;

  const sharp = getSharp(options);
  let pipeline = sharp(getImageBuffer(normalized));

  if (needsResize) {
    pipeline = pipeline.resize({ width: request.max_width, withoutEnlargement: true });
  }

  pipeline = desiredFormat === 'jpeg'
    ? pipeline.jpeg({ quality: request.quality || 80 })
    : pipeline.png();

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    ...normalized,
    image: data.toString('base64'),
    width: info.width,
    height: info.height,
    size_bytes: data.length,
    format: desiredFormat,
    mime_type: MIME_TYPES[desiredFormat],
  };
}

function createCaptureHandler(adapter, options = {}) {
  const captureAdapter = adapter && typeof adapter.capture === 'function'
    ? adapter
    : adapter && adapter.adapter;

  if (!captureAdapter || typeof captureAdapter.capture !== 'function') {
    throw new TypeError('createCaptureHandler requires an adapter with capture(options)');
  }

  return async function handleCapture(ctx) {
    const request = parseCaptureQuery(ctx.query || {});
    const capture = await captureAdapter.capture(request);
    return transformCaptureIfNeeded(capture, request, options);
  };
}

module.exports = {
  createCaptureHandler,
  parseCaptureQuery,
  transformCaptureIfNeeded,
};
