# Phase 6: tripling the corpus, and what got worse

Run 2026-09-04. 140 model calls, roughly two and a half dollars.

Phase 5 rested its conclusion on five goals. I said a larger corpus would move the load-bearing number from suggestive to solid. It moved it, in the other direction.

## What was built

The filesystem corpus went from 5 goals to 15, same two exploration styles, same seven phrasings each. 206 episodes, 1,123 calls. Four episodes dropped: three transient CLI failures and one where the model answered with `/package.json`, a path outside the tree, which the server refused.

## The number that got worse

**Cross-path agreement fell from 4 of 5 to 10 of 15.** 80% on the small corpus, 67% on the larger one.

That is the claim phase 5 leaned on, that two callers taking different exploration routes reach the same place, and it is weaker than five goals made it look. Anyone quoting 80% would have been quoting sampling noise.

## Why, and it is not symmetric

The two explorations are not equally good at deciding.

| style | goals where all seven phrasings picked one file |
|---|---|
| `tree`, one `directory_tree` call | **14 of 15** |
| `walk`, seven `list_directory` calls | **11 of 15** |

The walk style is the unreliable one. It sees the same files, but as seven separate per-directory listings rather than one structure, and it picks worse. It answered `read_health_route` with `src/server.js`, and it scattered `read_retry_lib` across `retry.js`, `pool.js` and `deploy.md`.

**Exploration shape affects decision quality, not only cost.** Nothing in this project anticipated that. A cheaper-looking exploration is not a neutral substitute for a richer one, which matters because a route mined from a bad exploration bakes a bad decision in permanently.

## What held up

The system numbers survived tripling, and two improved.

| | 5 goals | 15 goals |
|---|---|---|
| Episodes | 70 | 206 |
| Routes | 5 | 15 |
| Episodes covered | 97% | **97%** |
| Calls absorbed | 97% | 96% |
| Suppressible tokens saved | 97.1% | **98.5%** |
| Upstream calls a route never makes | 340 | **936** |
| Schema payback per corpus pass | 116.8x | **117.4x** |

Held out, mining on 138 episodes and replaying against the live server on 68 unseen: **50 of 68 matched a route and 50 of 50 replayed to the caller's exact answer.** Nothing came back different, nothing threw. Suppression on held-out episodes is 59.3%, down from 90.1%, because 18 of 68 held-out episodes matched no route at all at three goals' worth of support each.

The merge also held. Twelve of the fifteen routes are backed by both exploration styles, including several goals where the walk style disagreed on a minority of phrasings but the majority still converged.

## What this changes

Two things worth carrying forward.

**Stop quoting cross-path agreement as a headline.** It is 67% and it is the weakest number in the repository. The defensible claims are the ones about the mechanism: routes replay correctly, they suppress most of what is suppressible, and they pay their schema cost back two orders of magnitude over.

**Exploration quality is a variable nobody has been treating as one.** If routes are mined from whatever callers happen to do, and some callers explore in ways that produce worse decisions, then a promoted route can encode a mistake that every subsequent caller inherits. Support alone does not catch it, because eleven callers making the same bad pick looks exactly like eleven callers making the same good one. This is a better argument for a promotion-time check than the over-merging it was originally proposed to catch, and over-merging never materialised.

## Limitations

Both exploration styles are still hand-authored. A model choosing its own exploration would vary more.

Fifteen goals over a nineteen-file tree is dense enough that several goals sit near each other, which is realistic but makes some ambiguity inevitable. `read_auth_module` remains genuinely ambiguous between `session.js` and `tokens.js` under both styles, and that one is the question's fault rather than the exploration's.
