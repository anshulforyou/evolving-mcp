import { query } from '../db/pool.js';
import { currentUser } from '../auth/session.js';

export async function orders(req) {
  const user = currentUser(req);
  if (!user) return { status: 401 };
  const rows = await query('SELECT * FROM orders WHERE owner = $1', [user.id]);
  return { status: 200, body: rows };
}
