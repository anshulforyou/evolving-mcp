import { orders } from '../src/routes/orders.js';

test('anonymous callers are rejected', async () => {
  expect((await orders({ headers: {} })).status).toBe(401);
});
