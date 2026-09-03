# Phase 4 findings: routes stop performing the exploration

Run 2026-09-04. No model calls. Follows [phase 3](findings-phase-3.md), which left the bottleneck in the call sequence rather than the query text.

## The problem

A goal explored two ways produces two sequences. One caller inspects two tables before querying, another inspects one, and no amount of normalizing the query lets those meet, because a route is the whole sequence.

## The fix, and it is stronger than absorbing a prefix

A `describe_table` exists so the model can write the next query. Once that query is sitting in the plan as a literal, the reasoning has already happened and been recorded. **If no later step reads anything out of a call's result, the route does not need to make the call at all.**

So steps are pruned from the plan when nothing binds to their result, unless they are the step whose result is returned or they mutate state. Pruning runs to a fixed point, since removing one step can orphan the step it was reading from, and surviving `from` bindings are renumbered.

What this buys, measured:

| corpus | upstream calls a route never makes |
|---|---|
| sqlite, hand-written | 149 |
| sqlite, model-written | 48 |
| filesystem | 68 |

Every filesystem route now runs **one** upstream call where the caller made three. It skips `directory_tree` and `get_file_info` outright. The schema cost falls too, since a smaller plan means a smaller tool description.

Correctness held. Held-out replay against the live servers, with pruned routes: filesystem 8 of 8 matched and 8 of 8 identical, sqlite 6 of 6 identical.

## The attempt that failed, and why it is the interesting part

The obvious next move was to mine on the pruned sequences, so that the caller who inspected two tables and the caller who inspected one would finally land in the same cluster. That was built and it destroyed the results: every corpus dropped to zero or two routes.

Strip the exploration calls away and reading the auth module and reading the deploy doc are the same two calls. All five filesystem goals collapsed into one cluster of `read_text_file(path)` with the path free.

**Clustering and execution are different questions and I had conflated them.** An exploration call does not belong in the route's execution, because nothing reads it. It absolutely belongs in the route's identity, because it is the only thing saying which outcome this is.

So the working arrangement is: mine on what the caller actually did, prune only the plan, then merge any two clusters whose pruned plans came out identical. A unit test covers the case directly. Six episodes, three that explored once and three that explored twice, reaching the same outcome, become **one** route with support 6 that executes a single call.

## A defect the pruning exposed

Pruning a route down to its last call can leave the upstream tool wearing a hat. `read_query(query)` takes exactly what `read_query` takes and contributes nothing.

It is worse than merely useless, because it scores well. The exploration calls it drops really were suppressed, so the arithmetic looks fine. But nobody can write that query without reading the schema first, so the caller makes those calls anyway and the saving never happens.

A route is now refused when one step survives and every argument of it is a free parameter. Three such routes were being generated on the hand-written sqlite corpus and one on the model-written one.

The rule is narrow on purpose. Targets sharing even a prefix produce a template instead, and a template carries real knowledge. `"file-" + <param>` is a route. `<param>` is not.

## Where the corpora landed

| corpus | routes | episodes covered | of suppressible, saved |
|---|---|---|---|
| sqlite, hand-written | 12 | 88% | 87.1% |
| sqlite, model-written | 6 | 41% | 40.4% |
| filesystem | 5 | 97% | 97.1% |

Coverage did not move. Pruning does not create clusters, it makes the routes cheaper to run and stops them depending on a sequence at execution time. On these corpora the merge step rarely fires, because when two exploration paths lead a model to write genuinely different SQL, those are different outcomes and should not merge. It fires when the outcome really is the same, which the unit test demonstrates and which a corpus with two working exploration styles over one server would show at scale.

## Limitations

The merge is only exercised by a unit test on synthetic episodes. The filesystem corpus has one exploration style, because the `search_files` style was dropped in phase 2, and the sqlite corpus's two styles genuinely produce different queries. A corpus with two styles that reach identical outcomes would measure it properly and does not exist yet.

A pruned route trusts that the world it was mined against still holds. Nothing re-checks the schema or the directory listing, so a change turns a working route into a failing one. That is what error-driven eviction is for and eviction is not built.

The mutating-tool list is hand-maintained. MCP has annotations for this now, but neither reference server sets them, so skipping a call that turns out to have had a side effect is a real hazard on a server nobody has audited.
