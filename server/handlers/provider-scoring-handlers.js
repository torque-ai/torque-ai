'use strict';
const { defaultContainer } = require('../container');

async function handleGetProviderScores(args) {
  try {
    const scoring = defaultContainer.get('providerScoring');
    if (!scoring) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Provider scoring not initialized' }) }] };
    }
    if (args.provider) {
      const score = scoring.getProviderScore(args.provider);
      return { content: [{ type: 'text', text: JSON.stringify(score || { provider: args.provider, message: 'No score data' }) }] };
    }
    const scores = scoring.getAllProviderScores({ trustedOnly: args.trusted_only || false });
    return { content: [{ type: 'text', text: JSON.stringify({ providers: scores, count: scores.length }) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Provider scoring error: ${err.message}` }] };
  }
}

module.exports = { handleGetProviderScores };
