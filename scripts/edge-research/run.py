from __future__ import annotations
import argparse, pathlib, types
from registry import load_registry, runnable
from validators.calibration import CalibrationValidator
from scoreboard import render_markdown, render_csv

# class → validator factory. Extended in sub-projects B/C.
VALIDATORS = {"calibration": CalibrationValidator}

def _ctx(df, computed_at):
    return types.SimpleNamespace(df=df, cost=0.005, computed_at=computed_at,
                                 n_bins=10, min_n=50, seed=7)

def run_validators(df, available: set[str], computed_at: str) -> dict:
    entries = load_registry()
    run_entries, blocked = runnable(entries, available)
    verdicts = []
    seen_classes = set()
    for e in run_entries:
        cls = VALIDATORS.get(e["class"])
        if cls is None or e["class"] in seen_classes:
            continue  # one validator instance per class emits all its slices
        seen_classes.add(e["class"])
        verdicts.extend(cls().run(_ctx(df, computed_at)))
    return {"verdicts": verdicts, "blocked": blocked}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="scripts/edge-research/out")
    ap.add_argument("--computed-at", required=True, help="ISO timestamp (pass explicitly for determinism)")
    args = ap.parse_args()
    from data import load_market_panel, available_data
    df = load_market_panel()
    res = run_validators(df, available_data(), args.computed_at)
    outdir = pathlib.Path(args.out); outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "scoreboard.md").write_text(render_markdown(res["verdicts"], res["blocked"]))
    (outdir / "scoreboard.csv").write_text(render_csv(res["verdicts"]))
    print(f"Wrote {outdir}/scoreboard.md ({len(res['verdicts'])} verdicts, {len(res['blocked'])} blocked)")

if __name__ == "__main__":
    main()
