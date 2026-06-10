from __future__ import annotations
import os, pathlib, pandas as pd

# --- market_panel: resolved, earliest snapshot per market (calibration, supervised) ---

RESOLVED_SQL = """
  SELECT market_id, snapshot_at, end_date, yes_price, market_type,
         market_score, outcome_yes
  FROM market_panel
  WHERE outcome_yes IS NOT NULL
"""

def shape_panel(raw: pd.DataFrame) -> pd.DataFrame:
    raw = raw.sort_values("snapshot_at")
    earliest = raw.groupby("market_id", as_index=False).first()
    earliest["ttr_days"] = (
        (earliest["end_date"] - earliest["snapshot_at"]).dt.total_seconds() / 86400.0
    )
    earliest["outcome_yes"] = earliest["outcome_yes"].astype(int)
    # snapshot_at kept for the supervised validator's temporal train/holdout split.
    return earliest[["market_id", "yes_price", "outcome_yes", "market_type",
                     "ttr_days", "market_score", "snapshot_at"]]

def load_market_panel(database_url: str | None = None) -> pd.DataFrame:
    return shape_panel(_read(RESOLVED_SQL, database_url))


# --- market_panel: ALL snapshots per market (horizon sweep) ---

def shape_panel_full(raw: pd.DataFrame) -> pd.DataFrame:
    raw = raw.sort_values(["market_id", "snapshot_at"]).copy()
    raw["ttr_days"] = (
        (raw["end_date"] - raw["snapshot_at"]).dt.total_seconds() / 86400.0
    )
    raw["outcome_yes"] = raw["outcome_yes"].astype(int)
    return raw[["market_id", "snapshot_at", "yes_price", "outcome_yes",
                "market_type", "ttr_days", "market_score"]]

def load_market_panel_full(database_url: str | None = None) -> pd.DataFrame:
    return shape_panel_full(_read(RESOLVED_SQL, database_url))


# --- flb_shadow_signals: FLB measured at real cost (FLB validator) ---

FLB_SQL = """
  SELECT market_id, entry_yes_price, market_type, net_pnl, net_pnl_real,
         entry_cost_real, resolved_at
  FROM flb_shadow_signals
  WHERE net_pnl_real IS NOT NULL
"""

def load_flb_shadow(database_url: str | None = None) -> pd.DataFrame:
    return _read(FLB_SQL, database_url)


# --- shared ---

def _read(sql: str, database_url: str | None) -> pd.DataFrame:
    import psycopg2
    url = database_url or os.environ["DATABASE_URL"]
    with psycopg2.connect(url) as conn:
        return pd.read_sql(sql, conn)

# token → loader. A validator's required_data token must be a key here to run.
_LOADERS = {
    "market_panel_resolved": load_market_panel,
    "market_panel_full": load_market_panel_full,
    "flb_shadow_signals": load_flb_shadow,
}

def load_all_datasets(database_url: str | None = None) -> dict:
    """Load every known dataset; a loader that errors or returns empty maps to
    None so the runner treats its hypotheses as blocked (never crashes)."""
    out = {}
    for token, loader in _LOADERS.items():
        try:
            df = loader(database_url)
            out[token] = df if df is not None and len(df) else None
        except Exception:
            out[token] = None
    return out


# --- offline CSV mode (--datasets-dir): drive the harness without DB access ---
#
# The dashboard container is Node/Alpine (no Python, no psycopg2), so the weekly
# GHA runner exports each raw query to CSV on the VM, then runs run.py against
# the CSV dir. A CSV mirrors the RAW SQL output; the same shape_* transforms run
# on it, so the resulting frames are identical to the DB path.

def _read_raw_csv(path: pathlib.Path, date_cols: list[str]) -> pd.DataFrame:
    df = pd.read_csv(path)
    for c in date_cols:
        if c in df.columns:
            # format='ISO8601' (not the default first-row inference): Postgres COPY
            # omits the fractional part when a timestamp's microseconds are 0, so a
            # column mixes "…:40.956+00" and "…:03+00". Inferring one format from
            # row 0 then throws on the first whole-second row — which silently mapped
            # mm_fine_fills (and any such dataset) to None, blocking H-MM-3 forever.
            df[c] = pd.to_datetime(df[c], utc=True, format="ISO8601")
    return df

def load_all_datasets_from_dir(datasets_dir: str) -> dict:
    """Mirror of load_all_datasets, reading raw CSVs from `datasets_dir` instead
    of the DB. Expected files: market_panel.csv (raw RESOLVED_SQL columns) and
    flb_shadow_signals.csv (raw FLB_SQL columns). A missing/empty/invalid file
    maps its token(s) to None, same contract as the DB path."""
    d = pathlib.Path(datasets_dir)
    out: dict = {}
    try:
        raw = _read_raw_csv(d / "market_panel.csv", ["snapshot_at", "end_date"])
        out["market_panel_resolved"] = shape_panel(raw) if len(raw) else None
        out["market_panel_full"] = shape_panel_full(raw) if len(raw) else None
    except Exception:
        out["market_panel_resolved"] = None
        out["market_panel_full"] = None
    try:
        flb = _read_raw_csv(d / "flb_shadow_signals.csv", ["resolved_at"])
        out["flb_shadow_signals"] = flb if len(flb) else None
    except Exception:
        out["flb_shadow_signals"] = None
    try:
        # CSV-mode only: the asof-join that builds mm_trade_spreads runs in SQL on
        # the VM (see mm_trade_spreads.sql) and is too heavy for the DB-mode
        # load_all_datasets, so there is deliberately no _LOADERS entry. H-MM-1
        # is therefore blocked in DB mode and runs only from this CSV export.
        mm = _read_raw_csv(d / "mm_trade_spreads.csv", ["time"])
        out["mm_trade_spreads"] = mm if len(mm) else None
    except Exception:
        out["mm_trade_spreads"] = None
    try:
        fine = _read_raw_csv(d / "mm_fine_fills.csv", ["time"])
        out["mm_fine_fills"] = fine if len(fine) else None
    except Exception:
        out["mm_fine_fills"] = None
    try:
        # Optional: capture-gap windows the H-MM-3 walk must skip/reset over.
        # None (missing or empty) means "no gaps" — it never blocks H-MM-3.
        gaps = _read_raw_csv(d / "mm_gaps.csv", ["gap_start", "gap_end"])
        out["mm_gaps"] = gaps if len(gaps) else None
    except Exception:
        out["mm_gaps"] = None
    return out
