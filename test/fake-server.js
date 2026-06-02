#!/usr/bin/env node
/**
 * A minimal fake MCP server for integration-testing the proxy.
 * Speaks newline-delimited JSON-RPC over stdio. On any tools/call it returns
 * the real Higgsfield 52KB sample as the text content, so we can verify the
 * proxy compresses a genuine payload end-to-end.
 */
const fs = require('fs');
const SAMPLE = process.env.MCPSLIM_SAMPLE;

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '1' }, capabilities: {} });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: [{ name: 'show_generations', description: 'demo' }] });
    } else if (msg.method === 'tools/call') {
      const text = fs.readFileSync(SAMPLE, 'utf8');
      reply(msg.id, { content: [{ type: 'text', text }] });
    } else if (msg.id !== undefined) {
      reply(msg.id, {});
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
