# Design: pointing evolving-mcp at your own server

Status: **proposed, not agreed.** No code until this is signed off.

Goal: an MCP server author can run three commands against a server they already have and get back a concrete answer about what routes their traffic would produce, what those routes would save, and which of them are unsafe. Nothing half-built, nothing that only works on the two reference servers in this repo.

## What is explicitly not in this

Live promotion. The server does not grow tools at runtime, there is no middleware in the request path, and nothing is written back. That needs a promotion gate and eviction, neither of which exist, and shipping it without them would be the half-done release we are avoiding.

What ships is the honest half: **measurement against your own server.** A report that says "these nine call sequences recur, here is what collapsing them would save, and here are the four tools I cannot classify without you."

## The three commands

```
npx evolving-mcp init  -- uvx my-server --flag     # introspect tools, write a config skeleton
npx evolving-mcp trace -- uvx my-server --flag     # sit between client and server, record
npx evolving-mcp report                            # what would be promoted, and what it saves
```

### `init`

Starts the server, calls `tools/list`, writes `evolving-mcp.json` with every tool listed and each one marked. Tools carrying MCP's `readOnlyHint: true` annotation are classified automatically. Everything else is written as `"unclassified"` and the author has to say.

This is the command that makes day one work. Without it, configuration is a blank file and nobody fills one in.

### `trace`

A recording proxy. It speaks MCP on stdio in both directions, forwards every message verbatim, and logs `tools/call` request and response pairs. The author points their existing client at the proxy instead of at their server, works normally for a while, and gets a trace file.

It is instrumentation, not the product. It never rewrites a message, never adds a tool, never blocks a call.

### `report`

Takes the trace file and the config, runs the detector that already exists, and prints candidate routes with their savings, plus everything that could not be promoted and why.

## Decision points

### 1. An unclassified tool is treated as mutating

Pruning decides which calls a route *skips*. Skipping a call with a side effect is the worst thing this system can do, and it is silent when it happens.

So the default is refusal, not a guess. An unclassified tool is assumed to mutate, which means it is never pruned and never silently promoted.

**Rejected: guessing from the name.** Matching `write_*`, `create_*`, `delete_*` is exactly the kind of heuristic that works on the reference servers and then deletes somebody's data on a server that names things differently. There is no version of this where a substring match is a safety boundary.

**Rejected: assuming read-only and warning.** A warning in a report nobody reads is not a control.

The cost is real and should be stated plainly: **a first run with an unclassified config will promote very little.** That is the intended behaviour. The report leads with the list of tools needing classification, so the fix is one edit away rather than a mystery.

### 2. Episode boundaries without protocol sessions

MCP 2026-07-28 removed sessions, so nothing on the wire says where one outcome ends. Three sources, in order of preference:

1. `traceparent` in `_meta`, which the spec documents for exactly this. Used when the client sends it.
2. An idle gap. A configurable window, defaulting to 30 seconds, after which the next call starts a new episode.
3. Process lifetime, when the proxy handled only one short run.

Whichever was used is recorded per episode and named in the report, because an episode boundary guessed from a timer is a different quality of evidence from one the client declared, and the reader deserves to know which they are looking at.

**Rejected: requiring `traceparent`.** It would be cleaner and almost nobody sends it today, so the tool would do nothing for most people.

### 3. Normalizers are registered per tool, not inferred

The config names which normalizer applies to which tool argument. `sql` exists. `path` and `none` are trivial. Anyone else writes their own and registers it.

**Rejected: sniffing the content.** The current SQL normalizer fires on anything starting with `SELECT`, which is fine inside this repo and wrong as a public contract. A tool whose argument happens to start with the word select would get its arguments rewritten by rules that do not apply to it.

### 4. One list of mutating tools, not two

There are currently two `MUTATING` sets, in `prune.ts` and `score.ts`, and they disagree: seven entries against three. A route containing `write_file` is pruned correctly and then reported as non-mutating. Both get replaced by the config, read through one accessor.

This is a bug today, independent of adoption.

## The trace format becomes a contract

The JSONL format stops being an internal detail. It gets a `version` field, a documented schema, and a validator, because people will hand-generate it from their own logs rather than use the proxy.

```jsonc
{
  "version": 1,
  "traceId": "…",        // episode this call belongs to
  "seq": 0,              // position within the episode
  "caller": "…",         // clientInfo name, or "unknown"
  "tool": "list_issues",
  "args": { },
  "result": { },         // the full payload the caller received
  "isError": false,
  "tsMs": 0,
  "latencyMs": 0,
  "resultBytes": 0,
  "resultTokens": 0,     // optional, recomputed if absent
  "boundary": "traceparent" | "idle-gap" | "process"
}
```

`resultTokens` becomes optional and is recomputed when missing, so a hand-written trace does not need a tokenizer.

## Testing

The bar is that this works on a server neither of us has seen.

- **Proxy fidelity, the important one.** A test client talks through the proxy to a real reference server, and every response is asserted byte-identical to talking to the server directly. Including errors, unknown methods, notifications, and a large payload that spans chunk boundaries.
- **Framing.** Partial lines, multiple messages in one chunk, embedded newlines in strings, a message larger than the buffer.
- **Boundary detection.** Each of the three sources, and the transition between them.
- **Config.** Unclassified tools are never pruned. `readOnlyHint` is honoured. A malformed config fails loudly at startup rather than silently disabling a safety rule.
- **Format.** The validator rejects each way a hand-written trace can be wrong, and accepts a minimal valid one.
- **End to end.** `init`, `trace`, `report` against a third server that is not sqlite or filesystem, so nothing in the pipeline can be quietly depending on the two we built against.

That last one matters most. Every server-specific assumption in this repo so far was found by running against a server that broke it.

## Limits, stated up front

The proxy is stdio only. Streamable HTTP is a materially bigger surface and most people trying this on day one are running a local stdio server.

Traffic recorded through a proxy is traffic from whoever is sitting at that machine. It is not the cross-caller aggregation the idea is ultimately about, and the report should not imply otherwise.

A report is not a promotion. Nothing is installed into anybody's server.
