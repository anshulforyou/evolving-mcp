import pg from 'pg';

let pool;

// Opens the shared connection pool. Safe to call more than once.
export async function connect() {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  await pool.query('SELECT 1');
  return pool;
}

export function query(text, params) {
  return pool.query(text, params);
}
