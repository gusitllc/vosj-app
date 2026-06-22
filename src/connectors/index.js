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

module.exports = {
  buildRegistry,
  buildConnectorMap,
  DemoConnector,
  AzureArcConnector,
  HyperVConnector,
};
