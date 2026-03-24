'use strict';

const logger = require('../logger').child({ component: 'stream-signal-parser' });

const MARKER_TYPES = {
  '__PATTERNS_READY__': { end: '__PATTERNS_READY_END__', type: 'patterns_ready' },
  '__SCOUT_DISCOVERY__': { end: '__SCOUT_DISCOVERY_END__', type: 'scout_discovery' },
  '__SCOUT_COMPLETE__': { end: '__SCOUT_COMPLETE_END__', type: 'scout_complete' },
};

const MARKER_STARTS = Object.keys(MARKER_TYPES);

class StreamSignalParser {
  constructor(onSignal) {
    this._onSignal = onSignal;
    this._buffer = '';
    this._destroyed = false;
  }

  feed(chunk) {
    if (this._destroyed) return;
    this._buffer += chunk;
    this._scan();
  }

  _scan() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const startMarker of MARKER_STARTS) {
        const startIdx = this._buffer.indexOf(startMarker);
        if (startIdx === -1) continue;

        const { end: endMarker, type } = MARKER_TYPES[startMarker];
        const endIdx = this._buffer.indexOf(endMarker, startIdx + startMarker.length);
        if (endIdx === -1) continue;

        const jsonStr = this._buffer.slice(startIdx + startMarker.length, endIdx).trim();
        this._buffer = this._buffer.slice(endIdx + endMarker.length);
        changed = true;

        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (err) {
          // Attempt repair: PowerShell string interpolation can corrupt JSON
          // by inserting '"' sequences or mangling escapes
          let repaired = jsonStr
            .replace(/'"'/g, '"')       // PowerShell double-quote escaping
            .replace(/"'/g, '"')         // Mismatched quote pairs
            .replace(/'/g, '"')          // Single quotes to double quotes (if all else fails)
            .replace(/\r\n/g, '\n');     // Normalize line endings
          try {
            parsed = JSON.parse(repaired);
            logger.info(`[StreamSignalParser] Repaired corrupted JSON in ${type}`);
          } catch (err2) {
            // Try extracting JSON from within the text using the compute-output-parser
            try {
              const { parseComputeOutput } = require('./compute-output-parser');
              const extracted = parseComputeOutput(jsonStr);
              if (extracted) {
                parsed = extracted;
                logger.info(`[StreamSignalParser] Extracted JSON from ${type} via compute-output-parser`);
              } else {
                logger.info(`[StreamSignalParser] Malformed JSON in ${type}: ${err.message}`);
                continue;
              }
            } catch (_) {
              logger.info(`[StreamSignalParser] Malformed JSON in ${type}: ${err.message}`);
              continue;
            }
          }
        }

        try {
          this._onSignal(type, parsed);
        } catch (err) {
          logger.info(`[StreamSignalParser] Signal callback error for ${type}: ${err.message}`);
        }
      }
    }

    if (this._buffer.length > 16384) {
      this._buffer = this._buffer.slice(-16384);
    }
  }

  destroy() {
    this._destroyed = true;
    this._buffer = '';
  }
}

module.exports = { StreamSignalParser, MARKER_TYPES, MARKER_STARTS };
