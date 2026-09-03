# Phase 0 findings

Run against the official `mcp-server-sqlite` reference server on 2026-09-03. Reproduce with `npm run seed && npm run record && npm run report && npm run verify && npm test`.

## Verdict

The saving is real and larger than expected. It is also measured on a corpus whose weakest property is exactly the one the biggest number depends on, and that limitation is stated in full below rather than buried.

Against the three falsifiers written into the plan before any data existed:

| Falsifier | Result |
|---|---|
| Token reduction is not large | **Passes.** 47.7% of all result tokens kept out of context in sample, 17.0% on held-out episodes. |
| Replayed routes do not reproduce the caller's outcome | **Passes.** 6 of 6 matched held-out episodes replayed to a byte-identical answer. |
| Net stays negative once schema cost is charged to every caller | **Passes.** One pass over the corpus pays the added schema cost back 22.4 times. |

## Numbers

Corpus: 64 episodes, 257 calls, 4 callers, 9 goals, 42,404 result tokens.

In sample, after non-overlapping selection: 12 routes, covering 88% of episodes and absorbing 89% of calls, keeping 20,246 of 42,404 result tokens out of context for 902 tokens of added schema.

Held out, mining on 70% and replaying against the live server on the 30% never seen: 8 routes mined, 6 of 15 episodes matched a route, all 6 correct, 1,905 of 11,201 held-out result tokens suppressed.

The gap between 47.7% and 17.0% is the honest generalization gap and it is mostly corpus size. Training on 49 episodes at a support threshold of 3 yields only 8 routes, so 9 of 15 held-out episodes had no route to match. More traffic closes that; nothing else needs to change.

## What the real server changed about the design

Five things came out of touching a real server rather than reasoning about one. Each was a defect in the plan, not in the idea.

**Nothing returns structured content.** 253 of 257 results were a Python repr inside a text block. Not JSON, single quotes, `None` for null. The plan assumed the spec's handle convention would make dataflow explicit and addressable. Real servers predate that. Derivation has to run over a reconstruction of a text blob, so a normalization stage exists that the plan did not have.

**Tool names are not a shape.** `read_query` is always `{query: string}`, so on tool names alone every question ever asked of the database collapses into one cluster with unrelated SQL in it. The first detector run blocked 6 of 8 clusters for exactly this reason. Canonicalization now includes a skeleton of composed strings, with quoted literals and numbers masked and keywords kept, so `WHERE customer_id = 12` and `= 77` cluster while a different query does not. This is the equivalence problem from the very first conversation, located in a specific mechanism.

**A prefix is not a route.** The highest scoring candidate in an early run appeared to suppress 8,947 tokens. It was a three-call window sliced out of the middle of longer episodes, and what it actually did was return the second table's schema while discarding the first and the query the caller was building toward. A route stands in for an outcome, and an outcome is where the caller stopped, so windows must now end where the episode ends.

**Overlapping candidates double-count.** Summing per-candidate savings gave a call coverage of 139%, which is how it surfaced. The same result can only be kept out of context once, while every route's schema is paid separately. Routes are now chosen greedily against calls already covered, and a route is only taken if it still pays for its own schema on that incremental basis.

**A discovered param forfeits the saving.** If a route takes a parameter whose value only exists inside one of its own early results, the caller has to make that call to learn it, so those tokens arrive anyway. Counting them as saved is the most flattering possible error and it had to be corrected in two places.

## The representation question

The plan said this would be decided by measurement, on two numbers. One of them turned out to be unusable and the other gives a partial answer.

**Straight-line fraction is vacuous and is not reported.** Once canonicalization clusters by string skeleton, members share token structure by construction, so templating cannot fail. The number would read 100% whatever the data said. Episode and call coverage are reported instead.

**The primitive gap is small.** Three instances, all the same primitive: a value that exists in an earlier result but at a different position each time, which a select-by-predicate step would internalize. One primitive, not a long list.

So the recipe was sufficient for every route that survived, and one small primitive would absorb the remainder. On this evidence option 3 is the answer and generated code is not justified.

That said, **this corpus cannot settle the question**, and it would be dishonest to claim it did. Branching is what generated code buys, and no scripted sequence in this corpus branches, so nothing here exercises the case that would favour it. The decision is supported, not proven.

## Limitations

**The largest one, which the headline number depends on.** The SQL in this corpus was written by hand, so the same intent always produces a byte-stable skeleton. A real model asked the same question twice will vary column order, aliases, whitespace and formatting, and those variants would not share a skeleton and would not cluster. Skeleton matching is therefore the most optimistic possible assumption, and the first job of phase 1 is to put a real model in the loop and find out how much of the 47.7% survives. Expect meaningfully less.

Sequences are scripted from task definitions rather than produced by a live model. The server, the payloads and their sizes are real, which is why the token arithmetic stands. What this corpus cannot claim is that independent callers naturally converge on the same path.

Latency is not measured. Every underlying call still runs, so upstream time is unchanged; the real saving is one model inference per round trip removed, which needs a model to measure. Round trips saved is reported instead of a time figure.

Token counts use `cl100k_base`, not Claude's tokenizer. Absolute figures move a few percent. Every claim here is a ratio between two quantities counted the same way, which does not.

Route names and descriptions are generated mechanically. They land in the schema, so they are the cost side of the payoff ratio, and a model writing better ones would move that number in either direction.

Nine of fifteen held-out episodes matched no route. That is the support threshold meeting a small corpus, not a detector failure, but it means held-out coverage is measured on a thin slice.

## What phase 1 needs

A real model generating the traffic, to find out how much of the saving survives natural SQL variation. That single question dominates everything else here.
