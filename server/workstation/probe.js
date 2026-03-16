'use strict';

function parseProbeResponse(probeResponse) {
  const caps = probeResponse.capabilities || {};
  const gpuInfo = caps.gpu || {};
  const ollamaInfo = caps.ollama || {};

  return {
    platform: probeResponse.platform || null,
    arch: probeResponse.arch || null,
    capabilities: caps,
    capabilitiesJson: JSON.stringify(caps),
    gpuName: gpuInfo.detected ? (gpuInfo.name || null) : null,
    gpuVramMb: gpuInfo.detected ? (gpuInfo.vram_mb || null) : null,
    ollamaPort: ollamaInfo.detected ? (ollamaInfo.port || 11434) : null,
    models: ollamaInfo.models || [],
  };
}

function probeToWorkstationUpdates(parsed) {
  const updates = {
    platform: parsed.platform,
    arch: parsed.arch,
    capabilities: parsed.capabilitiesJson,
    gpu_name: parsed.gpuName,
    gpu_vram_mb: parsed.gpuVramMb,
  };
  if (parsed.ollamaPort) {
    updates.ollama_port = parsed.ollamaPort;
  }
  if (parsed.models.length > 0) {
    updates.models_cache = JSON.stringify(parsed.models);
    updates.models_updated_at = new Date().toISOString();
  }
  return updates;
}

module.exports = {
  parseProbeResponse,
  probeToWorkstationUpdates,
};
