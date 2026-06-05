from __future__ import annotations
import os, pandas as pd

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
    return earliest[["market_id", "yes_price", "outcome_yes", "market_type",
                     "ttr_days", "market_score"]]

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
