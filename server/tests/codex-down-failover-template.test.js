'use strict';
/* global describe, it, expect */

const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'routing', 'templates', 'codex-down-failover.json');

describe('codex-down-failover template', () => {
  let tmpl;

  it('exists and is valid JSON with name + rules', () => {
    const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    tmpl = JSON.parse(raw);
    expect(tmpl.name).toBe('Codex-Down Failover');
    expect(tmpl.rules).toBeDefined();
  });

  it('has chains for all free-eligible categories', () => {
    tmpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    const expected = ['simple_generation', 'targeted_file_edit', 'documentation', 'default', 'plan_generation', 'tests'];
    for (const cat of expected) {
      expect(tmpl.rules[cat], `missing chain for ${cat}`).toBeDefined();
      expect(Array.isArray(tmpl.rules[cat])).toBe(true);
      expect(tmpl.rules[cat].length).toBeGreaterThan(0);
    }
  });

  it('does NOT have chains for codex_only categories', () => {
    tmpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    for (const cat of ['architectural', 'large_code_gen', 'xaml_wpf', 'security', 'reasoning']) {
      expect(tmpl.rules[cat], `${cat} should not have a chain`).toBeUndefined();
    }
  });

  it('chains never contain codex or codex-spark providers', () => {
    tmpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    for (const [cat, chain] of Object.entries(tmpl.rules)) {
      for (const link of chain) {
        expect(link.provider, `${cat} contains forbidden provider`).not.toBe('codex');
        expect(link.provider).not.toBe('codex-spark');
      }
    }
  });

  it('every chain entry has a valid provider field', () => {
    tmpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    const validProviders = new Set(['groq', 'cerebras', 'google-ai', 'openrouter', 'ollama', 'ollama-cloud']);
    for (const [cat, chain] of Object.entries(tmpl.rules)) {
      for (const link of chain) {
        expect(typeof link.provider).toBe('string');
        expect(validProviders.has(link.provider), `${cat}: unknown provider ${link.provider}`).toBe(true);
      }
    }
  });
});
