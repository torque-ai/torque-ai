'use strict';

function createHandlers({ watchlist, events, scanner }) {
  return {
    async model_watchlist_list({ include_inactive = false } = {}) {
      const items = include_inactive ? watchlist.listAll() : watchlist.listActive();
      return { items };
    },

    async model_watchlist_add({ family, tag } = {}) {
      if (!family || typeof family !== 'string') throw new Error('family is required');
      if (!tag || typeof tag !== 'string') throw new Error('tag is required');
      const existed = !!watchlist.getByFamilyTag(family, tag);
      watchlist.add({ family, tag, source: 'user' });
      return { added: !existed, family, tag };
    },

    async model_watchlist_remove({ family, tag } = {}) {
      if (!family || !tag) throw new Error('family and tag are required');
      watchlist.deactivate(family, tag);
      return { removed: true, family, tag };
    },

    async model_freshness_scan_now() {
      return await scanner.runScan();
    },

    async model_freshness_events({ include_acknowledged = false } = {}) {
      const events_ = include_acknowledged ? events.listAll() : events.listPending();
      return { events: events_ };
    },
  };
}

module.exports = { createHandlers };
