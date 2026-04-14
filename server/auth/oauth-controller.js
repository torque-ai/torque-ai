'use strict';

function createOAuthController({ authConfigStore, connectedAccountStore, fetchFn = fetch }) {
  return {
    startFlow({ toolkit, state }) {
      const cfg = authConfigStore.getByToolkit(toolkit);
      if (!cfg) throw new Error(`no auth_config for ${toolkit}`);
      const params = new URLSearchParams({
        client_id: cfg.client_id,
        redirect_uri: cfg.redirect_uri,
        response_type: 'code',
        scope: cfg.scopes || '',
        state,
      });
      return `${cfg.authorize_url}?${params.toString()}`;
    },
    async exchangeCode({ toolkit, code, user_id }) {
      const cfg = authConfigStore.getByToolkit(toolkit);
      if (!cfg) throw new Error(`no auth_config for ${toolkit}`);

      const requestBody = new URLSearchParams({
        code,
        client_id: cfg.client_id,
        redirect_uri: cfg.redirect_uri,
        grant_type: 'authorization_code',
      });
      if (cfg.client_secret) {
        requestBody.set('client_secret', cfg.client_secret);
      }

      const res = await fetchFn(cfg.token_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: requestBody.toString(),
      });

      if (res && res.ok === false) {
        throw new Error(`token exchange failed with status ${res.status}`);
      }

      const tok = await res.json();
      if (!tok.access_token) throw new Error('no access_token in token response');

      const expires_at = tok.expires_in ? Date.now() + tok.expires_in * 1000 : null;
      const id = connectedAccountStore.create({
        user_id,
        toolkit,
        auth_config_id: cfg.id,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at,
      });
      return { connected_account_id: id };
    },
  };
}

module.exports = { createOAuthController };
