'use strict';

const DEFAULT_COMPARE_THRESHOLD = 0.01;
const DATA_URI_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;

let pixelmatchPromise = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createDependencyError(message) {
  return createHttpError(500, message);
}

function normalizeCompareBody(body) {
  if (!isPlainObject(body)) {
    throw createHttpError(400, 'Compare request body must be a JSON object');
  }

  return { ...body };
}

function normalizeBase64Image(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createHttpError(400, `${name} image must be a non-empty base64 string`);
  }

  const normalized = value.trim().replace(DATA_URI_PREFIX, '').replace(/\s/g, '');
  if (normalized.length === 0 || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw createHttpError(400, `${name} image must be valid base64`);
  }

  return normalized;
}

function parseUnitNumber(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw createHttpError(400, `${name} must be a number between 0 and 1`);
  }

  return number;
}

function parseBoolean(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw createHttpError(400, `${name} must be a boolean`);
}

function parseInteger(value, name, options = {}) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw createHttpError(400, `${name} must be an integer`);
  }
  if (options.min !== undefined && number < options.min) {
    throw createHttpError(400, `${name} must be >= ${options.min}`);
  }

  return number;
}

function getSharp(options = {}) {
  if (options.sharp) return options.sharp;

  try {
    return require('sharp');
  } catch (error) {
    throw createDependencyError(`sharp is required for image comparison: ${error.message}`);
  }
}

async function loadPixelmatch(options = {}) {
  if (options.pixelmatch) return options.pixelmatch;

  if (!pixelmatchPromise) {
    pixelmatchPromise = import('pixelmatch')
      .then((module) => module.default || module)
      .catch((error) => {
        pixelmatchPromise = null;
        throw createDependencyError(`pixelmatch is required for image comparison: ${error.message}`);
      });
  }

  return pixelmatchPromise;
}

async function decodeImageWithSharp(base64, name, options = {}) {
  const sharp = getSharp(options);
  const imageBuffer = Buffer.from(normalizeBase64Image(base64, name), 'base64');

  try {
    const { data, info } = await sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return normalizeDecodedImage({ data, width: info.width, height: info.height }, name);
  } catch (error) {
    if (error && Number.isInteger(error.statusCode)) throw error;
    throw createHttpError(400, `${name} image must be a supported image format`);
  }
}

function normalizeDecodedImage(image, name) {
  if (!isPlainObject(image)) {
    throw createHttpError(500, `${name} decoder did not return an image object`);
  }

  const width = parseInteger(image.width, `${name}.width`, { min: 1 });
  const height = parseInteger(image.height, `${name}.height`, { min: 1 });
  const data = image.data;

  if (!data || typeof data.length !== 'number') {
    throw createHttpError(500, `${name} decoder did not return raw RGBA data`);
  }

  const expectedLength = width * height * 4;
  if (data.length !== expectedLength) {
    throw createHttpError(500, `${name} raw RGBA data length must be ${expectedLength} bytes`);
  }

  return {
    width,
    height,
    data: Buffer.from(data),
  };
}

async function decodeImage(base64, name, options = {}) {
  if (typeof options.decodeImage === 'function') {
    return normalizeDecodedImage(await options.decodeImage(base64, name), name);
  }

  return decodeImageWithSharp(base64, name, options);
}

async function encodeDiffPng(raw, width, height, options = {}) {
  if (typeof options.encodePng === 'function') {
    const encoded = await options.encodePng(raw, width, height);
    return Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
  }

  const sharp = getSharp(options);
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function getImagePayload(body, names) {
  for (const name of names) {
    if (body[name] !== undefined) return body[name];
  }
  return undefined;
}

function normalizeCompareRequest(body) {
  const payload = normalizeCompareBody(body);
  const baseline = normalizeBase64Image(
    getImagePayload(payload, ['baseline', 'expected', 'before', 'image_a', 'imageA']),
    'baseline'
  );
  const current = normalizeBase64Image(
    getImagePayload(payload, ['current', 'actual', 'after', 'image_b', 'imageB']),
    'current'
  );
  const pixelThreshold = parseUnitNumber(
    payload.pixel_threshold ?? payload.pixelThreshold ?? payload.threshold,
    'threshold',
    DEFAULT_COMPARE_THRESHOLD
  );
  const maxDiffPercent = parseUnitNumber(
    payload.max_diff_percent ?? payload.maxDiffPercent ?? payload.diff_threshold ?? payload.diffThreshold ?? payload.threshold,
    'max_diff_percent',
    pixelThreshold
  );
  const includeAA = parseBoolean(payload.include_aa ?? payload.includeAA, 'include_aa');
  const diffMask = parseBoolean(payload.diff_mask ?? payload.diffMask, 'diff_mask');

  return {
    baseline,
    current,
    pixelThreshold,
    maxDiffPercent,
    includeAA,
    diffMask,
    ignoreRegions: payload.ignore_regions ?? payload.ignoreRegions,
  };
}

function normalizeIgnoreRegions(value, width, height) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw createHttpError(400, 'ignore_regions must be an array');
  }

  const regions = [];
  for (const [index, region] of value.entries()) {
    if (!isPlainObject(region)) {
      throw createHttpError(400, `ignore_regions[${index}] must be an object`);
    }

    const x = parseInteger(region.x ?? region.left, `ignore_regions[${index}].x`, { min: 0 });
    const y = parseInteger(region.y ?? region.top, `ignore_regions[${index}].y`, { min: 0 });
    const w = parseInteger(region.w ?? region.width, `ignore_regions[${index}].w`, { min: 1 });
    const h = parseInteger(region.h ?? region.height, `ignore_regions[${index}].h`, { min: 1 });
    const x2 = Math.min(width, x + w);
    const y2 = Math.min(height, y + h);

    if (x >= width || y >= height || x2 <= x || y2 <= y) continue;
    regions.push({ x, y, x2, y2 });
  }

  return regions;
}

function applyIgnoreRegions(baseline, current, width, regions) {
  for (const region of regions) {
    for (let y = region.y; y < region.y2; y += 1) {
      const rowOffset = y * width * 4;
      for (let x = region.x; x < region.x2; x += 1) {
        const offset = rowOffset + x * 4;
        current[offset] = baseline[offset];
        current[offset + 1] = baseline[offset + 1];
        current[offset + 2] = baseline[offset + 2];
        current[offset + 3] = baseline[offset + 3];
      }
    }
  }
}

function assertSameDimensions(baseline, current) {
  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw createHttpError(
      400,
      `Image dimensions must match: baseline ${baseline.width}x${baseline.height}, current ${current.width}x${current.height}`
    );
  }
}

function buildPixelmatchOptions(request) {
  const options = { threshold: request.pixelThreshold };
  if (request.includeAA !== undefined) options.includeAA = request.includeAA;
  if (request.diffMask !== undefined) options.diffMask = request.diffMask;
  return options;
}

async function compareImages(body, options = {}) {
  const request = normalizeCompareRequest(body);
  const baseline = await decodeImage(request.baseline, 'baseline', options);
  const current = await decodeImage(request.current, 'current', options);
  assertSameDimensions(baseline, current);

  const width = baseline.width;
  const height = baseline.height;
  const totalPixels = width * height;
  const baselineData = Buffer.from(baseline.data);
  const currentData = Buffer.from(current.data);
  const ignoreRegions = normalizeIgnoreRegions(request.ignoreRegions, width, height);
  applyIgnoreRegions(baselineData, currentData, width, ignoreRegions);

  const diffData = Buffer.alloc(totalPixels * 4);
  const pixelmatch = await loadPixelmatch(options);
  const changedPixels = pixelmatch(
    baselineData,
    currentData,
    diffData,
    width,
    height,
    buildPixelmatchOptions(request)
  );
  const diffPercent = totalPixels === 0 ? 0 : changedPixels / totalPixels;
  const passed = diffPercent <= request.maxDiffPercent;
  const diffImage = await encodeDiffPng(diffData, width, height, options);

  return {
    success: true,
    width,
    height,
    total_pixels: totalPixels,
    changed_pixels: changedPixels,
    diff_percent: diffPercent,
    has_differences: changedPixels > 0,
    match: changedPixels === 0,
    passed,
    threshold: request.maxDiffPercent,
    max_diff_percent: request.maxDiffPercent,
    pixel_threshold: request.pixelThreshold,
    ignored_regions: ignoreRegions.length,
    diff_image: diffImage.toString('base64'),
    diff_mime_type: 'image/png',
    summary: `${changedPixels} of ${totalPixels} pixels changed (${(diffPercent * 100).toFixed(2)}%)`,
  };
}

function createCompareHandler(options = {}) {
  return async function handleCompare(ctx) {
    return compareImages(ctx.body, options);
  };
}

module.exports = {
  DEFAULT_COMPARE_THRESHOLD,
  compareImages,
  createCompareHandler,
  normalizeCompareRequest,
};
