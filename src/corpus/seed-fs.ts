/**
 * A small synthetic project tree, for the discrete-argument corpus.
 *
 * Phase 1 showed a database server is the worst case for equivalence, because
 * its whole interface is one free-form string. A filesystem server is the
 * opposite: its arguments are discrete paths, so two callers with the same
 * intent should produce byte-identical arguments and there should be nothing
 * to normalize. This tree exists to test that.
 *
 * Written out in full rather than copied from a real project so it is
 * deterministic, contains nothing personal, and a stranger can regenerate it.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = process.env["EMCP_TREE"] ?? "corpus/tree";

const FILES: Record<string, string> = {
  "README.md": "# orderly\n\nA small order service.\n\n- `src/` application code\n- `tests/` test suite\n- `config/` deployment configuration\n",
  "package.json": '{\n  "name": "orderly",\n  "version": "1.4.2",\n  "main": "src/server.js"\n}\n',
  "src/server.js": "import { createRouter } from './routes/index.js';\nimport { connect } from './db/pool.js';\n\nexport async function start(port) {\n  await connect();\n  const router = createRouter();\n  return router.listen(port);\n}\n",
  "src/auth/session.js": "import { verifyToken } from './tokens.js';\n\n// Resolves the caller identity for a request, or null when anonymous.\nexport function currentUser(req) {\n  const header = req.headers.authorization;\n  if (!header) return null;\n  return verifyToken(header.replace('Bearer ', ''));\n}\n",
  "src/auth/tokens.js": "import { createHmac } from 'node:crypto';\n\nconst SECRET = process.env.TOKEN_SECRET ?? 'dev-only';\n\nexport function signToken(payload) {\n  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');\n  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');\n  return `${body}.${sig}`;\n}\n\nexport function verifyToken(token) {\n  const [body, sig] = token.split('.');\n  const expected = createHmac('sha256', SECRET).update(body).digest('base64url');\n  return sig === expected ? JSON.parse(Buffer.from(body, 'base64url').toString()) : null;\n}\n",
  "src/db/pool.js": "import pg from 'pg';\n\nlet pool;\n\n// Opens the shared connection pool. Safe to call more than once.\nexport async function connect() {\n  if (pool) return pool;\n  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });\n  await pool.query('SELECT 1');\n  return pool;\n}\n\nexport function query(text, params) {\n  return pool.query(text, params);\n}\n",
  "src/db/migrations.js": "export const MIGRATIONS = [\n  { id: 1, sql: 'CREATE TABLE orders (id serial primary key, total numeric)' },\n  { id: 2, sql: 'ALTER TABLE orders ADD COLUMN placed_at timestamptz' },\n];\n",
  "src/routes/index.js": "import { orders } from './orders.js';\nimport { health } from './health.js';\n\nexport function createRouter() {\n  return { '/orders': orders, '/health': health };\n}\n",
  "src/routes/orders.js": "import { query } from '../db/pool.js';\nimport { currentUser } from '../auth/session.js';\n\nexport async function orders(req) {\n  const user = currentUser(req);\n  if (!user) return { status: 401 };\n  const rows = await query('SELECT * FROM orders WHERE owner = $1', [user.id]);\n  return { status: 200, body: rows };\n}\n",
  "src/routes/health.js": "export function health() {\n  return { status: 200, body: { ok: true } };\n}\n",
  "src/lib/money.js": "// All amounts are integer minor units. Never floats.\nexport function format(minor, currency) {\n  return `${(minor / 100).toFixed(2)} ${currency}`;\n}\n\nexport function add(a, b) {\n  return a + b;\n}\n",
  "src/lib/retry.js": "export async function withRetry(fn, attempts = 3) {\n  let last;\n  for (let i = 0; i < attempts; i++) {\n    try { return await fn(); } catch (e) { last = e; }\n  }\n  throw last;\n}\n",
  "tests/auth.test.js": "import { signToken, verifyToken } from '../src/auth/tokens.js';\n\ntest('a signed token verifies', () => {\n  expect(verifyToken(signToken({ id: 7 }))).toEqual({ id: 7 });\n});\n",
  "tests/orders.test.js": "import { orders } from '../src/routes/orders.js';\n\ntest('anonymous callers are rejected', async () => {\n  expect((await orders({ headers: {} })).status).toBe(401);\n});\n",
  "tests/money.test.js": "import { format } from '../src/lib/money.js';\n\ntest('formats minor units', () => {\n  expect(format(1234, 'EUR')).toBe('12.34 EUR');\n});\n",
  "config/production.json": '{\n  "port": 8080,\n  "logLevel": "warn",\n  "database": { "poolSize": 10, "ssl": true }\n}\n',
  "config/staging.json": '{\n  "port": 8080,\n  "logLevel": "debug",\n  "database": { "poolSize": 4, "ssl": false }\n}\n',
  "docs/deploy.md": "# Deploying\n\n1. Build the image.\n2. Apply migrations from `src/db/migrations.js`.\n3. Roll out one region at a time.\n",
  "docs/architecture.md": "# Architecture\n\nRequests enter through `src/server.js`, are routed by `src/routes/index.js`,\nand hit the database through the shared pool in `src/db/pool.js`.\nIdentity is resolved in `src/auth/session.js`.\n",
};

rmSync(ROOT, { recursive: true, force: true });
for (const [rel, body] of Object.entries(FILES)) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
console.log(`seeded ${ROOT}: ${Object.keys(FILES).length} files`);
