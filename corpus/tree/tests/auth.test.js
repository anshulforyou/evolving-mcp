import { signToken, verifyToken } from '../src/auth/tokens.js';

test('a signed token verifies', () => {
  expect(verifyToken(signToken({ id: 7 }))).toEqual({ id: 7 });
});
