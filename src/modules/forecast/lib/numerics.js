// Small numeric helpers — IRR, NPV, etc. No external deps.

/**
 * Internal Rate of Return via Newton-Raphson.
 * cashflows[0] is the period-0 outflow (negative). Returns the
 * per-period rate that makes NPV(rate) = 0, or null on failure.
 */
export function irr(cashflows, guess = 0.01, maxIter = 200, tol = 1e-7) {
  let rate = guess;
  for (let i = 0; i < maxIter; i++) {
    let npv = 0, dnpv = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const denom = Math.pow(1 + rate, t);
      npv += cashflows[t] / denom;
      if (t > 0) dnpv -= (t * cashflows[t]) / Math.pow(1 + rate, t + 1);
    }
    if (Math.abs(npv) < tol) return rate;
    if (dnpv === 0) return null;
    const next = rate - npv / dnpv;
    if (!isFinite(next)) return null;
    if (Math.abs(next - rate) < tol) return next;
    rate = next;
  }
  return null;
}

export function npv(cashflows, rate) {
  let v = 0;
  for (let t = 0; t < cashflows.length; t++) v += cashflows[t] / Math.pow(1 + rate, t);
  return v;
}
