'use strict';

function createWatchHandlers(peekClient) {
  async function handlePeekWatchAdd(args) {
    const { data } = await peekClient.request('POST', '/watch/add', args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekWatchRemove(args) {
    const { data } = await peekClient.request('POST', '/watch/remove', args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekWatchStatus(args) {
    const { data } = await peekClient.request('POST', '/watch/status', args || {});
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekWatchControl(args) {
    const { data } = await peekClient.request('POST', '/watch/control', args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekRecoveryExecute(args) {
    const { data } = await peekClient.request('POST', '/recovery/execute', args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async function handlePeekRecoveryLog(args) {
    const { data } = await peekClient.request('POST', '/recovery/log', args || {});
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  return {
    handlePeekWatchAdd,
    handlePeekWatchRemove,
    handlePeekWatchStatus,
    handlePeekWatchControl,
    handlePeekRecoveryExecute,
    handlePeekRecoveryLog,
  };
}

module.exports = { createWatchHandlers };
