/**
 * mcpslim — generic context compressor for MCP tool outputs.
 *
 * Pure function. Takes a string (an MCP tool result's text content) and returns
 * a compressed string + a stats object. No per-server knowledge required, but
 * optional profiles can sharpen results for known servers.
 *
 * Strategies (all reversible-aware — we annotate what we dropped so the model
 * knows data was omitted rather than silently lying):
 *   1. JSON-aware recursive transform:
 *        - drop empty arrays / empty objects / null / "" (high-noise, zero-signal)
 *        - truncate long arrays to first N items + an {_omitted} sentinel
 *        - truncate long string values to head+tail + (NNN chars omitted)
 *        - replace base64 image blobs / data URIs with a size placeholder
 *   2. Text fallback (non-JSON): collapse consecutive duplicate lines (xN),
 *        truncate very long blocks.
 *
 * Everything is configurable; defaults are tuned to be safe (never drop a
 * scalar that carries meaning like id/status/url).
 */

const DEFAULTS = {
  maxArrayItems: 8, // keep first N items of any long array
  maxStringLen: 160, // truncate string values longer than this
  dropEmpty: true, // drop [], {}, null, "" fields
  base64MinLen: 256, // treat strings >= this that look like base64 as blobs
  // Keys whose values we never truncate/drop (signal-bearing identifiers)
  keepKeys: new Set([
    'id', 'status', 'state', 'error', 'code', 'name', 'type', 'model',
    'url', 'rawUrl', 'href', 'path', 'next_cursor', 'cursor', 'total',
    'count', 'message',
  ]),
};

const BASE64_RE = /^(data:[^;]+;base64,)?[A-Za-z0-9+/]{200,}={0,2}$/;

function looksBase64(s, minLen) {
  return s.length >= minLen && BASE64_RE.test(s.replace(/\s+/g, ''));
}

function truncStr(s, max) {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.7);
  const tail = Math.floor(max * 0.15);
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}…[+${omitted} chars]…${s.slice(s.length - tail)}`;
}

function isEmpty(v) {
  if (v === null || v === '' ) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (v && typeof v === 'object' && Object.keys(v).length === 0) return true;
  return false;
}

function transform(node, opts, stats, key = null) {
  // Strings
  if (typeof node === 'string') {
    if (looksBase64(node, opts.base64MinLen)) {
      const kb = Math.round((node.length * 0.75) / 1024);
      stats.blobs++;
      stats.blobBytes += node.length;
      return `[binary blob ~${kb}KB removed by mcpslim]`;
    }
    if (key && opts.keepKeys.has(key)) return node; // never truncate signal keys
    if (node.length > opts.maxStringLen) {
      stats.strTrunc++;
      return truncStr(node, opts.maxStringLen);
    }
    return node;
  }

  // Arrays
  if (Array.isArray(node)) {
    let arr = node.map((v) => transform(v, opts, stats));
    if (opts.dropEmpty) arr = arr.filter((v) => !isEmpty(v));
    if (arr.length > opts.maxArrayItems) {
      const kept = arr.slice(0, opts.maxArrayItems);
      const omitted = arr.length - opts.maxArrayItems;
      stats.arrTrunc++;
      kept.push({ _omitted: omitted, _note: `${omitted} more items omitted by mcpslim` });
      return kept;
    }
    return arr;
  }

  // Objects
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const tv = transform(v, opts, stats, k);
      if (opts.dropEmpty && isEmpty(tv) && !opts.keepKeys.has(k)) {
        stats.fieldsDropped++;
        continue;
      }
      out[k] = tv;
    }
    return out;
  }

  // numbers / bools
  return node;
}

/**
 * compress(text, options) -> { text, stats }
 */
function compress(text, options = {}) {
  const opts = { ...DEFAULTS, ...options, keepKeys: options.keepKeys || DEFAULTS.keepKeys };
  const stats = {
    mode: null,
    inChars: text.length,
    outChars: 0,
    blobs: 0,
    blobBytes: 0,
    strTrunc: 0,
    arrTrunc: 0,
    fieldsDropped: 0,
    dupLines: 0,
  };

  let out;
  // Try JSON first
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = undefined;
  }

  if (parsed !== undefined) {
    stats.mode = 'json';
    const t = transform(parsed, opts, stats);
    out = JSON.stringify(t);
  } else {
    // Text fallback: collapse consecutive duplicate lines, truncate long blocks
    stats.mode = 'text';
    const lines = text.split('\n');
    const collapsed = [];
    let i = 0;
    while (i < lines.length) {
      let j = i + 1;
      while (j < lines.length && lines[j] === lines[i]) j++;
      const run = j - i;
      if (run > 1) {
        collapsed.push(`${lines[i]}  [×${run}]`);
        stats.dupLines += run - 1;
      } else {
        collapsed.push(lines[i]);
      }
      i = j;
    }
    out = collapsed.join('\n');
    if (out.length > opts.maxStringLen * 40) {
      out = truncStr(out, opts.maxStringLen * 40);
    }
  }

  stats.outChars = out.length;
  stats.reductionPct = stats.inChars > 0
    ? Math.round((1 - stats.outChars / stats.inChars) * 1000) / 10
    : 0;
  // Rough token estimate: ~4 chars/token (JSON is denser, ~3.5; we use 4 conservatively)
  stats.estTokensIn = Math.round(stats.inChars / 4);
  stats.estTokensOut = Math.round(stats.outChars / 4);
  stats.estTokensSaved = stats.estTokensIn - stats.estTokensOut;

  return { text: out, stats };
}

module.exports = { compress, DEFAULTS };
