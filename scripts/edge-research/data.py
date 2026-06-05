from __future__ import annotations
import os, pandas as pd

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
    import psycopg2
    url = database_url or os.environ["DATABASE_URL"]
    with psycopg2.connect(url) as conn:
        raw = pd.read_sql(RESOLVED_SQL, conn)
    return shape_panel(raw)

def available_data(database_url: str | None = None) -> set[str]:
    """Which registry required_data tokens are satisfiable. v1: only the panel."""
    try:
        df = load_market_panel(database_url)
        return {"market_panel_resolved"} if len(df) else set()
    except Exception:
        return set()
