# Phase 0 scope: does the signal exist?

Status: proposed, not agreed. Nothing gets built until this is signed off.
Target spec: MCP 2026-07-28. Language: TypeScript.

## What evolving-mcp is, in one paragraph

An MCP server that watches its own traffic, notices when many independent callers keep reaching
the same outcome through the same sequence of calls, and adds that outcome to itself as a single
new tool. Routes it stops seeing get removed. Nobody writes the routes. The server author installs
it as middleware over a server they already have, and their tool surface starts reshaping itself
around what its callers actually do.

## What phase 0 is for

There is exactly one assumption holding this project up, and it is not an engineering assumption.

**Does real MCP traffic actually contain recurring, parameterizable sequences worth promoting?**

Not "can we detect them". Whether they exist at all. If real traffic turns out to be mostly one-shot
and heterogeneous, there is nothing to promote and no amount of middleware saves it. Every other
risk in this project is ordinary engineering. This one is not, and it is cheap to test.

Phase 0 answers it offline. No server, no middleware, no SDK integration, no protocol work. A trace
corpus and a detector that reads it.

The corpus is not throwaway. It becomes the repo's headline test, the one that lets a stranger
reproduce the promotion results in a single command. That is the thing that makes a research-shaped
repo credible instead of a demo.

## Components

### 1. Corpus

Traces of real MCP traffic with genuine repetition across callers.

Record shape per call: trace id, timestamp, caller identity, tool name, full arguments, full result
including structuredContent, isError, latency. For the synthesized set, also a goal label recording
what the caller was actually trying to do. The goal label is ground truth. It lets us check whether
the clusters the detector finds correspond to real intents or to coincidence, which is the whole
question and cannot be checked without it.

Segmentation unit is the OpenTelemetry trace id, per the 2026-07-28 spec. Protocol sessions no
longer exist, so the trace id is the only sanctioned way to say "these calls were one outcome".

Where the traffic comes from, in order of preference:

**Primary, synthesized against real servers.** Take two or three real public MCP servers with
non-trivial surfaces. Write twenty to twenty-five realistic user goals with deliberate overlap
between them. Run an agent on each goal repeatedly with varied inputs. Log everything. Rough target
is a low four-figure call count, enough that repetition is measurable rather than anecdotal.

**Threat to validity, and it is serious.** If every caller is the same model with the same prompt
style, repetition is manufactured and the result is worthless. This has to be attacked directly:
vary the model where possible, vary phrasing and persona per run, and include goals that are near
each other but not identical so the detector has to decide rather than pattern-match. If we cannot
create caller diversity, the phase 0 result is not trustworthy and should be reported as such
rather than dressed up.

**Secondary, cross-validation.** Check whether MCP-Universe or similar published benchmarks expose
usable trajectories. If they do, mine them as an independent set. Agreement between an independent
corpus and ours is worth more than any number from ours alone.

**Rejected: instrumenting personal usage.** Real, but one caller and low volume, which is exactly
the population this project claims not to be about.

### 2. Detector

Six stages, offline, deterministic.

**Segmentation.** Group calls into episodes by trace id.

**Canonicalization.** Reduce an episode to a shape: the ordered tool names plus the structure of the
arguments with values stripped. Two episodes that differ only in values must canonicalize
identically.

**Mining.** Find recurring shapes across episodes. Contiguous subsequences only in phase 0, because
the promotion target is a straight replay. Gapped patterns are a real thing and explicitly deferred.

**Dataflow extraction.** This is the intellectual core. Within a cluster, classify every argument of
every call as one of three things.

- Constant, when the value is identical across every instance. It gets baked into the route.
- Parameter, when it varies freely. It becomes an input on the generated tool.
- Derived, when it matches a value found in an earlier call's result. It becomes an internal binding
  and never appears on the route's surface.

Derived detection is an exact-value search through prior results, recording the JSON path where the
value was found. This is more tractable than it sounds. With no protocol sessions, the spec now
pushes servers to return explicit handles and take them back as ordinary tool arguments, so the
dependency graph tends to be written on the wire rather than hidden in connection state.

**Synthesis.** Emit a candidate route: name, description, input schema built from the parameters,
and a plan. Generated names must satisfy the MCP tool name rules, which is 1 to 128 characters from
letters, digits, underscore, hyphen and dot, unique within the server.

**Scoring.** Support, meaning how many episodes back it. Coverage, meaning what fraction of total
calls it would remove. Stability, meaning whether the dataflow classification held across every
instance rather than most. Risk, meaning whether the sequence contains anything that mutates state.

### 3. Route representation

This is the largest architectural decision in the project and it is a decision point, not a
conclusion.

**Proposed: a declarative plan.** A route is an ordered list of upstream calls with bindings,
executed by one small fixed interpreter.

```json
{
  "name": "create_basket_and_add",
  "inputSchema": { "type": "object", "properties": { "sku": { "type": "string" } } },
  "steps": [
    { "call": "create_basket", "args": {} },
    { "call": "add_item", "args": {
        "basket_id": { "$from": "steps[0].structuredContent.basket_id" },
        "sku":       { "$param": "sku" } } }
  ],
  "returns": { "$from": "steps[1]" }
}
```

**Rejected: having a model write the route as code.** Three reasons. It is arbitrary code execution
inside the server author's process, which is the one thing that makes this unshippable. It is
non-deterministic, so the golden corpus test cannot exist and the repo loses its credibility
mechanism. And it is LATM, published in 2023, so it is the least novel option available.

A declarative plan cannot do anything the upstream server could not already do, is inspectable as
JSON by the server author, and unit tests cleanly.

**The limit this creates, stated honestly.** A declarative plan has no conditionals, no loops and no
error-recovery branches. Any episode whose shape depends on what came back mid-sequence is not
promotable in phase 0. What fraction of real episodes are straight-line is itself one of the
findings, and if it turns out to be small then declarative plans are the wrong call and codegen is
forced. That is a result phase 0 should be willing to produce.

### 4. Evaluation

Mine on seventy percent of episodes, validate replay against the held-out thirty.

Four numbers:

- Repetition rate. What fraction of episodes land in a cluster with support of at least three.
- Compression. Calls per outcome before and after promotion, measured on held-out episodes.
- Straight-line fraction. How many episodes a declarative plan can express at all.
- Dataflow stability. What fraction of clusters produce argument classifications that hold across
  every instance rather than most of them.

**What would falsify the idea.** Concrete, decided now rather than after seeing the numbers.

- Repetition rate below roughly twenty percent means there is no signal in real traffic and the idea
  is dead as stated. Not "needs a better detector". Dead.
- Dataflow stability below roughly seventy percent means equivalence is a harder problem than the
  framework around it, and the project should become that problem instead of shipping middleware.
- A low straight-line fraction forces the representation decision back open.

## Tests

- Dataflow classifier against hand-written fixtures, covering each of constant, parameter and
  derived, plus the ambiguous case where a value appears in two different prior results.
- Canonicalizer, asserting that episodes differing only in values collapse to one shape.
- Plan interpreter against a mock server, including a step failing partway through.
- Generated names against the MCP tool name rules.
- Golden test: the committed corpus produces a deterministic, snapshot-checked set of routes. This
  is the one that matters publicly.

## Explicitly not in phase 0

No server. No middleware. No SDK integration. No eviction. No auth scoping. No live promotion. No
protocol work at all. Those are real parts of the project and every one of them is downstream of
knowing whether the signal exists.

## Open, needs a decision

- Which real MCP servers to build the corpus against.
- Whether caller diversity can be made real enough for the result to mean anything, which is the
  question that decides whether phase 0 is worth running at all.
