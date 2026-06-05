from __future__ import annotations
from typing import Protocol
import numpy as np


class Validator(Protocol):
    hypothesis_id: str
    hclass: str

    def required_inputs(self) -> list[str]: ...

    def run(self, ctx) -> list:  # returns list[Verdict]
        ...


def bootstrap_ci(x, n_boot: int = 1000, seed: int = 0, alpha: float = 0.05):
    """Percentile bootstrap CI of the mean. Deterministic given seed."""
    x = np.asarray(x, dtype=float)
    if x.size == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = x[rng.integers(0, x.size, size=(n_boot, x.size))].mean(axis=1)
    lo = float(np.percentile(means, 100 * alpha / 2))
    hi = float(np.percentile(means, 100 * (1 - alpha / 2)))
    return (lo, hi)
