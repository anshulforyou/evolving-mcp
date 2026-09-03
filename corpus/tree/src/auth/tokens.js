import { createHmac } from 'node:crypto';

const SECRET = process.env.TOKEN_SECRET ?? 'dev-only';

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', SECRET).update(body).digest('base64url');
  return sig === expected ? JSON.parse(Buffer.from(body, 'base64url').toString()) : null;
}
