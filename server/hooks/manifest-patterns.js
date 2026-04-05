'use strict';

const fs = require('fs');
const path = require('path');

const WPF_SURFACE_REGEX = /<(Window|Page|UserControl)\s+x:Class="[^"]*\.(\w+)"/;
const REACT_PAGE_PATTERNS = [/^pages\/(.+?)\.\w+$/, /^app\/(.+?)\/page\.\w+$/];
const ELECTRON_WINDOW_REGEX = /new\s+BrowserWindow\s*\(/;

function detectVisualSurfaces(files, contents, framework) {
  const surfaces = [];

  for (const file of files) {
    const content = contents[file] || '';
    const basename = path.basename(file, path.extname(file));

    if (framework === 'wpf') {
      const match = content.match(WPF_SURFACE_REGEX);
      if (match) {
        surfaces.push({ file, type: match[1], id: match[2] });
      }
    } else if (framework === 'react') {
      for (const pattern of REACT_PAGE_PATTERNS) {
        const match = file.match(pattern);
        if (match) {
          const id = match[1].replace(/\/page$/, '').replace(/\//g, '-');
          surfaces.push({ file, type: 'page', id });
          break;
        }
      }
    } else if (framework === 'electron') {
      if (ELECTRON_WINDOW_REGEX.test(content)) {
        surfaces.push({ file, type: 'BrowserWindow', id: basename });
      }
    }
  }

  return surfaces;
}

function loadManifest(projectDir) {
  const manifestPath = path.join(projectDir, 'peek-manifest.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function findUnregistered(surfaces, manifest) {
  if (!manifest || !manifest.sections) return [...surfaces];

  const registeredIds = new Set();
  for (const section of manifest.sections) {
    registeredIds.add(section.id.toLowerCase());
    if (section.subsections) {
      for (const sub of section.subsections) {
        registeredIds.add(sub.id.toLowerCase());
      }
    }
  }

  return surfaces.filter(s => !registeredIds.has(s.id.toLowerCase()));
}

function suggestManifestEntry(surface) {
  return {
    id: surface.id.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label: surface.id.replace(/([A-Z])/g, ' $1').trim(),
    navigation: { type: 'nav_element', target: `${surface.id}NavItem` },
    depth: 'page'
  };
}

module.exports = { detectVisualSurfaces, loadManifest, findUnregistered, suggestManifestEntry };
