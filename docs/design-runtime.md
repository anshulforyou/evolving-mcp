# Design: the live half

Status: **proposed, not agreed.** No code until this is signed off.

Everything shipped so far measures. This is the part where a server actually grows tools.

## Where it sits, and I have changed my mind

Earlier in this project I argued for middleware wrapping the author's SDK server object and explicitly rejected a proxy. The evidence since then says the opposite, and the reason I gave originally does not apply here.

**The original objection was about the wrong proxy.** I rejected a *caller-side* proxy, installed by whoever is using the server, because it sees one caller and the whole idea depends on aggregating across many. A **server-side** proxy, deployed by the author in front of their own server, sees every caller they have. The aggregation is intact.

**And a proxy is the only shape that reaches anybody.** MCP servers are written in TypeScript, Python, C#, Go, Rust, Java, Ruby and more. An SDK wrapper helps whichever one we write, which is TypeScript, and nobody else. A proxy is language-agnostic and the adoption cost is a line of deployment config.

**We already have one and it is tested.** The recording proxy forwards byte-for-byte, and there is a test asserting every response through it is identical to talking to the server directly, including errors, notifications, split frames and payloads far larger than a chunk. The runtime is that proxy with two more behaviours: it adds routes to `tools/list`, and it answers a call to one.

So: **a server-side proxy the author deploys in front of their existing server.** Nothing about their server changes.

## Promotion mode is a config setting, not a fork

The two modes share everything except what happens at the moment a route qualifies.

**`propose`** writes the route to the store and stops. The author reviews a diff and commits it. The route goes live on their next deploy. Nothing autonomous ever happens.

**`live`** makes the route callable immediately and announces it.

Same policy, same store, same executor. I recommend `propose` as the default, because the first version of this that anyone will run in front of real traffic is the one that cannot surprise them, and because the pitch "point this at your server and it sends you a PR with the tools you should have written" is a thing somebody adopts on a Tuesday. `live` is what they turn on once they trust it.

## Decision points

### 1. Credentials must never be baked into a route (security)

This is the one I will not decide alone.

Routes are mined from real traffic, and real traffic carries authorization. If a value that was part of somebody's credentials or tenancy is captured as a `const` binding, then every later caller runs a route carrying **someone else's authority**. That is a privilege escalation with our name on it.

Two protections, and I think both are required.

**Execute with the calling caller's credentials, never the miner's.** The route makes upstream calls on behalf of whoever invoked it, so the upstream server applies its own authorization exactly as it would have. This is what makes the whole thing safe by default: we are not deciding who may do what, the server still is.

**Refuse to constant-fold anything the author marks sensitive.** A config list of argument paths that may never become a `const` or a template literal, no matter how stable they look across a cluster. Tenant ids, account ids, API keys, user ids. If such a value is the only thing distinguishing two members of a cluster, the cluster is rejected rather than promoted with the value baked in.

**Rejected: detecting secrets by pattern.** Entropy checks and key-shaped-string heuristics work until the day they do not, and the failure is silent and severe. The author names the fields.

**Open, and I want your call:** should a route mined under one authorization context be offered to callers in another at all? The spec permits `tools/list` to vary by the authorization presented, which gives us a legal way to scope routes to the context they were learned in. That is safer and it weakens the cross-caller aggregation that is the point of the project. I lean toward scoping by default with an opt-out, but this trades directly against your thesis.

### 2. Eviction is a breaking change to a public surface

I have been describing eviction as the thing that keeps the net positive. It is also a removal from an interface other people are using.

A caller that learned to use `reply_to_newest_issue` and finds it gone gets an error. Clients cache `tools/list`, so they may not even know it went. This is worse in `live` mode, where the route appeared without anybody deciding it should.

Proposed: **a route is never removed outright.** It is retired into a tombstone that still answers, returning a tool execution error saying it was withdrawn and what to call instead. Tombstones cost a little schema and are dropped once nothing has called them for a long time.

**Rejected: silent removal.** Cheapest, and it makes the surface unreliable in a way that is invisible until somebody's agent breaks.

### 3. A failing route is demoted immediately

Pruning bakes in a picture of the world: a schema, a path, a set of table names. When the world moves, a pruned route fails. Nothing re-checks it.

So error rate is a first-class eviction trigger, and it is fast: a route that fails more than a small number of times in a row is withdrawn without waiting for any decay window. This is the safety net that makes pruning acceptable at all, and it is the reason pruning cannot ship without eviction.

### 4. The route store is a file, not a database

A JSON file the author can read, diff, review and commit. That is what makes `propose` mode work at all, keeps `live` mode auditable, and means a route surface can be rolled back with git rather than a migration.

**Rejected: an embedded database.** Better for concurrent writes, unreviewable by a human, and the thing being stored is small and changes rarely.

### 5. Announcing a change

`notifications/tools/list_changed` exists but a client only receives it if it opened a `subscriptions/listen` stream, which most do not. The fallback is `ttlMs` on `tools/list`, which the 2026-07-28 revision made a required field.

Proposed: advertise a short ttl while the surface is still changing and a long one once it settles, and emit the notification for the clients that did subscribe. The server tells callers how settled it currently is, which is honest and costs nothing.

## What this does not do

Streamable HTTP. The proxy is stdio, which covers most servers people run today and none of the hosted ones. A hosted Slack-shaped server needs HTTP and that is a materially larger surface: header handling, no sessions, concurrency. Named as a limit rather than smuggled in.

Cross-instance aggregation. One deployed proxy learns from its own traffic. Several instances behind a load balancer each learn separately unless they share a store, and sharing a store across instances is a distributed systems problem this design does not solve yet.

## Testing bar

- A route added at runtime appears in `tools/list` and is callable, and the upstream server never sees a request it did not already understand.
- Promotion in `propose` mode changes the store and never the served surface.
- A route whose upstream calls start failing is withdrawn, and the withdrawal is visible in the store.
- A tombstoned route answers with an error rather than vanishing.
- An argument marked sensitive is never constant-folded, and a cluster that depends on folding one is rejected.
- Everything the recording proxy already guarantees, still guaranteed once it is also serving routes: byte-identical passthrough for everything that is not a promoted route.
- End to end against a server this repo was not built for, as before.
