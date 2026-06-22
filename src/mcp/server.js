// src/mcp/server.js — Model Context Protocol endpoint (the bring-your-own-AI seam, R8).
// A JSON-RPC 2.0 server over Streamable HTTP at POST /mcp. NO legacy SSE: a single
// POST carries the request and the JSON response. An Mcp-Session-Id is issued on
// initialize and echoed on every subsequent response (honoured, not required, in CE).
// Methods: initialize, tools/list, tools/call. Engine ops are exposed as MCP TOOLS
// (an explicit allow-list in ./tools); every tool call is audited to vosj.tool_log.
//
// AuthN reuses the REST bearer middleware (requireAuth). AuthZ for mutating tools is
// enforced structurally by the engine (HumanGateSigner) — never granted here.

'use strict';

const crypto = require('crypto');
const { requireAuth } = require('../api/auth');
const tools = require('./tools');

const PROTOCOL_VERSION = '2025-06-18';
const SESSION_HEADER = 'mcp-session-id';

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

async function handleToolsCall(params, ctx, actor) {
  const name = params && params.name;
  if (!name || !tools.isAllowed(name)) {
    const err = new Error(`unknown or disallowed tool: ${name}`);
    err.rpcCode = RPC.METHOD_NOT_FOUND;
    throw err;
  }
  const envelope = await tools.runTool(name, (params && params.arguments) || {}, ctx, actor);
  // MCP wraps tool output in content[]; isError mirrors the house envelope.
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: envelope.ok === false,
    structuredContent: envelope,
  };
}

async function dispatch(method, params, ctx, actor) {
  if (method === 'initialize') return handleInitialize(params, ctx);
  if (method === 'tools/list') return handleToolsList();
  if (method === 'tools/call') return handleToolsCall(params, ctx, actor);
  const err = new Error(`method not found: ${method}`);
  err.rpcCode = RPC.METHOD_NOT_FOUND;
  throw err;
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
      const actor = req.principal ? req.principal.id : null;
      const result = await dispatch(body.method, body.params, ctx, actor);
      return res.status(200).json(rpcResult(id, result));
    } catch (e) {
      const code = e.rpcCode || RPC.INTERNAL;
      return res.status(200).json(rpcError(id, code, e.message));
    }
  });

  if (ctx.log) ctx.log('INFO', 'MCP endpoint ready at POST /mcp');
}

module.exports = { mount, dispatch, validateEnvelope, RPC, PROTOCOL_VERSION };
