# Architecture

Requests enter through `src/server.js`, are routed by `src/routes/index.js`,
and hit the database through the shared pool in `src/db/pool.js`.
Identity is resolved in `src/auth/session.js`.
