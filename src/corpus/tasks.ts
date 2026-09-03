/**
 * Corpus task definitions.
 *
 * Each goal is something a person would actually ask a database agent. Each
 * goal has several *styles*, which are the different ways a model might
 * explore to answer it, and several *params*, which are the different literal
 * values the same question gets asked with. One run is a (style, params) pair.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not make every run identical. Styles differ in how many tables they
 * inspect and how many queries they run, so the miner has to find the shared
 * part rather than being handed it.
 *
 * It does not only include goals that promote well. G3, G4, G6 and G7 are
 * fixed queries whose whole chain collapses cleanly. G1, G2, G5 and G8 carry a
 * varying literal. G9 is a genuine multi-hop derivation. If the promotable
 * fraction comes out low, that is the finding, not a bug to tune away.
 */
import { readPath, type NormalizedResult } from "../detect/normalize.js";
import type { Json } from "../types.js";

export interface StepSpec {
  tool: string;
  args: (prior: NormalizedResult[]) => Json;
}

export interface Goal {
  id: string;
  question: string;
  styles: Record<string, (p: Params) => StepSpec[]>;
  params: Params[];
}

export type Params = Record<string, string | number>;

/** Reads a value the previous calls actually returned. This is the agent
 *  behaviour we want the detector to have to rediscover from traces alone. */
const from = (prior: NormalizedResult[], step: number, path: string): string | number => {
  const r = prior[step];
  if (!r || r.value === null) throw new Error(`step ${step} not normalizable`);
  const v = readPath(r.value, path);
  if (v === undefined || v === null || typeof v === "object") {
    throw new Error(`no scalar at ${path} in step ${step}`);
  }
  return v as string | number;
};

const listTables: StepSpec = { tool: "list_tables", args: () => ({}) };
const describe = (t: string): StepSpec => ({ tool: "describe_table", args: () => ({ table_name: t }) });
const query = (f: (prior: NormalizedResult[]) => string): StepSpec => ({
  tool: "read_query",
  args: (prior) => ({ query: f(prior) }) as Json,
});

export const GOALS: Goal[] = [
  {
    id: "invoices_for_customer",
    question: "show me the invoices for a given customer",
    styles: {
      // Looks up the id first, then uses it. The id is derived.
      lookup_then_use: (p) => [
        listTables,
        describe("customers"),
        query(() => `SELECT customer_id, first_name, last_name FROM customers WHERE last_name = '${p["last"]}'`),
        query((prior) => `SELECT invoice_id, invoice_date, total FROM invoices WHERE customer_id = ${from(prior, 2, "$[0].customer_id")} ORDER BY invoice_date`),
      ],
      // Skips the lookup and joins instead. No derived value at all.
      single_join: (p) => [
        listTables,
        describe("invoices"),
        query(() => `SELECT i.invoice_id, i.invoice_date, i.total FROM invoices i JOIN customers c ON c.customer_id = i.customer_id WHERE c.last_name = '${p["last"]}' ORDER BY i.invoice_date`),
      ],
      // Inspects both tables before committing to a query.
      inspect_both: (p) => [
        listTables,
        describe("customers"),
        describe("invoices"),
        query(() => `SELECT i.invoice_id, i.total FROM invoices i JOIN customers c ON c.customer_id = i.customer_id WHERE c.last_name = '${p["last"]}'`),
      ],
    },
    params: [{ last: "Adler" }, { last: "Baptiste" }, { last: "Cruz" }, { last: "Dahl" }, { last: "Rossi" }, { last: "Tanaka" }],
  },
  {
    id: "albums_by_artist",
    question: "which albums did a given artist release",
    styles: {
      lookup_then_use: (p) => [
        listTables,
        describe("artists"),
        query(() => `SELECT artist_id, name FROM artists WHERE name = '${p["artist"]}'`),
        query((prior) => `SELECT album_id, title, release_year FROM albums WHERE artist_id = ${from(prior, 2, "$[0].artist_id")} ORDER BY release_year`),
      ],
      inspect_both: (p) => [
        listTables,
        describe("artists"),
        describe("albums"),
        query(() => `SELECT artist_id, name FROM artists WHERE name = '${p["artist"]}'`),
        query((prior) => `SELECT title, release_year FROM albums WHERE artist_id = ${from(prior, 3, "$[0].artist_id")}`),
      ],
    },
    params: [
      { artist: "Copper Riot" }, { artist: "Copper Signal" }, { artist: "Ember Ember" },
      { artist: "Ember Riot" }, { artist: "Glass Quiet" }, { artist: "Harbour Glass" },
    ],
  },
  {
    id: "top_customers_by_spend",
    question: "who are our highest spending customers",
    styles: {
      inspect_both: (p) => [
        listTables,
        describe("customers"),
        describe("invoices"),
        query(() => `SELECT c.first_name, c.last_name, ROUND(SUM(i.total),2) AS spend FROM customers c JOIN invoices i ON i.customer_id = c.customer_id GROUP BY c.customer_id ORDER BY spend DESC LIMIT ${p["limit"]}`),
      ],
      invoices_only: (p) => [
        listTables,
        describe("invoices"),
        query(() => `SELECT customer_id, ROUND(SUM(total),2) AS spend FROM invoices GROUP BY customer_id ORDER BY spend DESC LIMIT ${p["limit"]}`),
      ],
    },
    params: [{ limit: 5 }, { limit: 10 }, { limit: 20 }],
  },
  {
    id: "revenue_by_country",
    question: "how much revenue came from each country",
    styles: {
      direct: () => [
        listTables,
        describe("invoices"),
        query(() => `SELECT billing_country, ROUND(SUM(total),2) AS revenue FROM invoices GROUP BY billing_country ORDER BY revenue DESC`),
      ],
      via_customers: () => [
        listTables,
        describe("customers"),
        describe("invoices"),
        query(() => `SELECT c.country, ROUND(SUM(i.total),2) AS revenue FROM invoices i JOIN customers c ON c.customer_id = i.customer_id GROUP BY c.country ORDER BY revenue DESC`),
      ],
    },
    params: [{}, {}],
  },
  {
    id: "tracks_longer_than",
    question: "which tracks run longer than some number of minutes",
    styles: {
      direct: (p) => [
        listTables,
        describe("tracks"),
        query(() => `SELECT track_id, name, milliseconds FROM tracks WHERE milliseconds > ${Number(p["mins"]) * 60000} ORDER BY milliseconds DESC LIMIT 50`),
      ],
      with_album: (p) => [
        listTables,
        describe("tracks"),
        describe("albums"),
        query(() => `SELECT t.name, a.title, t.milliseconds FROM tracks t JOIN albums a ON a.album_id = t.album_id WHERE t.milliseconds > ${Number(p["mins"]) * 60000} LIMIT 50`),
      ],
    },
    params: [{ mins: 6 }, { mins: 7 }, { mins: 8 }, { mins: 9 }],
  },
  {
    id: "tracks_per_genre",
    question: "how many tracks are in each genre",
    styles: {
      inspect_both: () => [
        listTables,
        describe("tracks"),
        describe("genres"),
        query(() => `SELECT g.name, COUNT(*) AS n FROM tracks t JOIN genres g ON g.genre_id = t.genre_id GROUP BY g.genre_id ORDER BY n DESC`),
      ],
    },
    params: [{}, {}, {}],
  },
  {
    id: "customers_without_invoices",
    question: "which customers have never bought anything",
    styles: {
      inspect_both: () => [
        listTables,
        describe("customers"),
        describe("invoices"),
        query(() => `SELECT customer_id, first_name, last_name, email FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM invoices)`),
      ],
      customers_only: () => [
        listTables,
        describe("customers"),
        query(() => `SELECT customer_id, email FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM invoices)`),
      ],
    },
    params: [{}, {}],
  },
  {
    id: "top_tracks_by_revenue",
    question: "which tracks earned the most",
    styles: {
      direct: (p) => [
        listTables,
        describe("invoice_items"),
        describe("tracks"),
        query(() => `SELECT t.name, ROUND(SUM(ii.unit_price * ii.quantity),2) AS revenue FROM invoice_items ii JOIN tracks t ON t.track_id = ii.track_id GROUP BY t.track_id ORDER BY revenue DESC LIMIT ${p["limit"]}`),
      ],
    },
    params: [{ limit: 10 }, { limit: 15 }, { limit: 25 }],
  },
  {
    id: "invoice_detail",
    question: "what was on a particular invoice",
    styles: {
      // Three hops. The invoice's customer id, then that customer's name.
      hop_three: (p) => [
        listTables,
        describe("invoices"),
        describe("invoice_items"),
        query(() => `SELECT invoice_id, customer_id, total FROM invoices WHERE invoice_id = ${p["invoice"]}`),
        query((prior) => `SELECT first_name, last_name, email FROM customers WHERE customer_id = ${from(prior, 3, "$[0].customer_id")}`),
        query(() => `SELECT ii.track_id, t.name, ii.quantity, ii.unit_price FROM invoice_items ii JOIN tracks t ON t.track_id = ii.track_id WHERE ii.invoice_id = ${p["invoice"]}`),
      ],
    },
    params: [{ invoice: 1 }, { invoice: 2 }, { invoice: 3 }, { invoice: 5 }, { invoice: 7 }, { invoice: 8 }],
  },
];

/** Callers are named so the corpus has more than one identity in it, since a
 *  single-caller corpus cannot say anything about cross-caller convergence. */
export const CALLERS = ["analytics-bot", "support-desk", "finance-agent", "adhoc-notebook"] as const;
