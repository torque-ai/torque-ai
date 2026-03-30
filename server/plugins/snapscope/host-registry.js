'use strict';

function createHostRegistry(db) {
  const hosts = new Map();

  function getHealthyHosts() {
    return [...hosts.values()].filter((host) => host.healthy);
  }

  function registerHost(name, url) {
    hosts.set(name, { name, url, healthy: true, registeredAt: Date.now() });
  }

  function removeHost(name) {
    return hosts.delete(name);
  }

  function listHosts() {
    return [...hosts.values()];
  }

  return { getHealthyHosts, registerHost, removeHost, listHosts };
}

module.exports = { createHostRegistry };
