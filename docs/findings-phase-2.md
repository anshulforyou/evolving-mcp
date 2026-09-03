# Phase 2 findings: alias normalization, and a server with discrete arguments

Run 2026-09-03, following [phase 1](findings-phase-1.md). Two changes, both of which phase 1 pointed at.

## 1. Canonical alias renaming

Phase 1 measured that consistent alias renaming would help and left it unimplemented. It is implemented now, in `src/detect/sql.ts`, and it fires only on strings that look like SQL.

Renaming, not stripping. Stripping the definition does nothing at all, because the alias is referenced again in `ORDER BY` and the two strings still differ. Every alias is rewritten to a canonical position and every use of it follows.

On the model-written sqlite corpus:

| | before | after |
|---|---|---|
| Routes promoted | 3 | **7** |
| Episodes covered | 23% | **48%** |
| Calls absorbed | 13% | **38%** |
| Share of suppressible tokens saved | 12.1% | **38.2%** |

One mechanical transform, no model in it, roughly triples the reach. What is left is projection choice and semantically equivalent constructs, which need a parser rather than word boundaries.

## 2. The denominator was wrong

Phase 0 and phase 1 both reported savings as a share of *all* result tokens. That is the wrong denominator and it flattered phase 0 while burying phase 2.

A route returns its final call's result. That payload is what the caller asked for and reaches them either way, so it was never available to suppress. The honest denominator is everything except it.

The correction changes the story, and it is worth seeing what it does to phase 0's headline:

| corpus | share of all result tokens | share of *suppressible* tokens |
|---|---|---|
| sqlite, hand-written queries | 47.7% | **87.1%** |
| sqlite, model-written queries | 1.9% | **38.2%** |
| filesystem, model-chosen targets | 89.9% | **97.1%** |

The drop caused by a model writing the SQL is real, but it is 87% to 38%, not 47.7% to 0.6%. The 0.6% figure was mostly an artifact of the model dropping `LIMIT` and returning enormous answers, which inflates a denominator the technique can never touch.

On the model-written sqlite corpus only **4.9%** of all result tokens were suppressible at all. That is the ceiling for this technique on that server, regardless of how good the equivalence handling gets.

## 3. A discrete-argument server, which is what phase 1 said to build

Recorded against the reference filesystem server. Its tools take a `path`, not a free-form string. The model still makes the decision that matters: given a real `directory_tree` listing, which file answers this question.

Asked the same thing seven different ways, five goals, 35 episodes:

**97% of repeat askings landed on the same file.** Four of five goals had complete agreement across all seven phrasings. The fifth split between `src/auth/session.js` and `src/auth/tokens.js`, which is a genuine ambiguity in the question rather than noise.

| | model-written SQL | model-chosen paths |
|---|---|---|
| Episodes covered by a route | 47.7% | **97.1%** |
| Calls absorbed | 38% | **97%** |
| Suppressible share of all tokens | 4.9% | **92.5%** |
| Of suppressible, saved | 38.2% | **97.1%** |
| Held-out episodes matched | 0 of 14 | **8 of 8** |
| Held-out replayed correctly | not testable | **8 of 8** |
| Held-out tokens suppressed | 0% | **92.2%** |

Held out, mining on 27 episodes and replaying against the live server on 8 it never saw: every one matched a route, every one came back with the caller's exact answer, and 92.2% of the held-out result tokens never needed to enter a context.

## What this settles

**The target inversion from phase 1 is confirmed, with a verified held-out number rather than an argument.** Where a tool's arguments are discrete, callers with the same intent produce byte-identical arguments, there is nothing to normalize, and the technique works close to its theoretical ceiling. Where a tool takes one free-form string, equivalence is the entire problem and the ceiling is low anyway because the answer dominates the token mass.

That is a sharper claim than the project started with and it is the one worth making: **evolving-mcp is for servers whose tools take structured arguments.** A SQL-shaped server is the interesting hard case, not the pitch.

**Normalization is per-tool, not universal.** Alias renaming is SQL knowledge and fires on a SQL heuristic. A real framework registers normalizers against tools rather than pretending one rule covers every composed string. That is an architectural consequence, not a detail.

## Limitations

Five goals and 35 episodes on the filesystem corpus is small. The 97% agreement figure carries the weight of the conclusion and deserves a larger corpus before it goes in a README as a headline.

The filesystem tree is synthetic and shallow, so file contents are small. In a real repository the final `read_text_file` payload would be much larger and the suppressible share would fall from 92.5% toward something more modest. The structural point survives, the specific number will not.

Sequences are still scripted. The model chooses targets and writes queries, which is the decision that varies, but it does not choose how many calls to make or in what order. Phase 1's caveat stands: this corpus cannot claim that independent callers naturally converge on the same path.

Alias renaming rewrites any identifier that shares a name with a real column. Doing it properly needs a parser.

The `search_files` style was dropped from the filesystem corpus. Several patterns matched nothing, the model then answered in prose instead of a path, and rather than spend more on fixing it the style was removed. So the filesystem result covers one exploration style, not two.
