# Pointing this at your own server

Three commands. Nothing is installed into your server and nothing about it changes. What you get back is a measurement: which call sequences your traffic repeats, what collapsing them would save, and which of them are unsafe to touch.

```bash
npx evolving-mcp init  -- <how you start your server>
npx evolving-mcp trace -- <how you start your server>
npx evolving-mcp report
```

## 1. init

```bash
npx evolving-mcp init -- npx -y @modelcontextprotocol/server-filesystem /repo
```

Starts your server, reads `tools/list`, and writes `evolving-mcp.json` listing every tool.

Any tool declaring MCP's `readOnlyHint` annotation is classified for you. Some servers set it on everything, and then there is nothing left to do. The reference filesystem server classifies all fourteen of its tools this way, correctly marking `write_file`, `edit_file`, `create_directory` and `move_file` as mutating.

Anything without that annotation is written as `"unclassified"` and needs one word from you:

```json
{
  "version": 1,
  "tools": {
    "read_query":   { "mutability": "read-only", "normalizers": { "$.query": "sql" } },
    "write_query":  { "mutability": "mutating" },
    "list_tables":  { "mutability": "read-only" }
  }
}
```

**Why you have to say.** A route drops calls nothing reads from. Dropping one with a side effect is the worst thing this system can do and it is silent when it happens, so an unclassified tool is assumed to mutate and is never dropped. We do not guess from the name: matching `write_*` and `create_*` works on every server we tested and would delete somebody's data on a server that names things differently.

`init` is re-runnable. It keeps every classification you have already made and only adds tools it has not seen.

## 2. trace

Point your existing MCP client at the proxy instead of at your server. In a client config, that means replacing your server command with:

```
npx evolving-mcp trace --out my.trace.jsonl -- <your original command>
```

Then work normally. Everything is forwarded untouched, in both directions, byte for byte. The proxy never rewrites a message, never adds a tool, never blocks a call, and never delays one.

**Episodes.** MCP removed protocol sessions in the 2026-07-28 revision, so nothing on the wire says where one piece of work ends. Three sources, in order:

1. `traceparent` in `_meta`, which the spec documents for exactly this, used whenever your client sends it.
2. A gap in time. Thirty seconds by default, configurable as `mining.idleGapMs`.
3. The proxy's own lifetime.

Every row records which one it used, and `report` tells you the mix. A boundary guessed from a timer is weaker evidence than one your client declared, and you should know which you are looking at.

A consequence worth expecting: **a script firing calls back to back looks like one long episode.** That is why an automated run often produces exactly one, and why a route needs traffic from real use rather than a smoke test.

## 3. report

```bash
npx evolving-mcp report --trace my.trace.jsonl
```

Tells you what recurred, what it would save, what is blocked and why, and what is still unclassified.

## Bringing your own traces

You do not have to use the proxy. The format is a versioned contract and you can generate it from logs you already have. One JSON object per line:

```jsonc
{
  "version": 1,
  "traceId": "…",   // which episode this call belongs to
  "seq": 0,          // position within that episode
  "tool": "list_issues",
  "args": { },
  "result": { },     // the full payload the caller received
  "caller": "…",     // optional
  "isError": false,  // optional
  "tsMs": 0,         // optional
  "latencyMs": 0,    // optional
  "boundary": "traceparent" | "idle-gap" | "process"   // optional
}
```

Only `traceId`, `seq`, `tool`, `args` and `result` are required. Sizes and token counts are recomputed when absent, so you do not need a tokenizer to write one of these. Anything malformed is rejected with the line number rather than quietly skipped.

## Normalizers

A normalizer decides whether two calls that look different mean the same thing. **Most servers need none**, because a tool with discrete arguments like `read_text_file(path)` produces byte-identical arguments from two callers with the same intent, and that is the case this works best on.

It only matters for a tool taking a **composed string**: SQL, GraphQL, a shell command, a search query. Four tiers:

| tier | what it is | who does anything |
|---|---|---|
| 0 | discrete arguments cluster as they are | nobody |
| 1 | derived from the result shape | nobody, and it is off by default because it was measured and it loses |
| 2 | a built-in named per argument (`sql`, `path`, `opaque`) | you, one line |
| 3 | your own function for your own language | you, in code |

Tier 1 is off deliberately. On our hardest corpus, no normalizer promotes 3 routes and saves 12.1% of suppressible tokens, the derived result shape promotes 2 and saves 8.5%, and a declared `sql` normalizer promotes 6 and saves 40.4%. It looked good in isolation and lost under integration. `EMCP_DERIVED=1` turns it back on if your traffic disagrees with ours.

## What you will not get

**No live promotion.** Your server does not grow tools, nothing sits in your request path, and nothing is written back. That needs a promotion gate and eviction, neither of which is built, and shipping without them would be the half-done release this deliberately is not.

**No cross-caller aggregation.** Traffic through a proxy is traffic from whoever is at that machine. The idea this project is ultimately about is a server learning from many independent callers, and a local proxy cannot show that.

**A report is not a route.** Nothing is installed anywhere.
