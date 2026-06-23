// src/connectors/index.js — the Vosj CE connector catalog (§16.1).
// Builds a ConnectorRegistry with every shipped connector registered by id, so a
// host can resolve a connector by name or list the available providers without
// importing each module by hand. Adding a provider is a one-line edit here.
//
// The demo connector is always present (works with STATE_STORE=memory and no
// cloud). The azure-arc and hyperv connectors are contract-complete but fail
// closed until their SDK seams are wired (verify() reports not-verified). They are
// SAFE to register: an unwired connector cannot produce a passing reconciliation
// proof, so the verified-before-Jump gate stays unreachable.

'use strict';

const { ConnectorRegistry } = require('./sdk');
const { DemoConnector } = require('./demo');
const { AzureArcConnector } = require('./azure-arc');
const { HyperVConnector } = require('./hyperv');

// buildRegistry() -> a fresh ConnectorRegistry with all connectors registered.
function buildRegistry() {
  const registry = new ConnectorRegistry();
  registry.register(new DemoConnector());
  registry.register(new AzureArcConnector());
  registry.register(new HyperVConnector());
  return registry;
}

// buildConnectorMap() -> a Map<id, connector> matching the ctx.connectors shape
// server.js / the API / the MCP layer already consume.
function buildConnectorMap() {
  return buildRegistry().toMap();
}

// buildProviderRegistry(connectors, config) -> the §16.1 capability-layer provider
// registry placed on ctx.providers. The connector SET is the source of truth (from
// code — buildConnectorMap, no fork); per-provider region/price METADATA is
// config-driven (config.providerRegistry / VOSJ_PROVIDER_REGISTRY), never hardcoded.
//
// Shape: list() -> [{ id, regions, priceTier, wired }]; get(id) -> one entry or null.
// `wired` reports whether a connector for that id is registered (the demo connector
// is wired; azure-arc/hyperv are registered but fail verify() closed until their SDK
// seams exist). Fail-closed: absent/malformed config => empty per-provider metadata
// (regions:[], priceTier:null), the connector set is still surfaced.
function buildProviderRegistry(connectors, config = {}) {
  const conn = connectors || new Map();
  const meta = (config && config.providerRegistry && typeof config.providerRegistry === 'object')
    ? config.providerRegistry
    : {};

  function entry(id) {
    const m = (meta[id] && typeof meta[id] === 'object') ? meta[id] : {};
    const regions = Array.isArray(m.regions)
      ? m.regions.filter((r) => typeof r === 'string' && r !== '')
      : [];
    const priceTier = (typeof m.priceTier === 'string' && m.priceTier !== '') ? m.priceTier : null;
    return Object.freeze({
      id,
      regions: Object.freeze(regions),
      priceTier,
      wired: conn.has(id),
    });
  }

  return Object.freeze({
    // Every id we can serve = the union of registered connectors and configured
    // providers, so a config-declared provider surfaces even before its connector
    // ships (wired:false), and a registered connector surfaces even without config.
    list() {
      const ids = new Set([...conn.keys(), ...Object.keys(meta)]);
      return Array.from(ids).sort().map(entry);
    },
    get(id) {
      if (!id) return null;
      if (!conn.has(id) && !Object.prototype.hasOwnProperty.call(meta, id)) return null;
      return entry(id);
    },
  });
}

module.exports = {
  buildRegistry,
  buildConnectorMap,
  buildProviderRegistry,
  DemoConnector,
  AzureArcConnector,
  HyperVConnector,
};
