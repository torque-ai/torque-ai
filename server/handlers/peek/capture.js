const path = require('path');
const fs = require('fs');
const os = require('os');
const { ErrorCodes, makeError } = require('../shared');
const {
  escapeXml,
  formatBytes,
  getPeekTargetKey,
  peekHttpGetUrl,
  peekHttpGetWithRetry,
  peekHttpPostWithRetry,
  postCompareWithRetry,
  resolvePeekHost,
} = require('./shared');
const logger = require('../../logger').child({ component: 'peek-handlers' });

let _sharp = null;
function getSharp() {
  if (!_sharp) {
    try { _sharp = require('sharp'); }
    catch { throw new Error('sharp is not installed. Install it with: npm install sharp'); }
  }
  return _sharp;
}

let _Tesseract = null;
function getTesseract() {
  if (!_Tesseract) {
    try { _Tesseract = require('tesseract.js'); }
    catch { throw new Error('tesseract.js is not installed. Install it with: npm install tesseract.js'); }
  }
  return _Tesseract;
}

async function applyAnnotations(imageBuffer, annotations) {
  if (!annotations || annotations.length === 0) return imageBuffer;

  const sharp = getSharp();
  const metadata = await sharp(imageBuffer).metadata();
  const { width, height } = metadata;
  const COLORS = {
    red: 'rgba(255,0,0,0.8)',
    yellow: 'rgba(255,255,0,0.8)',
    green: 'rgba(0,255,0,0.8)',
    blue: 'rgba(0,100,255,0.8)'
  };

  const svgParts = [];

  for (const ann of annotations) {
    const color = COLORS[ann.color] || COLORS.red;

    if (ann.type === 'rect') {
      svgParts.push(
        `<rect x="${ann.x}" y="${ann.y}" width="${ann.w}" height="${ann.h}" fill="none" stroke="${color}" stroke-width="3"/>`
      );
      if (ann.label) {
        svgParts.push(
          `<text x="${ann.x}" y="${ann.y - 5}" fill="${color}" font-size="16" font-family="sans-serif" font-weight="bold">${escapeXml(ann.label)}</text>`
        );
      }
    } else if (ann.type === 'circle') {
      svgParts.push(
        `<circle cx="${ann.x}" cy="${ann.y}" r="${ann.r}" fill="none" stroke="${color}" stroke-width="3"/>`
      );
      if (ann.label) {
        svgParts.push(
          `<text x="${ann.x + ann.r + 5}" y="${ann.y}" fill="${color}" font-size="16" font-family="sans-serif" font-weight="bold">${escapeXml(ann.label)}</text>`
        );
      }
    } else if (ann.type === 'arrow' && ann.from && ann.to) {
      const [x1, y1] = ann.from;
      const [x2, y2] = ann.to;
      svgParts.push(
        `<defs><marker id="ah" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="${color}"/></marker></defs>`
      );
      svgParts.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3" marker-end="url(#ah)"/>`
      );
      if (ann.label) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 - 10;
        svgParts.push(
          `<text x="${mx}" y="${my}" fill="${color}" font-size="16" font-family="sans-serif" font-weight="bold">${escapeXml(ann.label)}</text>`
        );
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svgParts.join('')}</svg>`;
  return getSharp()(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toBuffer();
}

let _tesseractWorker = null;

async function getOcrWorker() {
  if (!_tesseractWorker) {
    const Tesseract = getTesseract();
    _tesseractWorker = await Tesseract.createWorker('eng');
  }
  return _tesseractWorker;
}

async function extractText(imageBuffer) {
  const worker = await getOcrWorker();
  const { data: { text } } = await worker.recognize(imageBuffer);
  return text.trim();
}

function getRegionsPath(targetKey) {
  return path.join(os.homedir(), '.peek-ui', 'regions', 'default', `${targetKey}.json`);
}

function loadRegions(targetKey) {
  const regionsPath = getRegionsPath(targetKey);
  if (!fs.existsSync(regionsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(regionsPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveRegion(targetKey, name, region) {
  const regionsPath = getRegionsPath(targetKey);
  fs.mkdirSync(path.dirname(regionsPath), { recursive: true });
  const regions = loadRegions(targetKey);
  regions[name] = { x: region.x, y: region.y, w: region.w, h: region.h };
  fs.writeFileSync(regionsPath, JSON.stringify(regions, null, 2));
}

function resolveRegion(targetKey, regionName) {
  const regions = loadRegions(targetKey);
  return regions[regionName] || null;
}

function buildCompareSummary(compareData, compareLabel) {
  const lines = [];

  if (compareLabel) {
    lines.push(`**Diff Source:** ${compareLabel}`);
  }
  if (typeof compareData.summary === 'string' && compareData.summary.trim()) {
    lines.push(`**Diff Summary:** ${compareData.summary.trim()}`);
  }
  if (typeof compareData.changed_pixels === 'number') {
    lines.push(`**Changed Pixels:** ${compareData.changed_pixels}`);
  }
  if (typeof compareData.diff_percent === 'number') {
    lines.push(`**Diff Percent:** ${(compareData.diff_percent * 100).toFixed(2)}%`);
  }
  if (typeof compareData.threshold === 'number') {
    lines.push(`**Threshold:** ${(compareData.threshold * 100).toFixed(2)}%`);
  }
  if (typeof compareData.passed === 'boolean') {
    lines.push(`**Within Threshold:** ${compareData.passed ? 'Yes' : 'No'}`);
  } else if (typeof compareData.match === 'boolean') {
    lines.push(`**Match:** ${compareData.match ? 'Yes' : 'No'}`);
  }

  return lines;
}

function getCompareImage(compareData) {
  const imageData = compareData.diff_image || compareData.diff || compareData.image || null;
  if (!imageData) return null;
  return {
    data: imageData,
    mimeType: compareData.diff_mime_type || compareData.mime_type || 'image/png'
  };
}

async function handlePeekUi(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 30) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) {
      return resolvedHost.error;
    }
    const { hostName, hostUrl } = resolvedHost;

    let health = await peekHttpGetUrl(hostUrl + '/health', 5000);
    if (health.error && resolvedHost.ssh) {
      const port = new URL(hostUrl).port || '9876';
      const hostPlatform = resolvedHost.platform || 'linux';
      try {
        const cp = require('child_process');
        if (hostPlatform === 'windows') {
          cp.execFileSync('ssh', [resolvedHost.ssh,
            'schtasks /create /tn PeekAutoStart /tr "peek-server --port ' + port + '" /sc once /st 00:00 /ru ' + resolvedHost.ssh.split('@')[0] + ' /f && schtasks /run /tn PeekAutoStart'
          ], { timeout: 10000, stdio: 'ignore' });
        } else {
          cp.execFileSync('ssh', [resolvedHost.ssh,
            'nohup peek-server --port ' + port + ' > /dev/null 2>&1 &'
          ], { timeout: 10000, stdio: 'ignore' });
        }
      } catch (e) { logger.debug(`[peek_ui] Auto-start attempt failed: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 3000));
      health = await peekHttpGetUrl(hostUrl + '/health', 5000);
    }
    if (health.error) {
      return makeError(ErrorCodes.OPERATION_FAILED,
        `Cannot reach peek_server on ${hostName} (${hostUrl}): ${health.error}\n\nEnsure peek_server.py is running on the target interactive desktop session.`);
    }

    if (args.list_windows) {
      const result = await peekHttpGetUrl(hostUrl + '/list', timeoutMs);
      if (result.error) {
        return makeError(ErrorCodes.OPERATION_FAILED, `List windows failed: ${result.error}`);
      }

      const windows = result.data.windows || [];
      let output = '## Remote Desktop Windows\n\n';
      if (windows.length === 0) {
        output += '_No visible windows found._\n';
      } else {
        output += '| Process | Title |\n|---------|-------|\n';
        for (const win of windows) {
          output += `| ${win.process} | ${win.title} |\n`;
        }
      }
      output += `\n**Host:** ${hostName}\n`;
      output += `**URL:** ${hostUrl}\n`;
      return { content: [{ type: 'text', text: output }] };
    }

    const params = new URLSearchParams();
    if (args.process) {
      params.set('mode', 'process');
      params.set('name', args.process);
    } else if (args.title) {
      params.set('mode', 'title');
      params.set('name', args.title);
    } else {
      params.set('mode', 'screen');
    }
    params.set('format', args.format || 'jpeg');
    params.set('quality', String(args.quality || 80));
    params.set('max_width', String(args.max_width || 1920));

    if (args.scale && !args.max_width) {
      params.set('max_width', String(Math.round(1920 * args.scale)));
    }

    const prelimTargetKey = getPeekTargetKey(args, { process: args.process, title: args.title });
    if (args.region && !args.crop) {
      const region = resolveRegion(prelimTargetKey, args.region);
      if (!region) {
        return makeError(ErrorCodes.INVALID_PARAM, `Named region not found: "${args.region}" for target "${prelimTargetKey}". Use save_region to create it first.`);
      }
      args.crop = region;
    }

    if (args.crop && args.crop.x != null && args.crop.y != null && args.crop.w != null && args.crop.h != null) {
      params.set('crop', `${args.crop.x},${args.crop.y},${args.crop.w},${args.crop.h}`);
    }

    if (args.annotate) {
      params.set('annotate', args.annotate === true ? 'true' : String(args.annotate));
    }

    const result = await peekHttpGetWithRetry(hostUrl + `/peek?${params.toString()}`, timeoutMs);

    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `peek_ui capture failed: ${result.error}`);
    }

    if (result.data.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);
    }

    const peekData = result.data;

    const imageBuffer = Buffer.from(peekData.image, 'base64');
    let finalImageBuffer = imageBuffer;
    if (args.annotations && args.annotations.length > 0) {
      finalImageBuffer = await applyAnnotations(imageBuffer, args.annotations);
      peekData.image = finalImageBuffer.toString('base64');
      peekData.size_bytes = finalImageBuffer.length;
    }

    const baselineRoot = path.join(os.homedir(), '.peek-ui', 'baselines', 'default');
    const lastRoot = path.join(os.homedir(), '.peek-ui', 'last', 'default');
    const targetKey = getPeekTargetKey(args, peekData);
    const lastCapturePath = path.join(lastRoot, `${targetKey}.png`);
    let previousCaptureB64 = null;
    let compareBaselineB64 = null;

    if (args.diff_baseline) {
      const baselinePath = path.join(baselineRoot, `${args.diff_baseline}.png`);
      if (!fs.existsSync(baselinePath)) {
        return makeError(ErrorCodes.INVALID_PARAM, `Baseline not found: ${args.diff_baseline}`);
      }
      compareBaselineB64 = fs.readFileSync(baselinePath).toString('base64');
    }

    if (args.auto_diff && fs.existsSync(lastCapturePath)) {
      previousCaptureB64 = fs.readFileSync(lastCapturePath).toString('base64');
    }

    const ext = peekData.format || 'jpeg';
    let localPath = args.save_path;
    if (!localPath) {
      const tmpDir = path.join(os.tmpdir(), 'peek-ui');
      fs.mkdirSync(tmpDir, { recursive: true });
      localPath = path.join(tmpDir, `peek-${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`);
    }
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, finalImageBuffer);

    if (args.save_baseline) {
      fs.mkdirSync(baselineRoot, { recursive: true });
      fs.writeFileSync(path.join(baselineRoot, `${args.save_baseline}.png`), finalImageBuffer);
    }

    if (args.save_region && args.save_region.name) {
      saveRegion(targetKey, args.save_region.name, args.save_region);
    }

    fs.mkdirSync(lastRoot, { recursive: true });
    fs.writeFileSync(lastCapturePath, finalImageBuffer);

    let compareData = null;
    let compareLabel = null;
    const threshold = args.diff_threshold ?? 0.01;

    if (compareBaselineB64) {
      compareLabel = `baseline:${args.diff_baseline}`;
      const compareResult = await postCompareWithRetry(hostUrl, compareBaselineB64, peekData.image, threshold, timeoutMs);
      if (compareResult.error) {
        return makeError(ErrorCodes.OPERATION_FAILED, `peek_ui compare failed: ${compareResult.error}`);
      }
      if (compareResult.status && (compareResult.status < 200 || compareResult.status >= 300)) {
        return makeError(ErrorCodes.OPERATION_FAILED, `peek_ui compare failed: HTTP ${compareResult.status}`);
      }
      if (compareResult.data && compareResult.data.error) {
        return makeError(ErrorCodes.OPERATION_FAILED, `peek_ui compare failed: ${compareResult.data.error}`);
      }
      compareData = compareResult.data || {};
    } else if (args.auto_diff && previousCaptureB64) {
      compareLabel = `last:${targetKey}`;
      const compareResult = await postCompareWithRetry(hostUrl, previousCaptureB64, peekData.image, threshold, timeoutMs);
      if (compareResult.error) {
        return makeError(ErrorCodes.OPERATION_FAILED, `peek_ui compare failed: ${compareResult.error}`);
      }
      if (compareResult.status && (compareResult.status < 200 || compareResult.status >= 300)) {
        return makeError(ErrorCodes.OPERATION_FAILED, `peek_ui compare failed: HTTP ${compareResult.status}`);
      }
      if (compareResult.data && compareResult.data.error) {
        return makeError(ErrorCodes.OPERATION_FAILED, `peek_ui compare failed: ${compareResult.data.error}`);
      }
      compareData = compareResult.data || {};
    }

    let ocrText = null;
    let ocrAssertResult = null;
    if (args.ocr || args.ocr_assert) {
      try {
        ocrText = await extractText(finalImageBuffer);
      } catch (ocrErr) {
        ocrText = `[OCR failed: ${ocrErr.message}]`;
      }

      if (args.ocr_assert && ocrText != null) {
        const needle = String(args.ocr_assert).toLowerCase();
        const haystack = ocrText.toLowerCase();
        const idx = haystack.indexOf(needle);
        ocrAssertResult = idx >= 0
          ? { pass: true, message: `"${args.ocr_assert}" → PASS (found at position ${idx})` }
          : { pass: false, message: `"${args.ocr_assert}" → FAIL (not found in extracted text)` };
      }
    }

    const content = [{
      type: 'image',
      data: peekData.image,
      mimeType: peekData.mime_type || `image/${ext}`
    }];

    if (peekData.annotated_image) {
      content.push({
        type: 'image',
        data: peekData.annotated_image,
        mimeType: peekData.annotated_mime_type || `image/${ext}`
      });
    }

    const compareImage = compareData ? getCompareImage(compareData) : null;
    if (compareImage) {
      content.push({
        type: 'image',
        data: compareImage.data,
        mimeType: compareImage.mimeType
      });
    }

    content.push({
      type: 'text',
      text: [
        `## peek_ui capture`,
        `**Target:** ${peekData.mode === 'screen' ? 'Full screen' : peekData.title || peekData.process || 'unknown'}`,
        peekData.process ? `**Process:** ${peekData.process}` : null,
        `**Resolution:** ${peekData.width}x${peekData.height}`,
        `**Size:** ${formatBytes(peekData.size_bytes)}`,
        `**Saved to:** ${localPath}`,
        args.save_baseline ? `**Baseline Saved:** ${args.save_baseline}` : null,
        args.save_region ? `**Region Saved:** ${args.save_region.name} (${args.save_region.x},${args.save_region.y},${args.save_region.w},${args.save_region.h})` : null,
        args.region ? `**Region:** ${args.region}` : null,
        `**Last Capture Key:** ${targetKey}`,
        `**Last Capture Path:** ${lastCapturePath}`,
        `**Host:** ${hostName}`,
        `**URL:** ${hostUrl}`,
        ...(compareData ? buildCompareSummary(compareData, compareLabel) : []),
        ocrText != null ? `**OCR Text:** ${ocrText.length === 0 ? '(no text detected)' : ocrText.length > 500 ? ocrText.substring(0, 500) + '...' : ocrText}` : null,
        ocrAssertResult ? `**OCR Assert:** ${ocrAssertResult.message}` : null
      ].filter(Boolean).join('\n')
    });

    if (args?.policyProof) {
      try {
        const database = require('../../database');
        const recordPolicyProof = typeof database.formatPolicyProof === 'function'
          ? database.formatPolicyProof
          : database.recordPolicyProofAudit;
        if (typeof recordPolicyProof === 'function') {
          recordPolicyProof({
            surface: 'capture_analysis',
            policy_family: 'peek',
            proof: args.policyProof,
            context: {
              task_id: args.task_id || args.taskId || null,
              workflow_id: args.workflow_id || args.workflowId || null,
              action: 'capture_complete',
              host: hostName,
              target: peekData.title || peekData.process || peekData.mode || null,
            },
          });
        }
      } catch (err) {
        logger.warn(`Policy proof audit recording failed: ${err.message}`);
      }
    }

    return { content };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekInteract(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    const action = args.action;
    if (!action) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'action is required (click, type, scroll, hotkey, focus)');
    }

    const payload = {};

    if (args.process) {
      payload.mode = 'process';
      payload.name = args.process;
    } else if (args.title) {
      payload.mode = 'title';
      payload.name = args.title;
    }

    if (args.element && (action === 'click' || action === 'type' || action === 'focus')) {
      const findResult = await peekHttpPostWithRetry(
        hostUrl + '/elements',
        { ...payload, find: args.element },
        timeoutMs
      );
      if (findResult.error) {
        return makeError(ErrorCodes.INTERNAL_ERROR, `Element lookup failed: ${findResult.error}`);
      }
      if (findResult.data && findResult.data.error) {
        return makeError(ErrorCodes.INVALID_PARAM, findResult.data.error);
      }
      if (findResult.data && findResult.data.center) {
        if (action === 'click') {
          payload.x = findResult.data.center.x;
          payload.y = findResult.data.center.y;
        }
        if (action === 'type') {
          payload.element_name = args.element;
        }
      }
    }

    let endpoint;
    switch (action) {
      case 'click':
        endpoint = '/click';
        if (payload.x == null) payload.x = args.x;
        if (payload.y == null) payload.y = args.y;
        if (payload.x == null || payload.y == null) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'click requires x,y coordinates or element name');
        }
        payload.button = args.button || 'left';
        payload.double = args.double || false;
        break;

      case 'drag':
        endpoint = '/drag';
        payload.from_x = args.from_x != null ? args.from_x : args.x;
        payload.from_y = args.from_y != null ? args.from_y : args.y;
        payload.to_x = args.to_x;
        payload.to_y = args.to_y;
        if (payload.from_x == null || payload.from_y == null || payload.to_x == null || payload.to_y == null) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'drag requires from_x, from_y, to_x, to_y (or x, y for from)');
        }
        payload.button = args.button || 'left';
        if (args.duration != null) payload.duration = args.duration;
        break;

      case 'type':
        endpoint = '/type';
        if (!args.text) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'type requires text');
        }
        payload.text = args.text;
        if (args.element) payload.element_name = args.element;
        break;

      case 'scroll':
        endpoint = '/scroll';
        payload.x = args.x;
        payload.y = args.y;
        payload.delta = args.delta;
        if (payload.x == null || payload.y == null || payload.delta == null) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'scroll requires x, y, and delta');
        }
        break;

      case 'hotkey':
        endpoint = '/hotkey';
        if (!args.keys) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'hotkey requires keys (e.g. "Ctrl+S")');
        }
        payload.keys = args.keys;
        break;

      case 'focus':
        endpoint = '/focus';
        break;

      case 'resize':
        endpoint = '/resize';
        if (args.width == null || args.height == null) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'resize requires width and height');
        }
        payload.width = args.width;
        payload.height = args.height;
        break;

      case 'move':
        endpoint = '/move';
        if (args.x == null || args.y == null) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'move requires x and y');
        }
        payload.x = args.x;
        payload.y = args.y;
        break;

      case 'maximize':
        endpoint = '/maximize';
        break;

      case 'minimize':
        endpoint = '/minimize';
        break;

      case 'clipboard_get':
        endpoint = '/clipboard';
        payload.action = 'get';
        delete payload.mode;
        delete payload.name;
        break;

      case 'clipboard_set':
        endpoint = '/clipboard';
        payload.action = 'set';
        if (!args.text) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'clipboard_set requires text');
        }
        payload.text = args.text;
        delete payload.mode;
        delete payload.name;
        break;

      case 'wait_for_element': {
        if (!args.element) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'wait_for_element requires element name');
        }
        const waitTimeout = args.wait_timeout || 10000;
        const pollInterval = args.poll_interval || 500;
        const deadline = Date.now() + waitTimeout;
        let found = null;
        while (Date.now() < deadline) {
          const findResult = await peekHttpPostWithRetry(
            hostUrl + '/elements',
            { ...payload, find: args.element },
            timeoutMs
          );
          if (findResult.data && findResult.data.center) {
            found = findResult.data;
            break;
          }
          await new Promise((r) => setTimeout(r, pollInterval));
        }
        if (!found) {
          return makeError(ErrorCodes.INTERNAL_ERROR, `Timed out waiting for element: ${args.element} (${waitTimeout}ms)`);
        }
        const waitElLines = [
          `## peek_interact: wait_for_element`,
          `**Host:** ${hostName}`,
          `**Element:** ${args.element}`,
          `**Found:** ${found.name} [${found.type}]`,
          `**Center:** (${found.center.x}, ${found.center.y})`,
          `**Status:** OK`,
        ];
        return { content: [{ type: 'text', text: waitElLines.join('\n') }] };
      }

      case 'wait_for_window': {
        const waitTimeout = args.wait_timeout || 10000;
        const pollInterval = args.poll_interval || 500;
        const deadline = Date.now() + waitTimeout;
        const target = args.wait_target || args.process || args.title;
        if (!target) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'wait_for_window requires wait_target, process, or title');
        }
        let foundWin = null;
        while (Date.now() < deadline) {
          const listResult = await peekHttpGetWithRetry(hostUrl + '/list', 5000);
          if (listResult.data && listResult.data.windows) {
            const needle = target.toLowerCase();
            foundWin = listResult.data.windows.find((w) =>
              (w.process || '').toLowerCase().includes(needle) ||
              (w.title || '').toLowerCase().includes(needle)
            );
            if (foundWin) break;
          }
          await new Promise((r) => setTimeout(r, pollInterval));
        }
        if (!foundWin) {
          return makeError(ErrorCodes.INTERNAL_ERROR, `Timed out waiting for window: ${target} (${waitTimeout}ms)`);
        }
        const waitWinLines = [
          `## peek_interact: wait_for_window`,
          `**Host:** ${hostName}`,
          `**Target:** ${target}`,
          `**Found:** ${foundWin.process} — ${foundWin.title} (hwnd: ${foundWin.hwnd})`,
          `**Status:** OK`,
        ];
        return { content: [{ type: 'text', text: waitWinLines.join('\n') }] };
      }

      default:
        return makeError(ErrorCodes.INVALID_PARAM, `Unknown action: ${action}. Use click, type, scroll, hotkey, focus, resize, move, maximize, minimize, clipboard_get, clipboard_set, wait_for_element, or wait_for_window.`);
    }

    const result = await peekHttpPostWithRetry(hostUrl + endpoint, payload, timeoutMs);

    if (result.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `${action} failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `${action} failed: ${result.data.error}`);
    }

    const waitAfter = args.wait_after != null ? args.wait_after : 300;
    if (waitAfter > 0) {
      await new Promise((r) => setTimeout(r, waitAfter));
    }

    const outputLines = [
      `## peek_interact: ${action}`,
      `**Host:** ${hostName}`,
    ];

    if (args.process) outputLines.push(`**Process:** ${args.process}`);
    if (args.element) outputLines.push(`**Element:** ${args.element}`);

    switch (action) {
      case 'click':
        outputLines.push(`**Coords:** (${payload.x}, ${payload.y})`);
        outputLines.push(`**Button:** ${payload.button}${payload.double ? ' (double)' : ''}`);
        break;
      case 'type':
        outputLines.push(`**Text:** ${args.text.length > 100 ? args.text.substring(0, 100) + '...' : args.text}`);
        break;
      case 'scroll':
        outputLines.push(`**Coords:** (${payload.x}, ${payload.y})`);
        outputLines.push(`**Delta:** ${payload.delta}`);
        break;
      case 'hotkey':
        outputLines.push(`**Keys:** ${args.keys}`);
        break;
      case 'focus':
      case 'resize':
      case 'move':
      case 'maximize':
        if (result.data && result.data.rect) {
          const r = result.data.rect;
          outputLines.push(`**Window Rect:** (${r.x}, ${r.y}, ${r.w}x${r.h})`);
        }
        break;
      case 'minimize':
        break;
      case 'clipboard_get':
        if (result.data) {
          outputLines.push(`**Clipboard Text:** ${(result.data.text || '').substring(0, 500)}`);
          outputLines.push(`**Length:** ${result.data.length || 0}`);
        }
        break;
      case 'clipboard_set':
        if (result.data) {
          outputLines.push(`**Chars Written:** ${result.data.length || 0}`);
        }
        break;
    }

    outputLines.push('**Status:** OK');

    const content = [{ type: 'text', text: outputLines.join('\n') }];

    if (args.capture_after) {
      const peekArgs = { host: args.host };
      if (args.process) peekArgs.process = args.process;
      if (args.title) peekArgs.title = args.title;
      const capture = await handlePeekUi(peekArgs);
      if (capture.content) {
        content.push(...capture.content);
      }
    }

    return { content };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekLaunch(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 30) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    if (!args.path || typeof args.path !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'path is required (absolute path to executable on the remote host)');
    }

    const payload = {
      action: args.build ? 'build_and_launch' : 'launch',
      path: args.path,
      args: args.args || [],
      wait_for_window: args.wait_for_window !== false,
      timeout: Math.min(args.timeout || 15, 30),
    };

    const result = await peekHttpPostWithRetry(hostUrl + '/process', payload, timeoutMs);

    if (result.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `Launch failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `Launch failed: ${result.data.error}`);
    }

    const lines = [
      `## peek_launch`,
      `**Host:** ${hostName}`,
      `**Path:** ${args.path}`,
    ];
    if (args.args && args.args.length > 0) {
      lines.push(`**Args:** ${args.args.join(' ')}`);
    }
    if (result.data) {
      if (result.data.pid) lines.push(`**PID:** ${result.data.pid}`);
      if (result.data.hwnd) lines.push(`**Window Handle:** ${result.data.hwnd}`);
      if (result.data.title) lines.push(`**Window Title:** ${result.data.title}`);
    }
    lines.push(`**Status:** ${result.data && result.data.success ? 'OK' : 'Failed'}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekDiscover(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    const result = await peekHttpGetWithRetry(hostUrl + '/projects', timeoutMs);

    if (result.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `Discovery failed: ${result.error}`);
    }

    const projects = (result.data && result.data.projects) || [];
    if (projects.length === 0) {
      return { content: [{ type: 'text', text: `## peek_discover\n**Host:** ${hostName}\n\n_No projects found in ~/Projects._` }] };
    }

    const lines = [
      `## peek_discover`,
      `**Host:** ${hostName}`,
      `**Projects found:** ${projects.length}`,
      '',
      '| Project | Type | Executable |',
      '|---------|------|------------|',
    ];

    for (const p of projects) {
      const exe = p.executable ? p.executable.split(/[/\\]/).pop() : '_not built_';
      lines.push(`| ${p.name} | ${p.type || '-'} | ${exe} |`);
    }

    lines.push('');
    lines.push('**Paths** (for peek_launch):');
    for (const p of projects) {
      if (p.executable) {
        lines.push(`- **${p.name}:** \`${p.executable}\``);
      } else {
        lines.push(`- **${p.name}:** \`${p.path}\` _(use build: true)_`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekOpenUrl(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 10) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    if (!args.url || typeof args.url !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'url is required');
    }
    if (!args.url.startsWith('http://') && !args.url.startsWith('https://')) {
      return makeError(ErrorCodes.INVALID_PARAM, 'url must start with http:// or https://');
    }

    const result = await peekHttpPostWithRetry(hostUrl + '/open-url', { url: args.url }, timeoutMs);

    if (result.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to open URL: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to open URL: ${result.data.error}`);
    }

    return { content: [{ type: 'text', text: `Opened **${args.url}** in default browser on **${hostName}**` }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekSnapshot(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    const action = args.action || 'save';
    const payload = { action };

    if (action === 'list' || action === 'clear') {
      const result = await peekHttpPostWithRetry(hostUrl + '/snapshot', payload, timeoutMs);
      if (result.error) return makeError(ErrorCodes.OPERATION_FAILED, `peek_snapshot failed: ${result.error}`);
      const d = result.data || {};

      if (action === 'list') {
        const lines = [`## Snapshots on ${hostName}`, `**Count:** ${d.count || 0}`];
        if (d.snapshots && d.snapshots.length > 0) {
          for (const s of d.snapshots) {
            lines.push(`- **${s.label}**: ${s.element_count} elements, ${s.age_seconds}s ago`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      return { content: [{ type: 'text', text: `Cleared ${d.cleared || 0} snapshot(s) on ${hostName}.` }] };
    }

    if (!args.label) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'label is required for save/diff');
    payload.label = args.label;

    if (args.process) {
      payload.mode = 'process';
      payload.name = args.process;
    } else if (args.title) {
      payload.mode = 'title';
      payload.name = args.title;
    } else {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'peek_snapshot requires process or title for save/diff');
    }

    if (args.depth) payload.depth = args.depth;

    const result = await peekHttpPostWithRetry(hostUrl + '/snapshot', payload, timeoutMs);
    if (result.error) return makeError(ErrorCodes.OPERATION_FAILED, `peek_snapshot failed: ${result.error}`);
    if (result.data && result.data.error) return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);

    const d = result.data || {};

    if (action === 'save') {
      return { content: [{ type: 'text', text: `Snapshot **"${args.label}"** saved on ${hostName} (${d.element_count || 0} elements, ${d.snapshot_count || 0} total snapshots).` }] };
    }

    const lines = [
      `## Snapshot Diff: "${args.label}"`,
      `**Host:** ${hostName}`,
      `**Baseline:** ${d.baseline_count || 0} elements | **Current:** ${d.current_count || 0} elements`,
      `**Changed:** ${d.has_changes !== false}`,
    ];
    if (d.added && d.added.length > 0) lines.push(`**Added (${d.added.length}):** ${d.added.map((e) => e.name || e.type).join(', ')}`);
    if (d.removed && d.removed.length > 0) lines.push(`**Removed (${d.removed.length}):** ${d.removed.map((e) => e.name || e.type).join(', ')}`);
    if (d.moved && d.moved.length > 0) lines.push(`**Moved (${d.moved.length}):** ${d.moved.map((e) => e.name || e.type).join(', ')}`);
    if (d.resized && d.resized.length > 0) lines.push(`**Resized (${d.resized.length}):** ${d.resized.map((e) => e.name || e.type).join(', ')}`);
    if (d.text_changed && d.text_changed.length > 0) lines.push(`**Text Changed (${d.text_changed.length}):** ${d.text_changed.map((e) => e.name || e.type).join(', ')}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekRefresh(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 10) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    const payload = { keys: 'F5' };
    if (args.hard) payload.keys = 'Ctrl+Shift+R';

    if (args.process) {
      payload.mode = 'process';
      payload.name = args.process;
    } else if (args.title) {
      payload.mode = 'title';
      payload.name = args.title;
    } else {
      const listResult = await peekHttpGetUrl(hostUrl + '/list', 5000);
      if (!listResult.error && listResult.data && listResult.data.windows) {
        const browser = listResult.data.windows.find((w) =>
          /msedge|chrome|firefox|brave|opera/i.test(w.process));
        if (browser) {
          payload.mode = 'process';
          payload.name = browser.process;
        }
      }
    }

    const result = await peekHttpPostWithRetry(hostUrl + '/hotkey', payload, timeoutMs);
    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Refresh failed: ${result.error}`);
    }
    return { content: [{ type: 'text', text: `Sent ${payload.keys} to ${payload.name || 'active window'} on **${hostName}**` }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekBuildAndOpen(args) {
  try {
    if (!args.url || typeof args.url !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'url is required');
    }
    if (!args.url.startsWith('http://') && !args.url.startsWith('https://')) {
      return makeError(ErrorCodes.INVALID_PARAM, 'url must start with http:// or https://');
    }

    const lines = ['## peek_build_and_open'];

    if (args.build_command && typeof args.build_command === 'string') {
      const cwd = args.working_directory || process.cwd();
      const parts = args.build_command.split(/\s+/);
      lines.push(`**Build:** \`${args.build_command}\` in ${cwd}`);
      const { execFileSync } = require('child_process');
      try {
        const buildResult = execFileSync(parts[0], parts.slice(1), {
          cwd,
          timeout: (args.build_timeout || 60) * 1000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true
        });
        lines.push('**Build Status:** OK');
        if (buildResult && buildResult.length < 500) {
          lines.push(`\`\`\`\n${buildResult.trim()}\n\`\`\``);
        }
      } catch (buildErr) {
        const stderr = buildErr.stderr ? buildErr.stderr.substring(0, 1000) : buildErr.message;
        lines.push('**Build Status:** FAILED');
        lines.push(`\`\`\`\n${stderr}\n\`\`\``);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
    }

    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    const openResult = await peekHttpPostWithRetry(hostUrl + '/open-url', { url: args.url }, 10000);
    if (openResult.error || (openResult.data && openResult.data.error)) {
      return makeError(ErrorCodes.OPERATION_FAILED,
        `Failed to open URL: ${openResult.error || openResult.data.error}`);
    }
    lines.push(`**Opened:** ${args.url} on ${hostName}`);

    const waitMs = (args.wait_seconds || 3) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    lines.push(`**Waited:** ${args.wait_seconds || 3}s for page load`);

    if (args.capture !== false) {
      const captureParams = new URLSearchParams();
      if (args.capture_process) {
        captureParams.set('mode', 'process');
        captureParams.set('name', args.capture_process);
      } else if (args.capture_title) {
        captureParams.set('mode', 'title');
        captureParams.set('name', args.capture_title);
      } else {
        const listResult = await peekHttpGetUrl(hostUrl + '/list', 5000);
        if (!listResult.error && listResult.data && listResult.data.windows) {
          const browser = listResult.data.windows.find((w) =>
            /msedge|chrome|firefox|brave|opera/i.test(w.process));
          if (browser) {
            captureParams.set('mode', 'process');
            captureParams.set('name', browser.process);
          }
        }
      }
      captureParams.set('format', 'jpeg');
      captureParams.set('quality', '80');
      captureParams.set('max_width', '1920');

      const capResult = await peekHttpGetWithRetry(
        hostUrl + `/peek?${captureParams.toString()}`,
        (args.timeout_seconds || 30) * 1000
      );

      if (!capResult.error && capResult.data && capResult.data.image) {
        const peekData = capResult.data;
        const ext = peekData.format || 'jpeg';
        const tmpDir = path.join(os.tmpdir(), 'peek-ui');
        fs.mkdirSync(tmpDir, { recursive: true });
        const localPath = path.join(tmpDir, `peek-bao-${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`);
        fs.writeFileSync(localPath, Buffer.from(peekData.image, 'base64'));
        lines.push(`**Captured:** ${peekData.width}x${peekData.height} (${peekData.title || 'unknown'})`);
        lines.push(`**Saved to:** ${localPath}`);
        return {
          content: [
            { type: 'image', data: peekData.image, mimeType: `image/${ext}` },
            { type: 'text', text: lines.join('\n') }
          ]
        };
      }
      lines.push(`**Capture:** Failed — ${capResult.error || 'no image data'}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function createPeekCaptureHandlers() {
  return {
    applyAnnotations,
    getOcrWorker,
    extractText,
    getRegionsPath,
    loadRegions,
    saveRegion,
    resolveRegion,
    buildCompareSummary,
    getCompareImage,
    handlePeekUi,
    handlePeekInteract,
    handlePeekLaunch,
    handlePeekDiscover,
    handlePeekOpenUrl,
    handlePeekSnapshot,
    handlePeekRefresh,
    handlePeekBuildAndOpen,
  };
}

module.exports = {
  applyAnnotations,
  getOcrWorker,
  extractText,
  getRegionsPath,
  loadRegions,
  saveRegion,
  resolveRegion,
  buildCompareSummary,
  getCompareImage,
  handlePeekUi,
  handlePeekInteract,
  handlePeekLaunch,
  handlePeekDiscover,
  handlePeekOpenUrl,
  handlePeekSnapshot,
  handlePeekRefresh,
  handlePeekBuildAndOpen,
  createPeekCaptureHandlers,
};
