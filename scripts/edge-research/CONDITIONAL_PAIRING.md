# Conditional-pair identification (H-INE-4)

Input: `conditional_catalog.csv` (from `conditional_catalog.sql`).
Output: `conditional_pairs.csv` with columns
`pair_id,market_id_a,market_id_b,relation` where `relation ∈
{implies_yes, implies_no, mutual_exclusion}` and the semantics are:

- `implies_yes`  : A resolving YES forces B to YES (B should → 1).
- `implies_no`   : A resolving YES forces B to NO  (B should → 0).
- `mutual_exclusion`: A and B cannot both be YES (A YES → B NO → 0), for pairs
  in DIFFERENT events (same-event sets are dropped by the export's negRisk guard).

Procedure:
1. Group catalog rows by `event_category` then scan for cross-event logical links
   (e.g. a primary-winner market A and a general-election market B for the same
   entity; a "wins ≥ N seats" market and a "wins majority" market).
2. For each candidate, record A (the EARLIER-resolving market), B (the later),
   and the relation. Only include pairs where A's YES outcome makes B determinate.
3. Do NOT pair two markets with the same `event_id` (the export drops them, but
   skipping saves effort) — those are negRisk-netted and dead (H-ARB-2).
4. Be conservative: a wrong pair costs recall (the export re-checks A-before-B,
   determinacy, and price availability mechanically), but obviously-bogus pairs
   waste backtest rows. Aim for precision; the harness floor (n≥200) needs volume,
   so prefer broad but defensible families (politics, sports brackets, tiered
   numeric thresholds on the same subject).
5. Save as `conditional_pairs.csv`. Commit it.
