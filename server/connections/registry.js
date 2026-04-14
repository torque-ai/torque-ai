'use strict';

const { createConnectedAccountStore } = require('../auth/connected-account-store');

function createConnectionRegistry({ db }) {
  const connectedAccountStore = createConnectedAccountStore({ db });

  return {
    findActive({ user_id, toolkit }) {
      return connectedAccountStore.findActive({ user_id, toolkit });
    },

    listConnectedAccounts(filters = {}) {
      return connectedAccountStore.list(filters);
    },

    getConnectedAccount(accountId) {
      return connectedAccountStore.get(accountId);
    },

    disableAccount(accountId) {
      return connectedAccountStore.disable(accountId);
    },

    deleteAccount(accountId) {
      return connectedAccountStore.delete(accountId);
    },
  };
}

module.exports = { createConnectionRegistry };
