# Phase 7: the impressive number only holds for intents already seen

Run 2026-09-05. No model calls. Reproduce with `npm run holdout`.

Three phases went into understanding where this fails, on SQL. Nothing went into pressure-testing where it succeeds. This does that, and the result changes what the project claims.

## The flaw in every earlier held-out test

Every one split episodes at random, so **every goal appeared in both halves**. That measures whether a route survives a new phrasing or a different exploration path of a question the miner has already seen. It says nothing about a question nobody has asked before, and real traffic is mostly questions nobody has asked before.

Holding out whole goals instead costs nothing and answers it.

## The result

Filesystem corpus, 206 episodes, 15 goals.

| split | routes | episodes covered | held-out suppressible saved |
|---|---|---|---|
| episode holdout, the intent is already known | 15 | **98%** | **96.5%** |
| leave-one-goal-out, the intent is new | 14.1 avg | **11%** | **3.2%** |

On the model-written SQL corpus it is **0% either way**.

And the 11% is not generalization. Four files in the tree are reached by more than one goal, because the model sometimes answers two different questions with the same file:

```
src/db/pool.js       <- read_db_pool, read_retry_lib
docs/deploy.md       <- read_deploy_doc, read_retry_lib
tests/money.test.js  <- read_money_lib, read_money_test
src/server.js        <- read_health_route, read_server_entry, read_router
```

Take those away and coverage of a genuinely new intent is **zero**.

## Which is correct, and should have been said from the start

A route is a specific outcome. It cannot cover an outcome it has never seen, and it was never going to. The system **amortizes repetition; it does not anticipate**.

That is not a defect, it is the definition of the thing. But it means the 97% and 98.5% figures are *within known intents*, and reporting them without that qualifier implies a generalization the data does not support.

## What it actually means for anyone adopting this

The value of a route surface is:

```
how repetitive your traffic is   x   how expensive each repeat is
```

Neither term is knowable in general. A server whose callers ask a small number of things over and over gets most of the benefit. A server whose traffic is nearly all novel gets close to nothing, no matter how good the detector is.

This makes `report` more useful rather than less. The honest answer to "will this help me" is not a number from our corpus, it is: **run it on your traffic and find out**, which is precisely what the tool does.

It also explains the shape of the phase 6 result. Coverage held at 97% when the corpus tripled because the goals tripled too. Add episodes without adding goals and coverage rises; add goals without adding episodes and it falls.

## Limitations of this experiment

Leave-one-goal-out is the pessimistic bound in the same way episode holdout is the optimistic one. Real traffic is neither: it has a head of repeated intents and a tail of novel ones, and where a given server sits between the two is exactly what nobody can tell them in advance.

Fifteen goals is few enough that removing one removes a meaningful share of the corpus, which makes each fold harsher than a real long tail would be.
