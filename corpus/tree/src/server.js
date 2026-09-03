import { createRouter } from './routes/index.js';
import { connect } from './db/pool.js';

export async function start(port) {
  await connect();
  const router = createRouter();
  return router.listen(port);
}
