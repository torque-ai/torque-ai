/**
 * Peek UI handlers — remote window capture, interaction, regression, and OCR
 * via HTTP peek_server instances.
 *
 * Extracted from snapscope-handlers.js (Phase 4: Big File Decomposition).
 */

const {
  classifyEvidenceSufficiency,
  generateBundleChecksum,
  signBundleMetadata,
  storePeekArtifactsForTask,
  validateBundleIntegrity,
} = require('./peek/artifacts');
const hostHandlers = require('./peek/hosts');
const analysisHandlers = require('./peek/analysis');
const {
  handlePeekUi,
  handlePeekInteract,
  handlePeekLaunch,
  handlePeekDiscover,
  handlePeekOpenUrl,
  handlePeekSnapshot,
  handlePeekRefresh,
  handlePeekBuildAndOpen,
} = require('./peek/capture');
const {
  handlePeekRecovery,
  handlePeekRecoveryStatus,
} = require('./peek/recovery');
const {
  handlePeekOnboard,
  handlePeekOnboardDetect,
} = require('./peek/onboarding');

module.exports = {
  ...hostHandlers,
  ...analysisHandlers,
  classifyEvidenceSufficiency,
  generateBundleChecksum,
  handlePeekUi,
  handlePeekInteract,
  handlePeekLaunch,
  handlePeekDiscover,
  handlePeekOpenUrl,
  handlePeekSnapshot,
  handlePeekRefresh,
  handlePeekBuildAndOpen,
  handlePeekRecovery,
  handlePeekRecoveryStatus,
  handlePeekOnboard,
  handlePeekOnboardDetect,
  signBundleMetadata,
  storePeekArtifactsForTask,
  validateBundleIntegrity,
};
