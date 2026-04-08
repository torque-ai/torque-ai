'use strict';

const database = require('../database');
const taskCore = require('../db/task-core');
const webhookHandlers = require('./webhook-handlers');
const logger = require('../logger').child({ component: 'openclaw-handlers' });
const { createOpenClawAdvisor } = require('../integrations/openclaw-advisor');

let advisorInstance = null;

function getAdvisor() {
  if (!advisorInstance) {
    advisorInstance = createOpenClawAdvisor({
      db: database,
      taskCore,
      webhookHandlers,
      logger,
    });
  }
  return advisorInstance;
}

function makeResult(payload, isError = false) {
  const text = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload, null, 2);
  const result = {
    content: [{ type: 'text', text }],
  };
  if (typeof payload === 'object' && payload !== null) {
    result.structuredData = payload;
  }
  if (isError) {
    result.isError = true;
  }
  return result;
}

function handleListProposals(args = {}) {
  try {
    const proposals = getAdvisor().getProposals(args);
    return makeResult({
      proposals,
      count: proposals.length,
    });
  } catch (err) {
    return makeResult(`Failed to list OpenClaw proposals: ${err.message}`, true);
  }
}

async function handleApproveProposal(args = {}) {
  try {
    if (!args.proposal_id) {
      return makeResult('proposal_id is required', true);
    }

    const taskId = await getAdvisor().approveProposal(args.proposal_id);
    return makeResult({
      approved: true,
      proposal_id: args.proposal_id,
      task_id: taskId,
    });
  } catch (err) {
    return makeResult(`Failed to approve OpenClaw proposal: ${err.message}`, true);
  }
}

function handleRejectProposal(args = {}) {
  try {
    if (!args.proposal_id) {
      return makeResult('proposal_id is required', true);
    }

    getAdvisor().rejectProposal(args.proposal_id);
    return makeResult({
      rejected: true,
      proposal_id: args.proposal_id,
    });
  } catch (err) {
    return makeResult(`Failed to reject OpenClaw proposal: ${err.message}`, true);
  }
}

function handleConfigureOpenclawAdvisor(args = {}) {
  try {
    const config = getAdvisor().setConfig(args);
    return makeResult({
      configured: true,
      config,
    });
  } catch (err) {
    return makeResult(`Failed to configure OpenClaw advisor: ${err.message}`, true);
  }
}

module.exports = {
  handleListProposals,
  handleApproveProposal,
  handleRejectProposal,
  handleConfigureOpenclawAdvisor,
};
