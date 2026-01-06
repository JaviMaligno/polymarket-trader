"""
Bayesian Optimizer for Signal Weight Tuning

Uses Gaussian Process regression with Expected Improvement acquisition
to find optimal signal weights with minimal evaluations.
"""

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple
import numpy as np
from skopt import gp_minimize
from skopt.space import Real
from skopt.acquisition import gaussian_ei
from skopt.learning import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import Matern
import logging

logger = logging.getLogger(__name__)


@dataclass
class OptimizationResult:
    """Result of Bayesian optimization."""

    best_weights: Dict[str, float]
    best_score: float
    n_iterations: int
    convergence_history: List[float]
    all_weights: List[Dict[str, float]]
    all_scores: List[float]

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "best_weights": self.best_weights,
            "best_score": self.best_score,
            "n_iterations": self.n_iterations,
            "convergence_history": self.convergence_history,
            "all_weights": self.all_weights,
            "all_scores": self.all_scores,
        }


@dataclass
class SignalBounds:
    """Bounds for a signal weight."""

    signal_id: str
    min_weight: float = 0.0
    max_weight: float = 1.0
    initial_weight: float = 0.5


class BayesianOptimizer:
    """
    Bayesian optimizer for signal weight tuning.

    Uses Gaussian Process regression with Expected Improvement (EI)
    acquisition function to efficiently explore the weight space.

    Features:
    - Handles small sample sizes well (Bayesian approach)
    - Balances exploration vs exploitation
    - Provides uncertainty estimates
    - Supports constraints (weights sum to 1)
    """

    def __init__(
        self,
        signal_bounds: List[SignalBounds],
        normalize_weights: bool = True,
        random_state: int = 42,
    ):
        """
        Initialize the optimizer.

        Args:
            signal_bounds: List of bounds for each signal weight
            normalize_weights: If True, normalize weights to sum to 1
            random_state: Random seed for reproducibility
        """
        self.signal_bounds = signal_bounds
        self.signal_ids = [s.signal_id for s in signal_bounds]
        self.normalize_weights = normalize_weights
        self.random_state = random_state

        # Create search space
        self.dimensions = [
            Real(s.min_weight, s.max_weight, name=s.signal_id)
            for s in signal_bounds
        ]

        # Track optimization history
        self.history: List[Tuple[Dict[str, float], float]] = []

    def _normalize(self, weights: np.ndarray) -> np.ndarray:
        """Normalize weights to sum to 1."""
        total = np.sum(weights)
        if total > 0:
            return weights / total
        return np.ones_like(weights) / len(weights)

    def _weights_to_dict(self, weights: np.ndarray) -> Dict[str, float]:
        """Convert weight array to dictionary."""
        if self.normalize_weights:
            weights = self._normalize(weights)
        return {
            signal_id: float(weight)
            for signal_id, weight in zip(self.signal_ids, weights)
        }

    def optimize(
        self,
        objective_fn: Callable[[Dict[str, float]], float],
        n_calls: int = 50,
        n_initial_points: int = 10,
        acq_func: str = "EI",
        verbose: bool = True,
    ) -> OptimizationResult:
        """
        Run Bayesian optimization to find optimal weights.

        Args:
            objective_fn: Function that takes weights dict and returns score to MAXIMIZE
            n_calls: Total number of evaluations
            n_initial_points: Number of random initial evaluations
            acq_func: Acquisition function ("EI", "LCB", "PI")
            verbose: Print progress

        Returns:
            OptimizationResult with best weights and convergence history
        """
        convergence_history: List[float] = []
        all_weights: List[Dict[str, float]] = []
        all_scores: List[float] = []

        def wrapped_objective(x: List[float]) -> float:
            """Wrapper to convert to dict and negate (skopt minimizes)."""
            weights_dict = self._weights_to_dict(np.array(x))
            score = objective_fn(weights_dict)

            all_weights.append(weights_dict)
            all_scores.append(score)

            # Track best so far
            if len(convergence_history) == 0 or score > convergence_history[-1]:
                convergence_history.append(score)
            else:
                convergence_history.append(convergence_history[-1])

            if verbose:
                logger.info(f"Iteration {len(all_scores)}: score={score:.4f}, best={convergence_history[-1]:.4f}")

            # Negate because skopt minimizes
            return -score

        # Run optimization
        result = gp_minimize(
            wrapped_objective,
            self.dimensions,
            n_calls=n_calls,
            n_initial_points=n_initial_points,
            acq_func=acq_func,
            random_state=self.random_state,
            noise="gaussian",
        )

        # Get best weights
        best_weights = self._weights_to_dict(np.array(result.x))
        best_score = -result.fun

        return OptimizationResult(
            best_weights=best_weights,
            best_score=best_score,
            n_iterations=len(all_scores),
            convergence_history=convergence_history,
            all_weights=all_weights,
            all_scores=all_scores,
        )

    def optimize_with_constraints(
        self,
        objective_fn: Callable[[Dict[str, float]], float],
        constraint_fn: Optional[Callable[[Dict[str, float]], bool]] = None,
        n_calls: int = 50,
        n_initial_points: int = 10,
        penalty: float = -1000.0,
        verbose: bool = True,
    ) -> OptimizationResult:
        """
        Optimize with additional constraints.

        Args:
            objective_fn: Function to maximize
            constraint_fn: Function that returns True if weights are valid
            n_calls: Total evaluations
            n_initial_points: Initial random points
            penalty: Penalty for constraint violations
            verbose: Print progress

        Returns:
            OptimizationResult
        """
        def penalized_objective(weights: Dict[str, float]) -> float:
            if constraint_fn and not constraint_fn(weights):
                return penalty
            return objective_fn(weights)

        return self.optimize(
            penalized_objective,
            n_calls=n_calls,
            n_initial_points=n_initial_points,
            verbose=verbose,
        )

    def suggest_next(
        self,
        evaluated_points: List[Tuple[Dict[str, float], float]],
        n_suggestions: int = 1,
    ) -> List[Dict[str, float]]:
        """
        Suggest next points to evaluate based on history.

        Useful for online/incremental optimization.

        Args:
            evaluated_points: List of (weights, score) tuples
            n_suggestions: Number of points to suggest

        Returns:
            List of suggested weight dictionaries
        """
        if len(evaluated_points) < 3:
            # Not enough data for GP, return random points
            suggestions = []
            for _ in range(n_suggestions):
                weights = np.array([
                    np.random.uniform(s.min_weight, s.max_weight)
                    for s in self.signal_bounds
                ])
                suggestions.append(self._weights_to_dict(weights))
            return suggestions

        # Prepare data for GP
        X = np.array([
            [w[signal_id] for signal_id in self.signal_ids]
            for w, _ in evaluated_points
        ])
        y = np.array([score for _, score in evaluated_points])

        # Fit GP
        kernel = Matern(nu=2.5)
        gp = GaussianProcessRegressor(kernel=kernel, random_state=self.random_state)
        gp.fit(X, y)

        # Find points with high EI
        suggestions = []
        for _ in range(n_suggestions):
            # Random candidates
            n_candidates = 1000
            candidates = np.array([
                [np.random.uniform(s.min_weight, s.max_weight) for s in self.signal_bounds]
                for _ in range(n_candidates)
            ])

            # Calculate EI for candidates
            y_pred, y_std = gp.predict(candidates, return_std=True)
            best_y = np.max(y)

            # Expected Improvement
            z = (y_pred - best_y) / (y_std + 1e-8)
            ei = y_std * (z * self._norm_cdf(z) + self._norm_pdf(z))

            # Select best candidate
            best_idx = np.argmax(ei)
            suggestions.append(self._weights_to_dict(candidates[best_idx]))

        return suggestions

    @staticmethod
    def _norm_cdf(x: np.ndarray) -> np.ndarray:
        """Standard normal CDF."""
        from scipy.stats import norm
        return norm.cdf(x)

    @staticmethod
    def _norm_pdf(x: np.ndarray) -> np.ndarray:
        """Standard normal PDF."""
        from scipy.stats import norm
        return norm.pdf(x)

    def get_feature_importance(
        self,
        evaluated_points: List[Tuple[Dict[str, float], float]],
    ) -> Dict[str, float]:
        """
        Estimate which signals contribute most to performance.

        Uses GP length scales as proxy for importance.

        Args:
            evaluated_points: List of (weights, score) tuples

        Returns:
            Dictionary of signal_id -> importance score
        """
        if len(evaluated_points) < 5:
            return {s: 1.0 / len(self.signal_ids) for s in self.signal_ids}

        X = np.array([
            [w[signal_id] for signal_id in self.signal_ids]
            for w, _ in evaluated_points
        ])
        y = np.array([score for _, score in evaluated_points])

        # Fit GP with ARD kernel
        from sklearn.gaussian_process.kernels import RBF
        kernel = RBF(length_scale=np.ones(len(self.signal_ids)))
        gp = GaussianProcessRegressor(kernel=kernel, random_state=self.random_state)
        gp.fit(X, y)

        # Get length scales (smaller = more important)
        length_scales = gp.kernel_.length_scale
        importance = 1.0 / (length_scales + 1e-8)
        importance = importance / np.sum(importance)

        return {
            signal_id: float(imp)
            for signal_id, imp in zip(self.signal_ids, importance)
        }


class OnlineBayesianOptimizer:
    """
    Online learning variant for live weight updates.

    Maintains a sliding window of recent evaluations and
    periodically suggests new weights to try.
    """

    def __init__(
        self,
        signal_bounds: List[SignalBounds],
        window_size: int = 100,
        update_interval: int = 10,
        exploration_rate: float = 0.1,
    ):
        """
        Initialize online optimizer.

        Args:
            signal_bounds: Bounds for each signal
            window_size: Number of recent evaluations to keep
            update_interval: Suggest new weights every N evaluations
            exploration_rate: Probability of random exploration
        """
        self.optimizer = BayesianOptimizer(signal_bounds)
        self.window_size = window_size
        self.update_interval = update_interval
        self.exploration_rate = exploration_rate

        self.evaluation_history: List[Tuple[Dict[str, float], float]] = []
        self.current_weights: Dict[str, float] = {
            s.signal_id: s.initial_weight for s in signal_bounds
        }
        self.evaluation_count = 0

    def record_evaluation(self, weights: Dict[str, float], score: float) -> None:
        """Record a weight/score evaluation."""
        self.evaluation_history.append((weights, score))
        self.evaluation_count += 1

        # Trim to window size
        if len(self.evaluation_history) > self.window_size:
            self.evaluation_history = self.evaluation_history[-self.window_size:]

    def should_update(self) -> bool:
        """Check if it's time to suggest new weights."""
        return self.evaluation_count % self.update_interval == 0

    def get_next_weights(self) -> Dict[str, float]:
        """
        Get next weights to use.

        Balances exploitation (current best) with exploration.
        """
        if np.random.random() < self.exploration_rate:
            # Random exploration
            suggestions = self.optimizer.suggest_next([], n_suggestions=1)
            return suggestions[0]

        if len(self.evaluation_history) < 5:
            # Not enough data, use current
            return self.current_weights

        # Suggest based on GP
        suggestions = self.optimizer.suggest_next(
            self.evaluation_history,
            n_suggestions=1,
        )
        return suggestions[0]

    def get_best_weights(self) -> Dict[str, float]:
        """Get the best weights seen so far."""
        if not self.evaluation_history:
            return self.current_weights

        best_idx = np.argmax([score for _, score in self.evaluation_history])
        return self.evaluation_history[best_idx][0]

    def get_statistics(self) -> Dict:
        """Get optimization statistics."""
        if not self.evaluation_history:
            return {
                "n_evaluations": 0,
                "best_score": None,
                "avg_score": None,
                "score_std": None,
            }

        scores = [score for _, score in self.evaluation_history]
        return {
            "n_evaluations": len(self.evaluation_history),
            "best_score": float(np.max(scores)),
            "avg_score": float(np.mean(scores)),
            "score_std": float(np.std(scores)),
            "recent_trend": float(np.mean(scores[-10:]) - np.mean(scores[:10]))
            if len(scores) >= 20 else 0.0,
        }
