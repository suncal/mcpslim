#!/usr/bin/env node
/**
 * mcpslim CLI — helper for measuring/compressing. The proxy lives in proxy.js
 * (binary: mcpslim-proxy). This is the inspect/measure entrypoint.
 *
 *   mcpslim measure <file...>     # show compression stats on captured payloads
 *   mcpslim compress <file>       # print compressed text to stdout
 */
const fs = require('fs');
const { compress } = require('./compress');

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'measure') {
  require('../test/measure.js');
} else if (cmd === 'compress') {
  const f = rest[0];
  if (!f) { console.error('usage: mcpslim compress <file>'); process.exit(1); }
  const mode = rest.includes('--aggressive') ? { maxArrayItems: 8, maxStringLen: 160 } : {};
  const { text } = compress(fs.readFileSync(f, 'utf8'), mode);
  process.stdout.write(text);
} else {
  console.log(`mcpslim — MCP token-reduction proxy

  mcpslim-proxy [--mode safe|aggressive] [--profile f.json] -- <server cmd>   run the proxy
  mcpslim measure <file...>     measure compression on captured MCP payloads
  mcpslim compress <file>       print compressed output (add --aggressive)

See README.md for Claude Code integration.`);
}
