// src/mcp/server.js — Model Context Protocol endpoint (the bring-your-own-AI seam, R8).
// A JSON-RPC 2.0 server over Streamable HTTP at POST /mcp. NO legacy SSE: a single
// POST carries the request and the JSON response. An Mcp-Session-Id is issued on
// initialize and echoed on every subsequent response (honoured, not required, in CE).
// Methods: initialize, tools/list, tools/call. Engine ops are exposed as MCP TOOLS
// (an explicit allow-list in ./tools); every tool call is audited to vosj.tool_log.
//
// AuthN reuses the REST bearer middleware (requireAuth). AuthZ is enforced at the
// seam: each tool is bound to a required capability (tools.requiredCapabilityFor)
// and EVERY tools/call is pre-filtered against the caller's capability — reusing
// auth.holdsCapability + the configured RBAC registry — before the tool runs (gaps
// 64/153). The mutating-gate guarantee is ALSO re-validated structurally in the
// engine (HumanGateSigner): the seam check is defence in depth, never a substitute.
//
// Confused-deputy / token pass-through (gap 156, RFC 8707 audience): the inbound
// bearer is NEVER forwarded upstream — tools call the LOCAL engine only. Before a
// tool runs we additionally assert the principal was minted for THIS local Hub
// (its auth mode is a recognised local mode) and bind the exercised capability +
// audience into the tool_log audit.

'use strict';

const crypto = require('crypto');
const { requireAuth, holdsCapability, getRbacRegistry } = require('../api/auth');
const tools = require('./tools');

const PROTOCOL_VERSION = '2025-06-18';
const SESSION_HEADER = 'mcp-session-id';

// The audience for an MCP tool call is THIS local Hub. A principal is valid for the
// local Hub only if it was authenticated by the local auth layer (token or open
// mode). Any other/unknown mode is rejected fail-closed — an inbound token is never
// passed through to a downstream resource (RFC 8707 audience restriction, gap 156).
const LOCAL_HUB_AUDIENCE = 'vosj-hub';
const LOCAL_AUTH_MODES = Object.freeze(new Set(['token', 'open']));

// JSON-RPC 2.0 error codes (spec §5.1).
const RPC = Object.freeze({
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL: -32603,
});

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function newSessionId() {
  return `mcp_${crypto.randomBytes(16).toString('hex')}`;
}

// ---- method handlers -------------------------------------------------------

function handleInitialize(_params, ctx) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'vosj-mcp', version: ctx.config.version },
  };
}

function handleToolsList() {
  return { tools: tools.listToolDefs() };
}

function rpcFault(message, code) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
}

// authorizeToolCall(name, principal) -> the bound capability, or throws an RPC
// INTERNAL fault when the call must be rejected at the seam (gaps 64/153/156). It:
//   (1) requires an authenticated principal (no anonymous tool call);
//   (2) asserts the principal's audience is THIS local Hub — its auth mode is a
//       recognised local mode — so an inbound token is never accepted as a
//       pass-through credential for a downstream resource (RFC 8707, gap 156);
//   (3) resolves the tool's bound required capability (fail-closed: a tool with no
//       declared capability is not callable);
//   (4) pre-filters: the principal must hold that capability via auth.holdsCapability
//       against the SAME configured RBAC registry requireCapability consults.
// Returns { capability, audience } recorded into the tool_log audit.
function authorizeToolCall(name, principal) {
  if (!principal) {
    throw rpcFault('authentication required for tools/call', RPC.INTERNAL);
  }
  if (!LOCAL_AUTH_MODES.has(principal.mode)) {
    // Confused-deputy guard: only a principal minted/validated by the local Hub
    // may exercise a tool; a foreign-audience token is refused (never forwarded).
    throw rpcFault('principal audience is not this Hub (token pass-through refused)', RPC.INTERNAL);
  }
  const capability = tools.requiredCapabilityFor(name);
  if (!capability) {
    throw rpcFault(`tool not bound to a capability: ${name}`, RPC.INTERNAL);
  }
  if (!holdsCapability(principal, capability, getRbacRegistry())) {
    throw rpcFault(`missing capability: ${capability}`, RPC.INTERNAL);
  }
  return { capability, audience: LOCAL_HUB_AUDIENCE };
}

async function handleToolsCall(params, ctx, principal) {
  const name = params && params.name;
  if (!name || !tools.isAllowed(name)) {
    throw rpcFault(`unknown or disallowed tool: ${name}`, RPC.METHOD_NOT_FOUND);
  }
  // PER-TOOL RBAC PRE-FILTER: authorize BEFORE the tool reaches the engine. A
  // rejection here means the engine is never touched (the seam is the gate); the
  // engine still re-validates the human gate as defence in depth.
  const bound = authorizeToolCall(name, principal);
  const actor = principal ? principal.id : null;
  const envelope = await tools.runTool(
    name, (params && params.arguments) || {}, ctx, actor, bound);
  // MCP wraps tool output in content[]; isError mirrors the house envelope.
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: envelope.ok === false,
    structuredContent: envelope,
  };
}

async function dispatch(method, params, ctx, principal) {
  if (method === 'initialize') return handleInitialize(params, ctx);
  if (method === 'tools/list') return handleToolsList();
  if (method === 'tools/call') return handleToolsCall(params, ctx, principal);
  throw rpcFault(`method not found: ${method}`, RPC.METHOD_NOT_FOUND);
}

// validateEnvelope(body) -> null | { code, message } describing a JSON-RPC fault.
function validateEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { code: RPC.INVALID_REQUEST, message: 'JSON-RPC request must be a single object' };
  }
  if (body.jsonrpc !== '2.0') {
    return { code: RPC.INVALID_REQUEST, message: 'jsonrpc must be "2.0"' };
  }
  if (typeof body.method !== 'string') {
    return { code: RPC.INVALID_REQUEST, message: 'method must be a string' };
  }
  return null;
}

function sessionFor(req, method) {
  const existing = req.headers[SESSION_HEADER];
  if (existing) return String(existing);
  return method === 'initialize' ? newSessionId() : '';
}

// mount(app, ctx) — adds POST /mcp. Authenticated by the shared bearer middleware.
function mount(app, ctx) {
  app.post('/mcp', requireAuth(ctx), async (req, res) => {
    const body = req.body;
    const fault = validateEnvelope(body);
    const id = body && typeof body === 'object' ? body.id : null;
    const sid = sessionFor(req, body && body.method);
    if (sid) res.set('Mcp-Session-Id', sid);
    if (fault) return res.status(200).json(rpcError(id, fault.code, fault.message));

    try {
      // Pass the full authenticated principal so the seam can pre-filter the call
      // against its capability + audience (requireAuth attached req.principal).
      const result = await dispatch(body.method, body.params, ctx, req.principal);
      return res.status(200).json(rpcResult(id, result));
    } catch (e) {
      const code = e.rpcCode || RPC.INTERNAL;
      return res.status(200).json(rpcError(id, code, e.message));
    }
  });

  if (ctx.log) ctx.log('INFO', 'MCP endpoint ready at POST /mcp');
}

module.exports = { mount, dispatch, validateEnvelope, RPC, PROTOCOL_VERSION };
