export const MIGRATIONS = [
  { id: 1, sql: 'CREATE TABLE orders (id serial primary key, total numeric)' },
  { id: 2, sql: 'ALTER TABLE orders ADD COLUMN placed_at timestamptz' },
];
