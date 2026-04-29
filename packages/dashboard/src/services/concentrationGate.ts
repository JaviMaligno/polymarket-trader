const DEFAULT_K = 1.0;

/**
 * Resolves the σ multiplier for the concentration gate.
 * Default 1.0 (empirically the knee of the diminishing-returns curve).
 * Overridable via OPTIMIZER_CONCENTRATION_K_SIGMA.
 * Invalid values (non-numeric, ≤ 0) fall back to 1.0.
 */
export function getKSigma(): number {
  const raw = process.env.OPTIMIZER_CONCENTRATION_K_SIGMA;
  if (raw === undefined) return DEFAULT_K;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_K;
  return parsed;
}
