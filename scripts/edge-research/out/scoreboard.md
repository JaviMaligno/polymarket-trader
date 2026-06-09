# Edge Research scoreboard

| id | class | n | edge_net% | insample% | sig | status | caveats |
|----|-------|---|-----------|-----------|-----|--------|---------|
| H-MM-1 | market_making | 1038 | 0.24 | 0.24 | 0.00 | pass | Δ≈10min (coarse); passive-maker proxy, not simulated fills; excludes queue priority / inventory risk / rewards (H-MM-2) |
| H-MM-1 | market_making | 1025 | 0.24 | 0.24 | 0.00 | pass | Δ≈10min (coarse); passive-maker proxy, not simulated fills; excludes queue priority / inventory risk / rewards (H-MM-2) |
| H-MM-1 | market_making | 1519 | 0.19 | 0.19 | 0.00 | pass | Δ≈10min (coarse); passive-maker proxy, not simulated fills; excludes queue priority / inventory risk / rewards (H-MM-2) |
| H-INE-1 | inefficiency | 58 | -2.79 | -2.79 | 0.07 | fail |  |
| H-INE-1 | inefficiency | 115 | -2.83 | -2.83 | 0.04 | fail |  |
| H-INE-1 | inefficiency | 0 |  |  |  | inconclusive | n=0 below floor 30 |
| H-INE-1 | inefficiency | 5 |  |  |  | inconclusive | n=5 below floor 30 |
| H-MM-1 | market_making | 13 |  |  |  | inconclusive | Δ≈10min (coarse); passive-maker proxy, not simulated fills; excludes queue priority / inventory risk / rewards (H-MM-2); n=13 below floor 200 |
| H-MM-3 | market_making | 69 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=69 below floor 200 |
| H-MM-3 | market_making | 39 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=39 below floor 200 |
| H-MM-3 | market_making | 110 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=110 below floor 200 |
| H-MM-3 | market_making | 62 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=62 below floor 200 |
| H-MM-3 | market_making | 198 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=198 below floor 200 |
| H-MM-3 | market_making | 107 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=107 below floor 200 |
| H-MM-3 | market_making | 69 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=69 below floor 200 |
| H-MM-3 | market_making | 39 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=39 below floor 200 |
| H-MM-3 | market_making | 110 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=110 below floor 200 |
| H-MM-3 | market_making | 62 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=62 below floor 200 |
| H-MM-3 | market_making | 198 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=198 below floor 200 |
| H-MM-3 | market_making | 107 |  |  |  | inconclusive | fine-cadence maker fill-sim; fill = trade crossed the touch (queue not observable); excludes inventory + rewards (H-MM-2); n=107 below floor 200 |
| H-ENS-1 | ensemble | 0 |  |  |  | inconclusive | fewer than 2 passing components — nothing to combine |

## Blocked (data not available)

- H-CAL-1 — Price calibration by price band (blocked)
- H-CAL-2 — Calibration by market_type (blocked)
- H-CAL-3 — Calibration by TTR bucket (blocked)
- H-CAL-4 — Calibration by liquidity (blocked)
- H-SUP-1 — Supervised model prob vs price (blocked)
- H-HOR-1 — Optimal-hold sweep (blocked)
- H-INE-2 — Resolution-day discovery gap (blocked)
- H-INE-3 — News-event price lag (blocked)
- H-INE-4 — Conditional markets not updating (blocked)
- H-INE-5 — Time-decay extreme band (blocked)
- H-MM-2 — Liquidity-rewards subsidy (blocked)
