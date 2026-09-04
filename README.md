# evolving-mcp

**An MCP server that writes its own tools from how it gets used.**

It watches the calls its callers make. When they keep reaching the same outcome the same way, it adds that outcome to itself as a single new tool. Tools nobody uses get dropped again. No human writes any of them.

## What that looks like

Someone asks an agent to open the file that sets up the database connection. Against a normal filesystem MCP server, the agent has to go and find it:

```
directory_tree("/repo")                    568 tokens of listing come back
get_file_info("/repo/src/db/pool.js")       92 tokens
read_text_file("/repo/src/db/pool.js")      89 tokens   the answer
```

Three round trips, and 660 tokens of directory listing sit in the model's context forever, so that it could pick one path out of them.

After this server has seen that happen a few times, it has written itself a tool:

```json
{
  "name": "read_text_file.395242",
  "steps": [
    { "call": "read_text_file", "args": { "path": { "kind": "const", "value": "/repo/src/db/pool.js" } } }
  ],
  "returns": 0
}
```

One call. The listing is never fetched, because nothing needed it except the reasoning that already happened, and that reasoning is now sitting in the route as a constant.

Another caller found the same file a completely different way, by listing seven directories one at a time instead of taking the tree in one go. Eight calls rather than three, different tools entirely. It produces the same route, and the two merge into one tool backed by both.

## The saving is not what it looks like

Collapsing three calls into one saves a couple of hundred tokens of call syntax. That would not be worth building anything for.

The saving is that **the intermediate results never enter the model's context at all**. The directory listing, the schema dump, the thirty issues you fetched to pick one number out of. A route consumes those inside the server and throws them away.

Which is why the number this repo reports is a share of *suppressible* tokens. A route returns its last call's result, and that is the answer the caller wanted, so it was never available to suppress. Counting it in the denominator just makes a server look worse the bigger its answers happen to be.

## Does it actually work

This repository is the evidence, not the product. There is no running server here. It answers one question offline, against real reference MCP servers, on a committed corpus anyone can rerun.

```
server      who writes the arguments    eps routes  ep cov  suppressible  of that, saved
------------------------------------------------------------------------------------------
sqlite      queries written by hand      64     12   87.5% 54.8% of 42,404           87.1%
sqlite      queries written by a model   44      6   40.9%  4.9% of 330,112          40.4%
filesystem  targets chosen by a model   206     15   97.1% 89.3% of 91,130           98.5%
```

Read the rows in order, because the middle one is the point.

**Row one is not trustworthy and it is here to show why.** I wrote those SQL queries myself, so every asking of the same question produced an identical query and clustering worked perfectly. It looked wonderful.

**Row two replaced me with a real model.** Asked the same question in six wordings, it wrote between two and six structurally different queries every time. Different aliases, `SELECT *` against explicit columns, `NOT IN` against `NOT EXISTS`. Most of row one turned out to be a measurement of my own consistency.

**Row three is a server whose tools take a `path` instead of a free-form string.** Asked seven different ways, callers landed on the same file 97% of the time. Held out on 21 episodes the miner had never seen, 16 of 16 matches replayed to the caller's exact answer, and 89.9% of their result tokens never needed to enter a context.

So the claim is narrower and more useful than the one this started with:

> **This works where a tool's arguments are structured. Where a tool takes one free-form string, deciding whether two calls are the same call is the entire problem.**

## Routes are data, not generated code

A route is a list of upstream calls with bindings, run by one interpreter of about 130 lines. No `eval`, no code generation, no model anywhere in the execution path.

That buys three things. A route cannot do anything the upstream server could not already do. The server's author can open it and read exactly what it will do. And it behaves identically every time, which is the only reason `npm test` can assert the exact set of routes the committed corpus produces, and the only reason to believe any number on this page.

The alternative, having a model write each route as a function, means arbitrary generated code executing inside the server author's process, and no reproducible test. It is also [Large Language Models as Tool Makers](https://arxiv.org/abs/2305.17126), published in 2023.

## Point it at your own server

Three commands, nothing installed into your server, nothing about it changed.

```bash
npx evolving-mcp init  -- <how you start your server>   # read tools/list, write a config
npx evolving-mcp trace -- <how you start your server>   # forward everything, record it
npx evolving-mcp report                                 # what recurs, and what it would save
```

`init` classifies any tool that declares MCP's `readOnlyHint`. On the reference filesystem server that is all fourteen, so there is nothing left to do. Anything unannotated is marked unclassified and treated as mutating until you say otherwise, because a route drops calls nothing reads from and dropping one with a side effect is silent and unrecoverable. We do not guess from tool names.

`trace` is a proxy. It forwards both directions byte for byte, and there is a test asserting every response through it is identical to talking to the server directly, including errors, notifications, and payloads far larger than one chunk.

Full walkthrough, the trace format, and how normalizers work: [docs/adopting.md](docs/adopting.md).

## Run the research corpora

```bash
npm install
npm run seed    && npm run record      # sqlite corpus
npm run seed:fs && npm run record:fs   # filesystem corpus
npm run compare                        # the table above
npm run verify                         # replay routes against the live server
npm test                               # 37 tests, including the exact route set
```

Model responses are cached in `corpus/llm-cache.json` and committed, so none of that spends anything. `EMCP_OFFLINE=1` turns a cache miss into an error rather than a live call.

Recording talks to the official reference servers. The sqlite one is stale and crashes on the current Python SDK, so it is pinned to `mcp==1.9.4`.

## What this is not

Not a running server. No middleware, no SDK integration, no live promotion, on purpose. All of that is downstream of knowing the saving is real, and most of what was learned here only appeared once real payloads were involved.

Not a claim that independent callers converge on their own. The model picks targets and writes queries, which is the part that varies, but the exploration shapes were authored by hand.

Not finished. Cross-path agreement, whether two callers exploring differently land in the same place, is 10 of 15. It read as 4 of 5 on a smaller corpus, and tripling the corpus is what showed that up as sampling noise. It is the weakest number here and it should not be quoted as a headline.

## What went wrong, which is most of what was learned

Six defects came out of touching real servers rather than reasoning about them.

Nothing returns `structuredContent`, so dataflow arrives embedded in a Python repr inside a text block. Tool names alone are not a shape, because `read_query` is always `{query: string}` and every question ever asked collapses into one cluster. A window sliced out of the middle of an episode is not a route, it is a truncated one that returns the wrong thing. Overlapping candidates double-count their savings while multiplying their cost. A parameter whose value only exists in an earlier result forfeits the saving it was supposed to produce. And a model invented a table that did not exist, at which point the server replied `Database error: no such table: orders` and set `isError: false`.

Two more came from held-out replay rather than from the test suite, which is the argument for keeping it in the loop: a merged route was unmatchable, and step indices mined from a three-call window point nowhere when the plan is applied to an eight-call one.

## The findings in full

- [Phase 0](docs/findings-phase-0.md) built the detector and verified it replays correctly. Its headline number is superseded.
- [Phase 1](docs/findings-phase-1.md) put a real model in the loop and watched that number collapse.
- [Phase 2](docs/findings-phase-2.md) fixed the denominator, normalized SQL aliases, and tested a discrete-argument server.
- [Phase 3](docs/findings-phase-3.md) replaced lexical matching with a semantic footprint, scored against ground truth.
- [Phase 4](docs/findings-phase-4.md) stopped routes performing exploration they no longer need.
- [Adopting it](docs/adopting.md) on a server of your own, and [the design behind that](docs/design-adoption.md).
- [Phase 6](docs/findings-phase-6.md) tripled the corpus and watched the headline agreement number get worse.
- [Phase 5](docs/findings-phase-5.md) built the corpus that measures the merge, on two real exploration paths.
- [The original scope](docs/phase-0.md), including the falsifiers, written before any data existed.

## Next

Projection and construct equivalence for SQL, which needs a parser rather than regexes. Normalizers registered per tool, since alias renaming is SQL knowledge and no universal rule exists. And eviction, which is not built and is what keeps a route surface from growing until its schema costs more than it saves.
