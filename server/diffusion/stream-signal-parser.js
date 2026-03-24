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
          logger.info(`[StreamSignalParser] Malformed JSON in ${type}: ${err.message}`);
          continue;
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
