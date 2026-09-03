# evolving-mcp

An MCP server that writes its own tools from how it gets used.

It watches the calls its own callers make, notices when they keep reaching the same outcome through the same sequence, and adds that outcome to itself as a single new tool. Routes that stop being used get removed. Nobody writes the routes by hand.

This repository is the evidence, not the product. It answers one question offline, against real MCP servers, with a committed corpus anyone can rerun: **is there enough repetition in real traffic to be worth collapsing, and does collapsing it actually save anything.**

## What it found

```
server      who writes the arguments    eps routes  ep cov  suppressible  of that, saved
------------------------------------------------------------------------------------------
sqlite      queries written by hand      64     12   87.5% 54.8% of 42,404    87.1%   1 style
sqlite      queries written by a model   44      6   40.9%  4.9% of 330,112   40.4%   2 styles
filesystem  targets chosen by a model    70      5   97.1% 88.0% of 31,038    97.1%   2 styles
```

Read the three rows in order, because the middle one is the point.

**Row one** is the technique working on a corpus I wrote myself, and it is not trustworthy. Row two is the same thing after a real model wrote the SQL instead. Asked the same question in six different wordings, a model produces between two and six structurally different queries, and lexical matching cannot see through any of it. Most of row one was an artifact of my own consistency.

**Row three** is the same detector against a server whose tools take a `path` instead of a free-form string. Asked seven different ways, callers landed on the same file **97%** of the time. Held out on 21 episodes the miner never saw, **16 of 16** that matched a route replayed to the caller's exact answer, and 89.9% of held-out result tokens never needed to enter a context.

Row three also records every goal through two different explorations: one caller takes a single `directory_tree`, another walks seven directories one at a time. Three calls against eight, different tools. They prune to the same one-step route and merge, so the surface carries one route where it would otherwise carry two.

So the honest claim is narrower and more useful than the one this started with:

> **This works where a tool's arguments are structured. Where a tool takes one free-form string, equivalence is the whole problem.**

## The saving is not what it looks like

Collapsing three calls into one saves a couple of hundred tokens of call syntax, which would not be worth building anything for.

The saving is that **intermediate results never enter the model's context**. A `directory_tree` dumps a whole repository listing in so the model can pick one path out of it. With a route, that listing is consumed inside the server and thrown away, and only the answer comes back.

Which is why `suppressible` is the column that matters. A route returns its final call's result, and that payload is what the caller asked for, so it was never available to suppress. Measuring against every result token instead makes a server look worse the larger its answers happen to be.

## Routes are data, not generated code

A promoted route is a list of upstream calls with bindings, run by one small interpreter:

```json
{
  "name": "read_text_file.395242",
  "steps": [
    { "call": "read_text_file", "args": { "path": { "kind": "const", "value": "/repo/src/db/pool.js" } } }
  ],
  "returns": 0,
  "sourceSteps": [2]
}
```

The caller made three calls to get there: a `directory_tree` to see what existed, a `get_file_info`, then the read. The route makes one. Nothing in the plan reads the listing, because the reasoning it fed is already recorded as the path, so the route skips it. `sourceSteps` records which of the caller's calls each surviving step came from.

It cannot do anything the upstream server could not already do, the server author can read exactly what it will do, and it behaves identically every time. That last property is what lets `npm test` assert the exact set of routes the committed corpus produces, which is the only reason to believe any number on this page.

The alternative, having a model write the route as code, is arbitrary code execution inside the server author's process, it is non-deterministic so the corpus test cannot exist, and it was published as LATM in 2023.

## Reproducing it

```bash
npm install
npm run seed && npm run record       # sqlite corpus, hand-written queries
npm run seed:fs && npm run record:fs # filesystem corpus, model-chosen targets
npm run compare                      # the table above
npm test                             # 28 tests, including the exact route set
```

Model responses are cached in `corpus/llm-cache.json` and committed, so nothing above spends anything. `EMCP_OFFLINE=1` makes a cache miss an error rather than a live call.

Recording talks to the official reference servers. The sqlite one is stale and crashes on the current Python SDK, so it is pinned to `mcp==1.9.4`.

## What this is not

It is not a running server. There is no middleware, no SDK integration and no live promotion here, on purpose. All of that is downstream of knowing the saving is real, and half the interesting findings were defects that only showed up once real payloads were involved.

It is not a claim that independent callers naturally converge on the same path. Sequences in these corpora are scripted. The model chooses targets and writes queries, which is the part that varies, but it does not choose how many calls to make.

## The findings in full

- [Phase 0](docs/findings-phase-0.md) built the detector and verified it replays correctly. Its headline number is superseded.
- [Phase 1](docs/findings-phase-1.md) put a real model in the loop and watched that number collapse.
- [Phase 2](docs/findings-phase-2.md) fixed the denominator, added SQL alias normalization, and tested the discrete-argument case.
- [The original scope](docs/phase-0.md), including the falsifiers, written before any data existed.

Five design defects came out of touching real servers rather than reasoning about them: nothing returns `structuredContent`, tool names alone are not a shape, a window sliced from the middle of an episode is not a route, overlapping candidates double-count, and a parameter whose value only exists in an earlier result forfeits the saving it was supposed to produce. A sixth came from a model hallucinating a table: the server answered `Database error: no such table: orders` and set `isError: false`.

## Next

Projection and construct equivalence for SQL, which needs a parser. A larger discrete-argument corpus, because 35 episodes is carrying more weight than it should. And normalizers registered per tool, since alias renaming is SQL knowledge and there is no universal rule.
