'use strict';

function parseFamilyTag(modelName) {
  const trimmed = String(modelName || '').trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf(':');
  if (idx === -1) return null;
  const family = trimmed.slice(0, idx);
  const tag = trimmed.slice(idx + 1);
  if (!family || !tag) return null;
  return { family, tag };
}

function createAutoSeed({ watchlist, listHosts, fetchTags }) {
  async function seedFromHosts() {
    const hosts = listHosts() || [];
    const seen = new Set();
    let added = 0;

    for (const host of hosts) {
      const url = String(host.url || '').trim();
      if (!url) continue;
      let tags = [];
      try {
        tags = await fetchTags(url) || [];
      } catch {
        continue; // unreachable host — skip
      }
      for (const name of tags) {
        if (name.endsWith('-cloud')) continue;
        const parsed = parseFamilyTag(name);
        if (!parsed) continue;
        const key = `${parsed.family}:${parsed.tag}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const existed = !!watchlist.getByFamilyTag(parsed.family, parsed.tag);
        watchlist.add({ family: parsed.family, tag: parsed.tag, source: 'auto-seed' });
        if (!existed) added += 1;
      }
    }

    return { added, seen: seen.size };
  }

  return { seedFromHosts, parseFamilyTag };
}

module.exports = { createAutoSeed };
