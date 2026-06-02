# mcpslim

**Cut Claude Code / Cursor token usage on the outputs other tools can't touch.**

[RTK](https://github.com/rtk-ai/rtk) compresses **bash command output** (`git status`, `npm test`, `cat`). That's great — but it can't see two of the biggest token drains in modern agent workflows:

1. **MCP tool responses** — database dumps, API JSON, browser tools, search results
2. **Bloated / pretty-printed JSON** that ships indented straight into your context

`mcpslim` is a transparent **MCP proxy** that sits between your agent and your MCP servers and compresses tool results on the way back. It complements RTK — run both.

---

## Honest numbers (measured on real captured MCP payloads, not estimates)

| Payload | Safe mode (default, lossless-leaning) | Aggressive mode (browse/list tools) |
|---|---|---|
| A real 52 KB video-API `list` response | **−12%** | **−90%** |
| A 516 KB pretty-printed JSON file | **−59%** | −99.8% |

**We do not claim "90% on everything."** That's only achievable by truncating data — which silently breaks any workflow that needs the full payload (e.g. "download all 50 results"). Here's the real model:

- **Safe mode (default):** minify JSON, drop empty/null fields, strip base64 blobs, truncate giant strings. **Fully reversible-aware, never drops list items.** Typical **12–60%** with zero risk.
- **Aggressive mode (opt-in per tool):** also truncates long arrays. **Up to 90%** — only enable it on *list/search/browse* tools where you're scanning, not consuming.

You pick per-tool with a one-line profile. Safe is the default precisely so it never breaks you.

---

## How it works

```
Claude Code  ──JSON-RPC──▶  mcpslim-proxy  ──JSON-RPC──▶  real MCP server
             ◀─compressed──                ◀──full────────
```

- Forwards every **request** byte-for-byte (requests are tiny — we never touch them).
- On `tools/call` **results**, compresses `content[].text`.
- **Fail-open:** anything it can't parse is forwarded verbatim. It never makes a payload bigger.
- `initialize`, `tools/list`, errors, notifications — all pass through untouched.
- Newline-delimited JSON-RPC stdio transport.

## Install

```bash
git clone https://github.com/suncal/mcpslim.git
cd mcpslim
npm link        # exposes `mcpslim-proxy` and `mcpslim` on your PATH
```

> Not yet on the npm registry — install from source for now. `npm i -g mcpslim` is coming once it's published.

Quick sanity check (compress a captured payload):

```bash
mcpslim compress some-tool-output.json            # safe mode
mcpslim compress some-tool-output.json --aggressive
```

## Use — wrap an existing MCP server

In your `.mcp.json` / Claude Code MCP config, change the server's launch command to go through the proxy:

```jsonc
{
  "mcpServers": {
    "higgsfield": {
      "command": "mcpslim-proxy",
      "args": [
        "--mode", "safe",
        "--profile", "profiles/higgsfield.json",
        "--",
        "node", "/path/to/original-server.js"   // original command + args
      ]
    }
  }
}
```

That's it. The server behaves identically; outputs are just smaller.

### Per-tool profile (`profiles/higgsfield.json`)

```json
{
  "tools": {
    "show_generations": "aggressive",
    "default": "safe"
  }
}
```

`list`/`browse` tools → aggressive; everything else stays safe.

## Modes

| Mode | Strategies | Use for |
|---|---|---|
| `safe` (default) | minify, drop empties, strip blobs, truncate huge strings | everything — zero risk |
| `aggressive` | + truncate long arrays to first N | list/search/browse tools only |
| `off` | passthrough | debugging |

## What it does NOT do (so you're not surprised)

- It can't compress **images/screenshots** as text (those are vision tokens). *Screenshot downscaling is on the roadmap as a separate pass.*
- It can't touch your agent's **native `Read`/file tool** (not an MCP call). Use RTK's `cat` wrapper for that.
- It won't recover tokens already spent earlier in the conversation.

## Roadmap

- [ ] Screenshot/image downscaling pass for browser & computer-use MCP tools
- [ ] Auto-profiling: learn per-tool safe truncation from observed usage
- [ ] Savings dashboard (tokens saved per server/tool/day)
- [ ] Hosted proxy + team config sync (paid tier)

## License

Apache-2.0. Independent project; concept inspired by RTK (also Apache-2.0). No RTK code is used.
