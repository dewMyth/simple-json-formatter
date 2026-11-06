/**
 * Performance budgets from plan.md §3 are for a typical laptop. Shared CI runners are slower and
 * noisier, so tests multiply budgets by JSONLENS_BUDGET_SCALE (default 1; CI sets it higher).
 * Only imported by tests.
 */
export function budget(ms: number): number {
  const scale = Number(globalThis.process?.env?.JSONLENS_BUDGET_SCALE ?? 1);
  return ms * (Number.isFinite(scale) && scale > 0 ? scale : 1);
}
