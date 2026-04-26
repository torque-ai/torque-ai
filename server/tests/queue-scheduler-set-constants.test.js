'use strict';
const mod = require('../execution/queue-scheduler');

test('GPU_SHARING_PROVIDERS is a module-level Set constant', () => {
  expect(mod.GPU_SHARING_PROVIDERS).toBeInstanceOf(Set);
  expect(mod.GPU_SHARING_PROVIDERS.has('ollama')).toBe(true);
});

test('OLLAMA_GPU_PROVIDERS is a module-level Set constant', () => {
  expect(mod.OLLAMA_GPU_PROVIDERS).toBeInstanceOf(Set);
  expect(mod.OLLAMA_GPU_PROVIDERS.has('ollama')).toBe(true);
});
