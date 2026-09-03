import { verifyToken } from './tokens.js';

// Resolves the caller identity for a request, or null when anonymous.
export function currentUser(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  return verifyToken(header.replace('Bearer ', ''));
}
