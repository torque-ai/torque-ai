'use strict';

function createProviderCircuitBreakerStore({ db }) {
  if (!db) throw new Error('createProviderCircuitBreakerStore requires db');

  const upsertStmt = db.prepare(`
    INSERT INTO provider_circuit_breaker
      (provider_id, state, tripped_at, untripped_at, trip_reason, last_canary_at, last_canary_status)
    VALUES (@provider_id, @state, @tripped_at, @untripped_at, @trip_reason, @last_canary_at, @last_canary_status)
    ON CONFLICT(provider_id) DO UPDATE SET
      state              = COALESCE(excluded.state, provider_circuit_breaker.state),
      tripped_at         = COALESCE(excluded.tripped_at, provider_circuit_breaker.tripped_at),
      untripped_at       = COALESCE(excluded.untripped_at, provider_circuit_breaker.untripped_at),
      trip_reason        = COALESCE(excluded.trip_reason, provider_circuit_breaker.trip_reason),
      last_canary_at     = COALESCE(excluded.last_canary_at, provider_circuit_breaker.last_canary_at),
      last_canary_status = COALESCE(excluded.last_canary_status, provider_circuit_breaker.last_canary_status)
  `);

  const getStmt = db.prepare(`SELECT * FROM provider_circuit_breaker WHERE provider_id = ?`);
  const listStmt = db.prepare(`SELECT * FROM provider_circuit_breaker`);

  return {
    persist(providerId, patch = {}) {
      upsertStmt.run({
        provider_id: providerId,
        state: patch.state ?? null,
        tripped_at: patch.trippedAt ?? null,
        untripped_at: patch.untrippedAt ?? null,
        trip_reason: patch.tripReason ?? null,
        last_canary_at: patch.lastCanaryAt ?? null,
        last_canary_status: patch.lastCanaryStatus ?? null,
      });
    },
    getState(providerId) {
      return getStmt.get(providerId) ?? null;
    },
    listAll() {
      return listStmt.all();
    },
  };
}

module.exports = { createProviderCircuitBreakerStore };
