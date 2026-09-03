# Phase 0 scope: prove the saving is real

Status: proposed. Target spec MCP 2026-07-28. TypeScript.

## What evolving-mcp is

An MCP server that watches its own traffic, notices when callers keep reaching the same outcome through the same sequence of calls, and adds that outcome to itself as a single new tool. Routes it stops seeing get removed. Nobody writes the routes by hand. The server author installs it as middleware over a server they already have, and the tool surface starts reshaping itself around what its callers actually do.

## Scope, stated as a limitation

This works for MCP servers where chained, composable calls exist. The shape where one call's result feeds the next: list something, fetch one of them, act on it. GitHub, a database server, a filesystem server. It does not claim anything about servers made of twenty unrelated one-shot tools, because on those there is no chain to collapse and nothing to promote.

This is a deliberate narrowing, not an oversight, and it belongs in the README. A reader who discovers the limit themselves reads it as a hole. A reader who is told it upfront reads it as rigor.

## What phase 0 answers

The original question was whether recurring chains exist in MCP traffic at all. The narrowing above retires that question, because we are now selecting for servers that have the property. Measuring repetition on a corpus chosen for repetition proves nothing.

The real question is the one that decides whether anyone should care:

**Does collapsing a chain into one route produce a large, measurable reduction in tokens and in wall-clock time, and does the detector get the routes right?**

Phase 0 answers that offline. A trace corpus and a detector. No server, no middleware, no protocol work.

## Where the saving actually comes from

This is the part that reframes the project, and it is not what it first looks like.

The saving is not the call syntax. Three tool calls instead of one is a couple of hundred tokens and would not be worth building anything for.

The saving is that intermediate results never enter the model's context. In the GitHub example, `list_issues` returns thirty issues, several thousand tokens, so that the model can read out a single number. Then `get_issue` returns a full issue body for the model to read. With a route, all of that is consumed inside the server and thrown away. Only the final result comes back.

So the headline metric is not calls eliminated. It is **bytes of intermediate result that never entered the context**. That number is far larger, it is measurable directly from the corpus, and it is the honest description of what this does.

Latency has the same shape. Three model round trips become one, and model inference dominates the round trip, so the time saving is large and easier to demonstrate convincingly than the token saving.

## The counter-pressure, and where the promotion rule comes from

Every promoted route adds its schema to `tools/list`, and `tools/list` is paid on every request by every caller, whether they use that route or not. Promote two hundred routes and the server can spend more on tool descriptions than it ever saves.

```
net = (intermediate tokens saved per use  x  how often it is used)
      - (route schema cost  x  every request from everyone)
```

Two things fall out of this.

Eviction is not hygiene. It is what keeps the net positive, which makes it load-bearing rather than a nice-to-have.

And the promotion rule stops being a hand-tuned frequency threshold. Promote a route when its expected saving exceeds the schema cost it imposes on every caller. Evict it when it stops clearing that bar. The economics decide, which is both more defensible and more interesting than a number somebody picked.

## Components

### Corpus

Traces of MCP traffic against real servers, with repetition that we build in deliberately rather than hope for.

Per call we record: trace id, timestamp, caller identity, tool name, full arguments, full result including structuredContent, isError, latency, and the byte and token size of the result. That last field is the one the headline metric is computed from, so it is not optional.

For synthesized traffic we also record a goal label, meaning what the caller was actually trying to do. It is ground truth. It lets us check whether the clusters the detector finds line up with real intents or with coincidence, and that check cannot be done without it.

Episodes are segmented by OpenTelemetry trace id, per the 2026-07-28 spec. Protocol sessions no longer exist, so the trace id is the only sanctioned way to say that a set of calls was one outcome.

Caller diversity is designed in rather than discovered. Vary phrasing per run, vary the model where possible, and include goals that sit near each other without being identical so the detector has to decide rather than pattern-match. Building the corpus by asking one model the same sentence fifty times manufactures the result and proves nothing.

### Detector

Six stages, offline and deterministic.

**Segmentation.** Group calls into episodes by trace id.

**Canonicalization.** Reduce an episode to a shape: ordered tool names plus argument structure with values stripped. Episodes differing only in values must produce the same shape.

**Mining.** Find recurring shapes across episodes. Contiguous subsequences only in phase 0, since the promotion target is a straight replay. Gapped patterns are real and explicitly deferred.

**Dataflow extraction.** The intellectual core. Within a cluster, classify every argument of every call as one of three things. Constant, when the value is identical across every instance, so it gets baked in. Parameter, when it varies freely, so it becomes an input on the generated tool. Derived, when it matches a value found in an earlier call's result, so it becomes an internal binding the caller never sees.

Derived detection is an exact-value search through prior results, recording the JSON path where the value was found. This is more tractable than it sounds, because with protocol sessions gone the spec now pushes servers to return explicit handles and take them back as ordinary tool arguments. The dependency graph tends to be written on the wire rather than hidden in connection state.

**Synthesis.** Emit a candidate route with a name, description, input schema built from the parameters, and a plan. Names must satisfy the MCP tool name rules, meaning 1 to 128 characters from letters, digits, underscore, hyphen and dot, unique within the server.

**Scoring.** Support, how many episodes back it. Intermediate tokens saved per use. Schema cost it would add. Net, from the equation above. Stability, whether the dataflow classification held across every instance rather than most. Risk, whether the sequence contains anything that mutates state.

### Route representation

Three candidates. This is decided by measurement in phase 0, not by argument.

**Option 1, a recipe.** The route is stored as data. An ordered list of upstream calls with bindings, executed by one small fixed interpreter.

```json
{
  "name": "reply_to_newest_open_issue",
  "inputSchema": { "type": "object", "properties": { "repo": {"type":"string"}, "body": {"type":"string"} } },
  "steps": [
    { "call": "list_issues", "args": { "repo": {"$param":"repo"}, "state": "open" } },
    { "call": "get_issue",   "args": { "repo": {"$param":"repo"}, "number": {"$from":"steps[0].structuredContent[0].number"} } },
    { "call": "create_comment", "args": {
        "repo": {"$param":"repo"},
        "issue_number": {"$from":"steps[0].structuredContent[0].number"},
        "body": {"$param":"body"} } }
  ],
  "returns": { "$from": "steps[2]" }
}
```

Cannot do anything the upstream server could not already do. Inspectable as JSON by the server author. Deterministic, which is what allows the golden test. Its limit is that it cannot branch, so any chain whose shape depends on a mid-sequence result is not promotable.

**Option 2, generated code.** A model writes a function that performs the calls, and the server runs it. Can branch. Costs arbitrary code execution inside the server author's process, non-determinism that destroys the golden test, and it is LATM, published in 2023.

**Option 3, a recipe plus a small number of control primitives.** Not generated code, just a slightly richer declarative format the interpreter still fully controls. Likely candidates are "take the first item matching a predicate" and one conditional.

### How the representation gets decided

Options 1 and 2 produce identical savings per route. A single collapsed call costs the caller the same tokens regardless of how the server executes it. Choosing between them on tokens-per-route would compare two nearly equal numbers and settle nothing.

They differ on **coverage**. Generated code can express chains a recipe cannot, so it promotes more of them, so across a whole workload it can save more in total. Not because each route is better, but because there are more routes. That is the only axis on which the choice is real, and it is measurable.

So phase 0 measures two things and lets them decide:

1. **Straight-line fraction.** What proportion of mined chains a plain recipe can express. High means option 1 wins outright, same saving with far less risk.
2. **The primitive gap.** For every chain a recipe cannot express, the smallest primitive that would fix it. If that list is short, option 3 takes most of option 2's coverage while keeping option 1's safety and determinism. If it is long and varied, option 2's extra coverage is real money and the tradeoff has to be argued on its merits.

## Evaluation

Mine on seventy percent of episodes, validate replay against the held-out thirty.

- Intermediate tokens eliminated per outcome, before and after. The headline number.
- Model round trips eliminated, and measured wall-clock difference.
- Schema cost added per route, and the resulting net.
- Straight-line fraction, and the primitive gap list.
- Dataflow stability, the fraction of clusters whose argument classification holds across every instance rather than most.
- Route correctness, meaning a replayed route on held-out episodes produces the same final result the original chain did.

**What would falsify this.** Decided now, before seeing any data.

- If token and time reduction on held-out episodes is not large, the project does not have a reason to exist. "Large" means it survives being written on a slide next to the honest cost.
- If replayed routes do not reproduce the original outcome reliably, the detector is finding coincidence rather than intent, and equivalence becomes the project instead of the framework around it.
- If net stays negative once schema cost is charged against every request, the economics do not work and eviction alone will not save it.

## Tests

- Dataflow classifier against hand-written fixtures, covering constant, parameter and derived, plus the ambiguous case where a value appears in two different prior results.
- Canonicalizer, asserting episodes that differ only in values collapse to one shape.
- Plan interpreter against a mock server, including a step that fails partway through.
- Generated names against the MCP tool name rules.
- Golden test: the committed corpus produces a deterministic, snapshot-checked set of routes. This is the one that matters publicly, and it is why determinism is worth paying for.

## Not in phase 0

No server. No middleware. No SDK integration. No live promotion. No auth scoping. No protocol work. Every one of those is downstream of knowing the saving is real.

## Corpus targets, proposed

Three servers, picked for different reasons rather than three of the same thing.

**A database server (sqlite or postgres reference).** The strongest chain shape there is: list tables, describe one, then query it. Intermediate results are enormous, which is exactly where the headline metric lives. If the saving does not show up here it will not show up anywhere, so this is the primary target.

**GitHub.** Realistic, deep chains, and the surface most people picture when they think about agents using MCP. This is where the promoted routes will be legible to a reader, so it is the demo target even if the database server produces bigger numbers.

**Filesystem (the reference server).** Shallow chains and less interesting routes, but it needs no credentials at all. That makes it the one target where a stranger can clone the repo and reproduce the golden test on their own machine without keys, an account, or rate limits. For a repo whose entire purpose is being believed, that matters more than the quality of the routes it produces.

Rejected: Slack. It fits the story, and it is the example that keeps coming up, but the setup cost is a workspace and an app install before anyone can reproduce anything.

## Still open

Whether the primary target should be the database server or GitHub, if only one gets built first.
