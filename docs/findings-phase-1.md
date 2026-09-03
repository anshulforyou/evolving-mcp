# Phase 1 findings: a real model writes the queries

Run 2026-09-03. Everything held constant against phase 0 except one thing: the SQL is written by a model (Haiku, single turn, given the schema the episode actually discovered) from a question phrased differently each time. Same server, same database, same goals, same exploration styles, same detector.

Cost: 48 model calls, roughly one dollar. Responses are cached in `corpus/llm-cache.json` and committed, so reruns and other people's clones spend nothing.

## The headline

Phase 0's number did not survive.

| | Phase 0, hand-written SQL | Phase 1, model-written SQL |
|---|---|---|
| Result tokens kept out of context | **47.7%** | **0.6%** |
| Episodes covered by a route | 88% | 23% |
| Routes promoted | 12 | 3 |
| Held-out episodes matching a route | 6 of 15 | 0 of 14 |

The limitation flagged at the top of the phase 0 findings was not a caveat, it was the result. Skeleton matching was the most optimistic possible assumption and almost all of the saving lived inside it.

Stating it plainly: **the 47.7% figure was an artifact of me writing the SQL.** It should not be quoted anywhere.

## Why

48 queries across 8 goals produced **37 distinct skeletons**. Asked the same question six times in six different wordings, a model writes between two and six structurally different queries.

Five kinds of variation, all semantically irrelevant and all fatal to lexical matching:

- **Alias naming.** `SUM(i.total) as revenue` against `as total_spent` against `as total_spending`.
- **Projection.** `SELECT *` against an explicit column list, and different column lists.
- **Join direction.** `FROM tracks t JOIN invoice_items ii` against `FROM invoice_items ii JOIN tracks t`.
- **Equivalent constructs.** `NOT IN (SELECT ...)` against `NOT EXISTS (...)` against `LEFT JOIN ... IS NULL`, all three for one question.
- **Qualification.** `albums.title` against `a.title`.

Where the answer has one obvious form the skeletons do converge. `tracks_longer_than` produced only 2 skeletons from 6 queries, and it promoted. Freedom in the projection is what destroys clustering, not the query's logic.

## The part that makes this recoverable

Consistent alias renaming, on its own, moves the numbers a lot. Not stripping aliases, which does nothing at all because the alias is referenced later in `ORDER BY`, but renaming every alias to a canonical position throughout the query.

| | lexical skeleton | with alias renaming |
|---|---|---|
| Distinct skeletons across 48 queries | 37 | **29** |
| Goals reaching support >= 3 | 3 of 8 | **5 of 8** |

One mechanical transformation, no model involved, takes promotable goals from three to five out of eight. The remainder needs projection normalization and recognizing equivalent relational constructs, which means a real SQL parser rather than string handling.

So the conclusion is not that the idea fails. It is that **equivalence is the entire problem, and it is a semantic normalization problem rather than a frequency threshold problem.** That was the first open question written down about this project, and it is now located precisely instead of being a worry.

## What this says about which servers to target

This inverts the corpus recommendation from the phase 0 plan, and the evidence is what changed my mind.

A database server was chosen as the primary target because its intermediate results are enormous, and that part held up. Result payloads grew eightfold once a model wrote the queries, 330,112 tokens across 44 episodes against 42,404 across 64, because models reach for `SELECT *` and omit `LIMIT`. The prize is bigger than phase 0 suggested.

But a database server is the **worst case for equivalence**, because its entire interface is one free-form string. Two callers with identical intent can write unlimited textually different queries.

A server in the GitHub shape has the opposite property. Its arguments are discrete fields, `repo`, `issue_number`, `state`, so two callers with the same intent produce byte-identical argument structures and there is nothing to normalize. Clustering is trivial there and the dataflow is explicit.

The right primary target is a server with discrete arguments. The database case is worth keeping precisely because it is the hard one, but it should not be what the claim rests on.

## A robustness finding

The model invented a table that does not exist. The reference server replied `Database error: no such table: orders` and set **`isError: false`**, so the recorder banked two failing calls as successes.

A route mined from a failing call is a route that fails reliably. The flag cannot be trusted and the payload has to be inspected, which `looksLikeError` now does. Four episodes are correctly dropped as a result. This will matter more, not less, in a live system where nobody is reading the traces.

## Status against the phase 0 falsifiers

| Falsifier | Phase 0 | Phase 1 |
|---|---|---|
| Token reduction is not large | passed, 47.7% | **fails, 0.6%** |
| Routes do not reproduce the caller's outcome | passed, 6 of 6 | not testable, nothing matched |
| Net goes negative | passed, 22.4x | passes, 11.5x on what promotes |

The mechanism is correct and was verified correct in phase 0. What phase 1 shows is that on a free-form-string server, the mechanism almost never gets to fire.

## Next

Semantic SQL normalization, starting with canonical alias renaming since it is measured and mechanical, then projection and construct equivalence via a parser. And a corpus against a discrete-argument server, which is where this should have started.
