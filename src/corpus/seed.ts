/**
 * Builds the sqlite database the corpus is recorded against.
 *
 * Deterministic on purpose. A stranger cloning the repo has to be able to
 * regenerate this database byte-identically, or the golden route test is
 * worthless. Everything random here comes from a fixed-seed PRNG.
 *
 * Shape is a music store, close to Chinook, because it has the join depth
 * that makes schema discovery expensive: customers to invoices to invoice
 * items to tracks to albums to artists.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const DB = process.env["EMCP_DB"] ?? "corpus/store.db";

/** mulberry32. Fixed seed, so every run produces the same database. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(20260903);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

const FIRST = ["Ana","Bilal","Chen","Dara","Eero","Fatima","Gus","Hana","Ivo","Jae","Kira","Luca","Mira","Nils","Omar","Pia","Quinn","Rhea","Sami","Tove","Ugo","Vera","Wren","Yuki","Zane"] as const;
const LAST = ["Adler","Baptiste","Cruz","Dahl","Eriksen","Farouk","Gupta","Halim","Ibarra","Jansen","Kowal","Lindqvist","Moreau","Nakamura","Oyelaran","Petrov","Quintero","Rossi","Sandoval","Tanaka","Ueno","Varga","Wojcik","Yilmaz","Zhao"] as const;
const COUNTRY = ["Brazil","Canada","Czechia","France","Germany","India","Japan","Norway","Portugal","Spain","USA","UK"] as const;
const GENRE = ["Rock","Jazz","Metal","Classical","Hip Hop","Electronic","Folk","Blues","Pop","Ambient"] as const;
const WORD = ["Midnight","Paper","Glass","Ember","Signal","Hollow","Northern","Velvet","Static","Harbour","Copper","Lantern","Marble","Quiet","Riot","Saffron","Tundra","Umbra","Vault","Wander"] as const;

const title = (): string => `${pick(WORD)} ${pick(WORD)}`.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

const sql: string[] = [
  "PRAGMA journal_mode=DELETE;",
  `CREATE TABLE artists (artist_id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT);`,
  `CREATE TABLE albums (album_id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist_id INTEGER NOT NULL REFERENCES artists(artist_id), release_year INTEGER);`,
  `CREATE TABLE genres (genre_id INTEGER PRIMARY KEY, name TEXT NOT NULL);`,
  `CREATE TABLE tracks (track_id INTEGER PRIMARY KEY, name TEXT NOT NULL, album_id INTEGER REFERENCES albums(album_id), genre_id INTEGER REFERENCES genres(genre_id), milliseconds INTEGER NOT NULL, unit_price REAL NOT NULL);`,
  `CREATE TABLE employees (employee_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, title TEXT, hire_year INTEGER);`,
  `CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, country TEXT, support_rep_id INTEGER REFERENCES employees(employee_id));`,
  `CREATE TABLE invoices (invoice_id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(customer_id), invoice_date TEXT NOT NULL, billing_country TEXT, total REAL NOT NULL);`,
  `CREATE TABLE invoice_items (invoice_item_id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(invoice_id), track_id INTEGER NOT NULL REFERENCES tracks(track_id), unit_price REAL NOT NULL, quantity INTEGER NOT NULL);`,
];

for (let i = 0; i < GENRE.length; i++) sql.push(`INSERT INTO genres VALUES (${i + 1}, ${q(GENRE[i]!)});`);

const N_ARTISTS = 220, N_ALBUMS = 460, N_TRACKS = 3600, N_EMP = 8, N_CUST = 90, N_INV = 520;

for (let i = 1; i <= N_ARTISTS; i++) sql.push(`INSERT INTO artists VALUES (${i}, ${q(title())}, ${q(pick(COUNTRY))});`);
for (let i = 1; i <= N_ALBUMS; i++) sql.push(`INSERT INTO albums VALUES (${i}, ${q(title())}, ${int(1, N_ARTISTS)}, ${int(1968, 2025)});`);
for (let i = 1; i <= N_TRACKS; i++) {
  sql.push(`INSERT INTO tracks VALUES (${i}, ${q(title())}, ${int(1, N_ALBUMS)}, ${int(1, GENRE.length)}, ${int(95_000, 640_000)}, ${pick([0.99, 1.29, 1.99])});`);
}
for (let i = 1; i <= N_EMP; i++) sql.push(`INSERT INTO employees VALUES (${i}, ${q(pick(FIRST))}, ${q(pick(LAST))}, ${q(pick(["Sales Support Agent","Sales Manager","IT Staff"]))}, ${int(2015, 2024)});`);
for (let i = 1; i <= N_CUST; i++) {
  const f = pick(FIRST), l = pick(LAST);
  sql.push(`INSERT INTO customers VALUES (${i}, ${q(f)}, ${q(l)}, ${q(`${f}.${l}@example.com`.toLowerCase())}, ${q(pick(COUNTRY))}, ${int(1, N_EMP)});`);
}
let item = 1;
for (let i = 1; i <= N_INV; i++) {
  const cust = int(1, N_CUST);
  const lines = int(1, 7);
  const rows: Array<[number, number, number]> = [];
  let total = 0;
  for (let k = 0; k < lines; k++) {
    const tid = int(1, N_TRACKS), price = pick([0.99, 1.29, 1.99]), qty = int(1, 3);
    rows.push([tid, price, qty]);
    total += price * qty;
  }
  sql.push(`INSERT INTO invoices VALUES (${i}, ${cust}, ${q(`${int(2023, 2025)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`)}, ${q(pick(COUNTRY))}, ${total.toFixed(2)});`);
  for (const [tid, price, qty] of rows) sql.push(`INSERT INTO invoice_items VALUES (${item++}, ${i}, ${tid}, ${price}, ${qty});`);
}

rmSync(DB, { force: true });
writeFileSync("/tmp/emcp-seed.sql", sql.join("\n"));
execFileSync("sqlite3", [DB], { input: sql.join("\n") });
const counts = execFileSync("sqlite3", [DB, "SELECT (SELECT COUNT(*) FROM tracks)||' tracks, '||(SELECT COUNT(*) FROM invoices)||' invoices, '||(SELECT COUNT(*) FROM invoice_items)||' items, '||(SELECT COUNT(*) FROM customers)||' customers';"], { encoding: "utf8" });
console.log(`seeded ${DB}: ${counts.trim()}`);
