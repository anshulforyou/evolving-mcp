import { format } from '../src/lib/money.js';

test('formats minor units', () => {
  expect(format(1234, 'EUR')).toBe('12.34 EUR');
});
