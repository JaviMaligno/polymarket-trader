from __future__ import annotations
from dataclasses import dataclass, asdict
import json

@dataclass(frozen=True)
class Verdict:
    hypothesis_id: str
    hclass: str
    n: int
    edge_net_pct: float | None
    edge_insample_pct: float | None
    significance: float | None
    split: str
    class_metric: dict
    cost_model: str
    status: str
    n_caveats: list
    computed_at: str

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)

    @staticmethod
    def from_json(s: str) -> "Verdict":
        return Verdict(**json.loads(s))
