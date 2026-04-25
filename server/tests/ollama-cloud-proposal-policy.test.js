'use strict';

const {
  READ_ONLY_AGENTIC_TOOLS,
  buildOllamaCloudProposalApplyMetadata,
} = require('../routing/ollama-cloud-proposal-policy');

describe('ollama cloud proposal/apply routing policy', () => {
  it('marks repo-writing ollama-cloud-primary tasks for read-only proposal/apply', () => {
    const metadata = buildOllamaCloudProposalApplyMetadata({
      taskDescription: 'Create tools/check_android_config_packaging_parity.py',
      files: [],
      selectedProvider: 'ollama-cloud',
      routingTemplate: 'preset-ollama-cloud-primary',
      routingChain: [
        { provider: 'ollama-cloud', model: 'qwen3-coder:480b' },
        { provider: 'codex' },
      ],
    });

    expect(metadata).toMatchObject({
      ollama_cloud_repo_write_mode: 'proposal_apply',
      proposal_apply_provider: 'codex',
      agentic_allowed_tools: READ_ONLY_AGENTIC_TOOLS,
    });
  });

  it('does not constrain non-writing tasks', () => {
    const metadata = buildOllamaCloudProposalApplyMetadata({
      taskDescription: 'Explain the Android config packaging flow',
      selectedProvider: 'ollama-cloud',
      routingTemplate: 'preset-ollama-cloud-primary',
      routingChain: [{ provider: 'ollama-cloud' }, { provider: 'codex' }],
    });

    expect(metadata).toEqual({});
  });

  it('allows an explicit direct mode override', () => {
    const metadata = buildOllamaCloudProposalApplyMetadata({
      taskDescription: 'Update tools/check.py',
      selectedProvider: 'ollama-cloud',
      routingTemplate: 'preset-ollama-cloud-primary',
      routingChain: [{ provider: 'ollama-cloud' }, { provider: 'codex' }],
      userTaskMetadata: { ollama_cloud_repo_write_mode: 'direct' },
    });

    expect(metadata).toEqual({});
  });

  it('does not add read-only policy after routing has already selected codex', () => {
    const metadata = buildOllamaCloudProposalApplyMetadata({
      taskDescription: 'Update tools/check.py',
      selectedProvider: 'codex',
      routingTemplate: 'preset-ollama-cloud-primary',
      routingChain: [{ provider: 'ollama-cloud' }, { provider: 'codex' }],
    });

    expect(metadata).toEqual({});
  });
});
