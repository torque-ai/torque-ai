'use strict';

function createScanner({ watchlist, events, fetchLocalDigest, fetchRemoteDigest, listHosts, notify }) {
  async function runScan() {
    const rows = watchlist.listActive();
    const hosts = listHosts() || [];
    let eventsEmitted = 0;
    const errors = [];

    for (const row of rows) {
      try {
        let localDigest = null;
        for (const host of hosts) {
          const digest = await fetchLocalDigest(row.family, row.tag, host);
          if (digest) { localDigest = digest; break; }
        }
        if (!localDigest) {
          watchlist.deactivate(row.family, row.tag);
          continue;
        }

        const remoteDigest = await fetchRemoteDigest(row.family, row.tag);
        if (!remoteDigest) continue; // registry 404 — skip

        if (remoteDigest !== localDigest) {
          events.insert({
            family: row.family, tag: row.tag,
            oldDigest: localDigest, newDigest: remoteDigest,
          });
          eventsEmitted += 1;
          if (typeof notify === 'function') {
            await notify({
              type: 'model_drift',
              family: row.family,
              tag: row.tag,
              old_digest: localDigest,
              new_digest: remoteDigest,
              detected_at: new Date().toISOString(),
              suggestion: `Run 'ollama pull ${row.family}:${row.tag}' to update.`,
            });
          }
        }

        watchlist.recordScan(row.family, row.tag, localDigest);
      } catch (err) {
        errors.push({ family: row.family, tag: row.tag, error: err.message });
      }

      await new Promise(r => setTimeout(r, 500)); // polite to registry
    }

    return { rowsScanned: rows.length, eventsEmitted, errors };
  }

  return { runScan };
}

module.exports = { createScanner };
