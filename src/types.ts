/**
 * Core contracts for evolving-mcp phase 0.
 *
 * Everything here is offline. A corpus of recorded calls goes in, candidate
 * routes and the numbers that justify them come out.
 */

/** One tools/call observed against an upstream server. */
export interface RecordedCall {
  /** Groups calls into one outcome. Per MCP 2026-07-28 there is no protocol
   *  session, so the OpenTelemetry trace id is the only sanctioned unit. */
  traceId: string;
  /** Monotonic index within the trace. */
  seq: number;
  tsMs: number;
  /** io.modelcontextprotocol/clientInfo name, or a synthetic caller id. */
  caller: string;
  tool: string;
  args: Json;
  /** Full result payload as the caller would have received it. */
  result: Json;
  isError: boolean;
  latencyMs: number;
  /** Size of the result as it would enter a model's context. Not derived
   *  lazily because the headline metric is computed from it. */
  resultBytes: number;
  resultTokens: number;
}

/** A corpus row also carries what the caller was actually trying to do.
 *  This is ground truth and exists so we can tell a real cluster from a
 *  coincidence. It is never an input to the detector. */
export interface LabelledCall extends RecordedCall {
  goalId: string;
  /** Which phrasing variant of the goal produced this run. */
  variant: string;
}

/** All calls sharing a traceId, in order. */
export interface Episode {
  traceId: string;
  caller: string;
  goalId?: string;
  variant?: string;
  calls: RecordedCall[];
}

/* ------------------------------------------------------------------ */
/* Route plans                                                         */
/* ------------------------------------------------------------------ */

/** Where a single argument value comes from when a route runs. */
export type Binding =
  /** A literal baked into the route. The caller never supplies it. */
  | { kind: "const"; value: Json }
  /** An input on the generated tool's schema. */
  | { kind: "param"; name: string }
  /** Read out of an earlier step's result at a JSON path. */
  | { kind: "from"; step: number; path: string }
  /** A string composed from literal chunks and inner bindings. Needed because
   *  real tools take composed strings (SQL, paths, queries) rather than clean
   *  handles, so dataflow is embedded rather than exact. */
  | { kind: "template"; parts: Array<string | Binding> };

export interface PlanStep {
  call: string;
  args: Record<string, Binding>;
}

export interface RoutePlan {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  steps: PlanStep[];
  /** Which step's result the route returns. */
  returns: number;
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/** The value-stripped shape of an episode, used to cluster it. */
export interface Shape {
  key: string;
  tools: string[];
}

/** Episodes that share a shape, plus the slice of each they matched. */
export interface Cluster {
  shape: Shape;
  members: Array<{ episode: Episode; start: number; end: number }>;
}

export type ArgRole = "const" | "param" | "derived" | "unstable";

/** How one argument of one step behaved across every member of a cluster. */
export interface ArgAnalysis {
  step: number;
  argPath: string;
  role: ArgRole;
  binding?: Binding;
  /** Why it landed in `unstable`, for the primitive-gap report. */
  note?: string;
  /** Set when a `param` value was also found in an earlier result. Such a
   *  param is not free: the caller can only supply it by making the discovery
   *  call first, so exposing it forfeits the saving the route was meant to
   *  produce. These are the entries that would be internalised by a
   *  select-by-predicate primitive, and they are the primitive-gap list. */
  discoveredIn?: number;
}

export interface Candidate {
  cluster: Cluster;
  analyses: ArgAnalysis[];
  plan?: RoutePlan;
  /** Set when no plan could be built. Feeds the primitive-gap list. */
  blockedBy?: string;
  score: Score;
}

export interface Score {
  /** Episodes backing this candidate. */
  support: number;
  /** Result tokens that would never reach a model's context, per use, taking
   *  discovered params into account. This is the number worth quoting. */
  intermediateTokensSaved: number;
  /** The same figure ignoring discovered params, which is what a naive reading
   *  of the chain suggests. Kept so the gap between the two is visible. */
  rawIntermediateTokensSaved: number;
  /** Upstream calls collapsed into one, per use. */
  roundTripsSaved: number;
  /** Upstream time the route still spends, since every underlying call still
   *  runs. Recorded so no one mistakes round trips saved for time saved. The
   *  real time saving is (roundTripsSaved x one model inference), which cannot
   *  be measured without a model in the loop. */
  upstreamLatencyMs: number;
  /** Tokens this route's schema adds to every tools/list, for every caller. */
  schemaTokenCost: number;
  /** Does the chain mutate state. */
  mutating: boolean;
  /** Did every member agree on every argument role. */
  stable: boolean;
  /** How many tools/list fetches one use of this route pays for. Above 1 means
   *  the route earns its place. Assumption-free: it needs no guess at traffic
   *  volume, unlike an absolute net figure. */
  payoffRatio: number;
}

/* ------------------------------------------------------------------ */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonSchema = { [k: string]: Json };
