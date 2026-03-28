const hits = new Map();
const INTERVAL = 60_000;
const MAX = 50;

function checkRate(ip) {
  const now = Date.now();
  const key = `${ip}-${Math.floor(now / INTERVAL)}`;
  hits.set(key, (hits.get(key) || 0) + 1);
  return hits.get(key) <= MAX;
}

module.exports = { checkRate };