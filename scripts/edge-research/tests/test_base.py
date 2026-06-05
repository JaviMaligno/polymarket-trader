import numpy as np
from validators.base import bootstrap_ci

def test_bootstrap_ci_is_deterministic_with_seed():
    x = np.array([0.01, 0.02, -0.005, 0.03, 0.015, 0.0, 0.04, -0.01])
    lo1, hi1 = bootstrap_ci(x, n_boot=500, seed=42)
    lo2, hi2 = bootstrap_ci(x, n_boot=500, seed=42)
    assert (lo1, hi1) == (lo2, hi2)

def test_bootstrap_ci_excludes_zero_for_clear_positive():
    x = np.full(200, 0.02)
    lo, hi = bootstrap_ci(x, n_boot=500, seed=1)
    assert lo > 0  # constant positive → CI well above 0
