#!/usr/bin/env node
/**
 * mcpslim proxy — a transparent MCP stdio proxy that compresses tool outputs
 * before they reach the LLM's context window.
 *
 * HOW IT FITS: Claude Code (or Cursor/Gemini/etc.) is configured to launch THIS
 * instead of the real MCP server. We spawn the real server as a child, forward
 * every JSON-RPC request untouched, and on the way back we compress the `content`
 * of `tools/call` results. Everything else (initialize, tools/list, errors,
 * notifications) passes through byte-for-byte.
 *
 * Transport: MCP stdio = newline-delimited JSON-RPC. We buffer partial lines and
 * never block the stream; anything we can't parse is forwarded verbatim (fail-open).
 *
 * USAGE:
 *   mcpslim-proxy --mode safe -- <real-server-cmd> [args...]
 *   mcpslim-proxy --profile ./profiles/higgsfield.json -- node real-server.js
 *
 * In Claude Code .mcp.json, wrap an existing server:
 *   "higgsfield": {
 *     "command": "mcpslim-proxy",
 *     "args": ["--mode","safe","--","<original command>","<original args...>"]
 *   }
 */
const { spawn } = require('child_process');
const fs = require('fs');
const { compress } = require('./compress');

// ---- arg parsing ----
const argv = process.argv.slice(2);
let mode = 'safe';
let profilePath = null;
let dashIdx = argv.indexOf('--');
const opts = dashIdx === -1 ? argv : argv.slice(0, dashIdx);
const childCmd = dashIdx === -1 ? [] : argv.slice(dashIdx + 1);

for (let i = 0; i < opts.length; i++) {
  if (opts[i] === '--mode') mode = opts[++i];
  else if (opts[i] === '--profile') profilePath = opts[++i];
}

if (childCmd.length === 0) {
  process.stderr.write('mcpslim-proxy: no downstream server. Use: mcpslim-proxy [--mode safe|aggressive] [--profile f.json] -- <cmd> [args]\n');
  process.exit(2);
}

// ---- profile: per-tool mode overrides ----
// { "tools": { "show_generations": "aggressive", "default": "safe" }, "options": {...} }
let profile = { tools: {}, options: {} };
if (profilePath) {
  try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); }
  catch (e) { process.stderr.write(`mcpslim-proxy: bad profile ${profilePath}: ${e.message}\n`); }
}

const MODE_OPTS = {
  safe: { maxArrayItems: 1e9, maxStringLen: 600, dropEmpty: true }, // lossless-leaning
  aggressive: { maxArrayItems: 8, maxStringLen: 160, dropEmpty: true },
  off: null,
};

function optsForTool(toolName) {
  const m = (profile.tools && (profile.tools[toolName] || profile.tools.default)) || mode;
  const base = MODE_OPTS[m] || MODE_OPTS.safe;
  if (base === null) return null; // 'off'
  return { ...base, ...(profile.options || {}) };
}

// ---- spawn downstream ----
const child = spawn(childCmd[0], childCmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (e) => { process.stderr.write(`mcpslim-proxy: spawn failed: ${e.message}\n`); process.exit(1); });
child.on('exit', (code) => process.exit(code === null ? 0 : code));

// Forward Claude Code -> child verbatim (requests are tiny; never touch them)
process.stdin.pipe(child.stdin);

// Track which in-flight request ids were tools/call, and the tool name, so we
// only compress the matching responses.
const pendingTool = new Map(); // id -> toolName

// Intercept Claude Code's outgoing requests just to learn id->toolName mapping.
// We tee stdin: still pipe verbatim above, but also sniff lines here.
let inBuf = '';
process.stdin.on('data', (chunk) => {
  inBuf += chunk.toString('utf8');
  let nl;
  while ((nl = inBuf.indexOf('\n')) !== -1) {
    const line = inBuf.slice(0, nl);
    inBuf = inBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg && msg.method === 'tools/call' && msg.id !== undefined && msg.params) {
        pendingTool.set(msg.id, msg.params.name || '(unknown)');
      }
    } catch (_) { /* fail-open: ignore */ }
  }
});

// child -> Claude Code, compressing tools/call results
let outBuf = '';
let savedChars = 0, totalCalls = 0;

child.stdout.on('data', (chunk) => {
  outBuf += chunk.toString('utf8');
  let nl;
  while ((nl = outBuf.indexOf('\n')) !== -1) {
    let line = outBuf.slice(0, nl);
    outBuf = outBuf.slice(nl + 1);
    if (!line.trim()) { process.stdout.write('\n'); continue; }

    let msg;
    try { msg = JSON.parse(line); }
    catch (_) { process.stdout.write(line + '\n'); continue; } // forward verbatim

    // Only touch successful tools/call results that carry content[].text
    if (msg && msg.id !== undefined && pendingTool.has(msg.id) && msg.result && Array.isArray(msg.result.content)) {
      const toolName = pendingTool.get(msg.id);
      pendingTool.delete(msg.id);
      const o = optsForTool(toolName);
      if (o) {
        for (const block of msg.result.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            const before = block.text.length;
            const { text } = compress(block.text, o);
            // Safety: never let "compression" make it bigger
            if (text.length < before) {
              block.text = text;
              savedChars += (before - text.length);
            }
          }
        }
        totalCalls++;
      }
      line = JSON.stringify(msg);
    }
    process.stdout.write(line + '\n');
  }
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('exit', () => {
  if (totalCalls > 0) {
    process.stderr.write(`mcpslim: compressed ${totalCalls} tool result(s), saved ~${Math.round(savedChars/4).toLocaleString()} tokens\n`);
  }
});
