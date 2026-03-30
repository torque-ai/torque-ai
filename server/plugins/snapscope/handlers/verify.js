'use strict';

function createVerifyHandlers(peekClient) {
  async function handlePeekVerify(args) {
    const { data } = await peekClient.request('POST', '/verify', {
      window: args.window,
      checks: args.checks,
      capture: args.capture !== false,
      name: args.name || '',
      branch: args.branch || 'main',
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekVerifyRun(args) {
    const { data } = await peekClient.request('POST', '/verify/run', {
      spec_name: args.spec_name,
      window: args.window,
      branch: args.branch || 'main',
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekVerifySpecs(args) {
    const { data } = await peekClient.request('POST', '/verify/specs', args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekBaselines(args) {
    const { data } = await peekClient.request('POST', '/baselines', args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekHistory(args) {
    const { data } = await peekClient.request('POST', '/history', args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  return {
    handlePeekVerify,
    handlePeekVerifyRun,
    handlePeekVerifySpecs,
    handlePeekBaselines,
    handlePeekHistory,
  };
}

module.exports = { createVerifyHandlers };
