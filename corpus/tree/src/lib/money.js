// All amounts are integer minor units. Never floats.
export function format(minor, currency) {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

export function add(a, b) {
  return a + b;
}
