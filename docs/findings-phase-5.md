# Phase 5: closing the gap the merge was never measured on

Run 2026-09-04. 35 model calls, roughly sixty cents.

Phase 4 built a merge step so that one goal explored two different ways would become one route, and then had to admit it was only exercised by a unit test on synthetic episodes. No corpus contained two exploration paths that reach the same outcome. This builds one.

## The corpus

The filesystem corpus now records every goal twice, through two genuinely different explorations:

- **tree**: `directory_tree` once to see everything, then `get_file_info`, then the read. Three calls.
- **walk**: `list_directory` on the root and then on each of six subdirectories, assembling the same picture piece by piece, then the read without checking. Eight calls.

Different tools, different lengths, same information available. The model still makes the decision that matters: given this listing, which file answers the question. 5 goals, 7 phrasings each, both styles. 70 episodes, 385 calls.

## Does a different exploration reach the same place

**4 of 5 goals landed on an identical file through both paths.** The fifth is `read_auth_module`, which splits between `src/auth/session.js` and `src/auth/tokens.js`, and it splits the same way under both styles, so that is ambiguity in the question rather than instability in the exploration.

## Does the merge fire

Yes, on real data, for every route.

```
read_text_file.395242  support=14  styles=[walk,tree]  runs=1  skips=5
read_text_file.f1b85a  support=14  styles=[walk,tree]  runs=1  skips=5
read_text_file.ee9d55  support=14  styles=[walk,tree]  runs=1  skips=5
read_text_file.d2d46e  support=14  styles=[walk,tree]  runs=1  skips=5
read_text_file.8bde88  support=12  styles=[walk,tree]  runs=1  skips=5
```

A three-call episode and an eight-call episode, using different tools, prune to the same one-step plan and merge into a single route backed by all fourteen. Without the merge these would be ten routes, each charging its own schema cost against every caller on every request.

| | |
|---|---|
| Episodes covered | 68 of 70, **97%** |
| Calls absorbed | 374 of 385, **97%** |
| Suppressible tokens saved | **97.1%** |
| Upstream calls a route never makes | **340** |
| Schema payback over one corpus pass | **116.8x** |

## Held out

Mining on 49 episodes, replaying against the live server on 21 it never saw:

**16 of 16 matched, 16 of 16 replayed to the caller's exact answer, 89.9% of held-out result tokens suppressed.** Every one of those matches came from a route mined across both styles, and both styles appear in the held-out set, so routes learned partly from one exploration path are answering episodes that took the other.

## Two defects this shook out

**A merged route was unmatchable.** Merging replaces a cluster's shape with the plan, and held-out matching was keyed on the cluster shape, so no merged route could ever be found. It showed as 0 of 16 matched. Matching now indexes every member's own window shape.

**`sourceSteps` does not survive a merge.** It records where each surviving step sat in the window it was mined from, which is fine for reporting and wrong the moment a plan mined from a three-call window is applied to an eight-call one. Params are now recovered by aligning the plan's steps against the episode's calls by tool name from the end, which is length-independent. A route is a suffix and its steps are an ordered subsequence of it, so that alignment is unambiguous.

Both were caught by held-out verification rather than by tests, which is the argument for keeping it in the loop.

## Limitations

Five goals. The 97% figures rest on a narrow corpus and the single most load-bearing number in this repository, cross-path agreement, is 4 out of 5.

Both exploration styles were written by me. A model choosing its own number of calls could vary more than two hand-authored shapes do, and this corpus still cannot speak to that.

The tree style calls `get_file_info` and the walk style does not, which is deliberate variation but also means the two paths differ in a way I chose rather than one a caller chose.
