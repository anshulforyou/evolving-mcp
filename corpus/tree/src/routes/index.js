import { orders } from './orders.js';
import { health } from './health.js';

export function createRouter() {
  return { '/orders': orders, '/health': health };
}
