from __future__ import annotations
import argparse, pathlib, types
from registry import load_registry, runnable
from validators.calibration import CalibrationValidator
from validators.flb import FLBValidator
from validators.supervised import SupervisedValidator
from validators.ensemble import EnsembleValidator
from validators.ine5 import TimeDecayExtremeBandValidator
from validators.mm import MMSpreadValidator
from validators.mm_fine import MMFineValidator
from scoreboard import render_markdown, render_csv

# Primary hypothesis_id → validator factory. A validator may emit several slices
# (CalibrationValidator registered under H-CAL-1 emits H-CAL-1..4). Entries whose
# id is not a key here are either those slices (covered by their primary) or
# hypotheses without a validator yet (reported as `pending`, never dropped).
# Extended as sub-projects B/C land validators.
VALIDATORS = {"H-CAL-1": CalibrationValidator, "H-INE-1": FLBValidator,
              "H-SUP-1": SupervisedValidator, "H-ENS-1": EnsembleValidator,
              "H-INE-5": TimeDecayExtremeBandValidator,
              "H-MM-1": MMSpreadValidator,
              "H-MM-3": MMFineValidator}


def _ctx(datasets, computed_at):
    # min_n=200: the first smoke run (2026-06-05) showed the only `pass` rows at
    # min_n=50 rested on thin ~66-market favourite bins reading -23% (the known
    # anti-edge side, noisy). At 200 only robust bins survive. (Synthetic tests
    # pass their own ctx with min_n=50.)
    return types.SimpleNamespace(datasets=datasets, cost=0.005, computed_at=computed_at,
                                 n_bins=10, min_n=200, seed=7)


def run_validators(datasets: dict, computed_at: str) -> dict:
    """datasets: {required_data_token: DataFrame|None}. Returns verdicts, the
    blocked entries (data unavailable), and pending entries (data available but
    no validator implemented yet)."""
    available = {k for k, v in datasets.items() if v is not None and len(v)}
    entries = load_registry()
    run_entries, blocked = runnable(entries, available)
    verdicts = []
    seen = set()
    for e in run_entries:
        cls = VALIDATORS.get(e["id"])
        if cls is None or e["id"] in seen:
            continue
        seen.add(e["id"])
        verdicts.extend(cls().run(_ctx(datasets, computed_at)))
    emitted = {v.hypothesis_id for v in verdicts}
    pending = [e for e in run_entries if e["id"] not in VALIDATORS and e["id"] not in emitted]
    return {"verdicts": verdicts, "blocked": blocked, "pending": pending}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="scripts/edge-research/out")
    ap.add_argument("--computed-at", required=True, help="ISO timestamp (pass explicitly for determinism)")
    ap.add_argument("--datasets-dir", default=None,
                    help="Load datasets from raw CSVs in this dir instead of the DB "
                         "(offline runner mode; no DATABASE_URL / psycopg2 needed).")
    args = ap.parse_args()
    if args.datasets_dir:
        from data import load_all_datasets_from_dir
        datasets = load_all_datasets_from_dir(args.datasets_dir)
    else:
        from data import load_all_datasets
        datasets = load_all_datasets()
    res = run_validators(datasets, args.computed_at)
    outdir = pathlib.Path(args.out); outdir.mkdir(parents=True, exist_ok=True)
    # encoding pinned: the scoreboard contains em-dashes; the default write_text
    # encoding is the platform locale (cp1252 on Windows) which mangles them.
    (outdir / "scoreboard.md").write_text(
        render_markdown(res["verdicts"], res["blocked"], res.get("pending", [])),
        encoding="utf-8")
    (outdir / "scoreboard.csv").write_text(render_csv(res["verdicts"]), encoding="utf-8")
    print(f"Wrote {outdir}/scoreboard.md ({len(res['verdicts'])} verdicts, "
          f"{len(res['blocked'])} blocked, {len(res.get('pending', []))} pending)")


if __name__ == "__main__":
    main()
