# Phase 3 findings: a semantic footprint, measured against ground truth

Run 2026-09-03. No model calls, because none were needed. Every episode carries a `goalId` recording what the caller was actually trying to do, and that label is never an input to the detector, so any normalizer can be scored against intent rather than against itself.

Reproduce with `npm run footprint`.

## The idea

Stop comparing query text. Compare what the query *touches*: tables read, columns projected, columns grouped by, columns filtered on, aggregates applied. Aliases resolved to the tables they name, literals dropped, join order and projection order dropped.

Two strengths, because the tradeoff is the point. **Strict** keeps the projection, so `SELECT *` and `SELECT name` stay apart since they hand the caller different answers. **Loose** drops it and merges more.

## Result

Model-written SQL corpus, 44 queries across 8 goals.

| normalizer | distinct keys | mean per goal | purity | goals reaching support 3 |
|---|---|---|---|---|
| raw string | 33 | 4.13 | 1.00 | 3 of 8 |
| skeleton, literals masked only | 33 | 4.13 | 1.00 | 3 of 8 |
| skeleton + alias renaming | 25 | 3.13 | 1.00 | 5 of 8 |
| footprint, strict | 20 | 2.50 | 1.00 | 5 of 8 |
| **footprint, loose** | **16** | **2.00** | **1.00** | **7 of 8** |

`purity` is the share of keys belonging to exactly one goal. **It is 1.00 everywhere.** Not a single normalizer at any strength merged two different questions.

**A correction to phase 2.** Masking literals on its own does nothing at all, 33 keys against 33. Every gain attributed to the lexical skeleton came from alias renaming, which was folded into the same function. The phase 2 table did not separate them and it should have.

## What this says about a promotion-time model check

The plan was a cheap normalizer that over-merges, with one model call at threshold to reject clusters that are not really the same question.

**On this corpus that check would never fire.** Over-merging did not happen at any strength tested.

Its useful job is the opposite one. Under the strongest setting, five goals still split, and reading them one by one:

- `customers_without_invoices` splits `NOT IN (SELECT ...)` from `NOT EXISTS (...)`. Genuinely the same question. A real miss.
- `albums_by_artist` splits a join from a correlated subquery. Also the same question. A real miss.
- `top_customers_by_spend`, `top_tracks_by_revenue`, `tracks_per_genre` split queries that return **different columns**, names against bare ids. Arguably these are correct splits, not failures, because the caller gets different data back.

So of five remaining splits, two are misses and three are the normalizer doing its job. A model call is worth making, but as a **merge assistant on the recall side**, not a rejection gate on the precision side. That is a different prompt and a different place in the pipeline.

Keep it a gate either way. It should approve, reject or merge candidates that were mined mechanically. The moment it writes the plan, determinism is gone and the golden test with it.

## The bottleneck moved

Wiring the footprint into the detector end to end barely helped: suppressible tokens saved went from 38.2% to 40.4%, and episode coverage fell from 48% to 41% while calls absorbed rose from 38% to 42%.

A big improvement in query clustering did not translate, and the reason is measurable.

| | distinct full-episode shapes |
|---|---|
| lexical skeleton | 29 |
| semantic footprint | 20 |

Better, but **every goal still has at least two shapes**, because every goal was explored two ways, and the two styles make a different number of `describe_table` calls before querying. A route is a whole call sequence, so normalizing the argument cannot cross a difference in the sequence itself.

That is the next real problem, and it was deferred in the phase 0 plan under "gapped patterns are real and deferred". There is now evidence it matters more than the query text does. `list_tables > describe_table > describe_table > read_query` and `list_tables > describe_table > read_query` reach the same outcome; the extra inspection is exploration, not part of what the caller wanted. A route should be able to absorb a variable-length exploration prefix instead of demanding an exact sequence match.

## Limitations

Eight goals, deliberately distinct from one another. Purity of 1.00 across eight well-separated questions is weak evidence that it holds across two hundred overlapping ones on a real server. This is the number most likely to degrade at scale, and it is exactly the number the promotion-time check exists to protect.

The footprint is regexes, not a parser. It resolves aliases and splits on top-level commas, and it will mis-read nested subqueries, window functions and CTEs. It returns null rather than guessing when it cannot find a table, and those fall back to the lexical skeleton.

Only SQL has a footprint. This is per-tool knowledge by design, not a universal rule, which is the architectural point rather than a gap.
