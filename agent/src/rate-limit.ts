/** Token bucket: returns true when the message may proceed. */
export function makeRateLimiter(burst: number, perSec: number, now: () => number = Date.now) {
  let tokens = burst;
  let last = now();
  return () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
