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

### 1. Credentials never enter a route (a guard, not a decision)

Routes are mined from real traffic and real traffic carries authorization. A credential captured as a `const` binding would mean every later caller running a route with **someone else's authority**.

This is table stakes rather than a design choice, so it is stated as a rule the implementation must satisfy, not as a question. Two guards, both mandatory.

**Execute with the calling caller's credentials, never the miner's.** The route makes upstream calls on behalf of whoever invoked it, so the upstream server applies its own authorization exactly as it would have. This is what makes the whole thing safe by default: we are not deciding who may do what, the server still is.

**Refuse to constant-fold anything the author marks sensitive.** A config list of argument paths that may never become a `const` or a template literal, no matter how stable they look across a cluster. Tenant ids, account ids, API keys, user ids. If such a value is the only thing distinguishing two members of a cluster, the cluster is rejected rather than promoted with the value baked in.

**Rejected: detecting secrets by pattern.** Entropy checks and key-shaped-string heuristics work until the day they do not, and the failure is silent and severe. The author names the fields.

**Decided: routes are global, not scoped per authorization context.** The spec would permit scoping, by letting `tools/list` vary with the authorization presented, and it would be marginally safer. It would also remove the cross-caller aggregation that is the entire point, so it is not the default.

The residual risk that leaves, stated rather than designed around: a route's **existence** reveals that somebody once did that thing. A route whose constant is a path or an identifier tells every caller that path or identifier exists, even though calling it still gets them nothing they were not authorized for, because execution uses their own credentials. Authors on a multi-tenant server should mark tenant identifiers sensitive, which stops them being folded and therefore stops them being disclosed.

### 2. No eviction in this version, which forces two other things

Eviction is out of scope here. That is a deliberate cut and it decides two things that follow from it.

**`propose` becomes the only supported default.** Without eviction there is no mechanism to withdraw a route that begins failing, and pruned routes do bake in a picture of the world that can go stale: a schema, a path, a set of table names. In `propose` mode that is not a problem, because the route lives in a file the author reviewed and committed, and removing it is a revert like any other broken tool. `live` mode without eviction would leave a failing route failing for everyone with no way out, so it stays gated behind an explicit opt-in and a warning until eviction exists.

**Promotion needs a ceiling instead.** A surface that only grows costs more schema on every request forever. So the store holds at most `maxRoutes`, and a new candidate has to beat the weakest incumbent on payoff to displace it. That bounds the cost without any withdrawal machinery, and displacing a route that was never served is not a breaking change.

**Deferred, and worth remembering when eviction is built:** removing a route is a breaking change to a public interface. A caller that learned one and finds it gone simply fails, and clients cache `tools/list` so they may not see it go. When this is built it should tombstone rather than delete, leaving something that answers with an explanation.

### 4. The route store is a file, not a database

A JSON file the author can read, diff, review and commit. That is what makes `propose` mode work at all, keeps `live` mode auditable, and means a route surface can be rolled back with git rather than a migration.

**Rejected: an embedded database.** Better for concurrent writes, unreviewable by a human, and the thing being stored is small and changes rarely.

### 5. Announcing a change

`notifications/tools/list_changed` exists but a client only receives it if it opened a `subscriptions/listen` stream, which most do not. The fallback is `ttlMs` on `tools/list`, which the 2026-07-28 revision made a required field.

Proposed: advertise a short ttl while the surface is still changing and a long one once it settles, and emit the notification for the clients that did subscribe. The server tells callers how settled it currently is, which is honest and costs nothing.

## What this does not do

Eviction. A route, once promoted, stays until the author removes it from the store.

Streamable HTTP. The proxy is stdio, which covers most servers people run today and none of the hosted ones. A hosted Slack-shaped server needs HTTP and that is a materially larger surface: header handling, no sessions, concurrency. Named as a limit rather than smuggled in.

Cross-instance aggregation. One deployed proxy learns from its own traffic. Several instances behind a load balancer each learn separately unless they share a store, and sharing a store across instances is a distributed systems problem this design does not solve yet.

## Testing bar

- A route added at runtime appears in `tools/list` and is callable, and the upstream server never sees a request it did not already understand.
- Promotion in `propose` mode changes the store and never the served surface.
- The store never exceeds `maxRoutes`, and a stronger candidate displaces the weakest incumbent rather than being dropped.
- An argument marked sensitive is never constant-folded, never appears in a template literal, and a cluster that depends on folding one is rejected rather than promoted.
- A route executes with the credentials of whoever called it, never those captured during mining.
- Everything the recording proxy already guarantees, still guaranteed once it is also serving routes: byte-identical passthrough for everything that is not a promoted route.
- End to end against a server this repo was not built for, as before.
