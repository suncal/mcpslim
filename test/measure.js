#!/usr/bin/env node
/**
 * Measure mcpslim compression on REAL captured MCP tool-result samples.
 * Reports exact characters (ground truth) + estimated tokens (chars/4) before/after.
 */
const fs = require('fs');
const path = require('path');
const { compress } = require('../src/compress');

const samples = process.argv.slice(2);
if (samples.length === 0) {
  console.error('usage: node measure.js <sample1> [sample2 ...]');
  process.exit(1);
}

let totalIn = 0, totalOut = 0;
const rows = [];

for (const file of samples) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`skip ${file}: ${e.message}`);
    continue;
  }
  const { text, stats } = compress(raw);
  totalIn += stats.inChars;
  totalOut += stats.outChars;
  rows.push({ file: path.basename(file), ...stats });
}

console.log('\n━━━ mcpslim — measured on REAL samples ━━━\n');
for (const r of rows) {
  console.log(`▸ ${r.file}`);
  console.log(`    mode:            ${r.mode}`);
  console.log(`    chars:           ${r.inChars.toLocaleString()} → ${r.outChars.toLocaleString()}  (−${r.reductionPct}%)`);
  console.log(`    est. tokens:     ${r.estTokensIn.toLocaleString()} → ${r.estTokensOut.toLocaleString()}  (saved ~${r.estTokensSaved.toLocaleString()})`);
  const detail = [];
  if (r.fieldsDropped) detail.push(`${r.fieldsDropped} empty fields dropped`);
  if (r.strTrunc) detail.push(`${r.strTrunc} long strings truncated`);
  if (r.arrTrunc) detail.push(`${r.arrTrunc} arrays truncated`);
  if (r.blobs) detail.push(`${r.blobs} binary blobs removed (${Math.round(r.blobBytes/1024)}KB)`);
  if (r.dupLines) detail.push(`${r.dupLines} duplicate lines collapsed`);
  if (detail.length) console.log(`    what changed:    ${detail.join(', ')}`);
  console.log('');
}

const pct = totalIn > 0 ? Math.round((1 - totalOut / totalIn) * 1000) / 10 : 0;
console.log('━━━ TOTAL ━━━');
console.log(`  chars:       ${totalIn.toLocaleString()} → ${totalOut.toLocaleString()}  (−${pct}%)`);
console.log(`  est. tokens: ${Math.round(totalIn/4).toLocaleString()} → ${Math.round(totalOut/4).toLocaleString()}  (saved ~${Math.round((totalIn-totalOut)/4).toLocaleString()})`);
console.log('');
