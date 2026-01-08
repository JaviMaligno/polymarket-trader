"""
Optuna-based optimizer for trading strategy parameters.

Supports:
- TPE (Tree-structured Parzen Estimator) - default, good for most cases
- CMA-ES - good for continuous parameters
- Random Search - baseline
- Grid Search - exhaustive search
"""

import optuna
from optuna.samplers import TPESampler, CmaEsSampler, RandomSampler, GridSampler
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
import logging

# Suppress Optuna's verbose logging
optuna.logging.set_verbosity(optuna.logging.WARNING)

logger = logging.getLogger(__name__)


@dataclass
class ParameterDefinition:
    """Definition of a single parameter to optimize"""
    name: str
    param_type: str  # 'float', 'int', 'categorical'
    low: Optional[float] = None
    high: Optional[float] = None
    choices: Optional[List[Any]] = None
    log: bool = False  # use log scale


class OptunaOptimizer:
    """
    Wrapper around Optuna study for strategy optimization.

    Usage:
    1. Create optimizer with parameter definitions
    2. Call suggest() to get parameter suggestions
    3. Run backtest with suggested parameters
    4. Call report() with the result
    5. Repeat until satisfied or max iterations reached
    """

    def __init__(
        self,
        name: str,
        parameters: List[ParameterDefinition],
        direction: str = "maximize",
        sampler: str = "tpe",
        n_startup_trials: int = 10,
        seed: Optional[int] = None
    ):
        self.name = name
        self.parameters = {p.name: p for p in parameters}
        self.direction = direction

        # Create sampler
        if sampler == "tpe":
            sampler_obj = TPESampler(
                n_startup_trials=n_startup_trials,
                seed=seed
            )
        elif sampler == "cmaes":
            sampler_obj = CmaEsSampler(seed=seed)
        elif sampler == "random":
            sampler_obj = RandomSampler(seed=seed)
        elif sampler == "grid":
            # Grid sampler requires search_space
            search_space = self._build_grid_search_space()
            sampler_obj = GridSampler(search_space)
        else:
            raise ValueError(f"Unknown sampler: {sampler}")

        # Create study
        self.study = optuna.create_study(
            study_name=name,
            direction=direction,
            sampler=sampler_obj
        )

        # Track running trials
        self._running_trials: Dict[int, optuna.trial.Trial] = {}
        self._trial_metrics: Dict[int, Dict[str, float]] = {}

    def _build_grid_search_space(self) -> Dict[str, List[Any]]:
        """Build search space for grid sampler"""
        search_space = {}
        for name, param in self.parameters.items():
            if param.param_type == "categorical":
                search_space[name] = param.choices
            elif param.param_type == "int":
                # Create grid points
                n_points = min(10, int(param.high - param.low + 1))
                search_space[name] = list(range(int(param.low), int(param.high) + 1,
                    max(1, int((param.high - param.low) / n_points))))
            elif param.param_type == "float":
                # Create 10 grid points
                import numpy as np
                if param.log:
                    search_space[name] = list(np.logspace(
                        np.log10(param.low), np.log10(param.high), 10
                    ))
                else:
                    search_space[name] = list(np.linspace(param.low, param.high, 10))
        return search_space

    def suggest(self, n_suggestions: int = 1) -> List[Dict[str, Any]]:
        """
        Get parameter suggestions for the next trials.

        Returns list of dicts with trial_id and params.
        """
        suggestions = []

        for _ in range(n_suggestions):
            # Create a new trial
            trial = self.study.ask()

            # Sample parameters
            params = {}
            for name, param in self.parameters.items():
                if param.param_type == "float":
                    params[name] = trial.suggest_float(
                        name, param.low, param.high, log=param.log
                    )
                elif param.param_type == "int":
                    params[name] = trial.suggest_int(
                        name, int(param.low), int(param.high), log=param.log
                    )
                elif param.param_type == "categorical":
                    params[name] = trial.suggest_categorical(name, param.choices)

            # Store trial for later
            self._running_trials[trial.number] = trial

            suggestions.append({
                "trial_id": trial.number,
                "params": params
            })

        return suggestions

    def report(
        self,
        trial_id: int,
        score: float,
        metrics: Optional[Dict[str, float]] = None
    ):
        """
        Report the result of a trial.

        Args:
            trial_id: The trial ID from suggest()
            score: The objective value (e.g., Sharpe ratio)
            metrics: Optional additional metrics to store
        """
        if trial_id not in self._running_trials:
            raise ValueError(f"Unknown trial_id: {trial_id}")

        trial = self._running_trials[trial_id]

        # Store additional metrics as user attributes
        if metrics:
            for key, value in metrics.items():
                trial.set_user_attr(key, value)
            self._trial_metrics[trial_id] = metrics

        # Tell Optuna the result
        self.study.tell(trial, score)

        # Clean up
        del self._running_trials[trial_id]

    def get_best(self) -> Optional[Dict[str, Any]]:
        """Get the best parameters found so far"""
        if self.n_complete_trials == 0:
            return None

        best_trial = self.study.best_trial
        return {
            "params": best_trial.params,
            "score": best_trial.value,
            "trial_id": best_trial.number,
            "metrics": self._trial_metrics.get(best_trial.number, {})
        }

    def get_optimization_history(self) -> List[Dict[str, Any]]:
        """Get the optimization history"""
        history = []
        for trial in self.study.trials:
            if trial.state == optuna.trial.TrialState.COMPLETE:
                history.append({
                    "trial_id": trial.number,
                    "params": trial.params,
                    "score": trial.value,
                    "metrics": self._trial_metrics.get(trial.number, {})
                })
        return history

    def get_param_importances(self) -> Dict[str, float]:
        """Get parameter importance scores"""
        if self.n_complete_trials < 10:
            return {}

        try:
            importances = optuna.importance.get_param_importances(self.study)
            return dict(importances)
        except Exception as e:
            logger.warning(f"Could not compute parameter importances: {e}")
            return {}

    @property
    def n_trials(self) -> int:
        """Total number of trials (complete + running)"""
        return len(self.study.trials)

    @property
    def n_complete_trials(self) -> int:
        """Number of completed trials"""
        return len([t for t in self.study.trials
                   if t.state == optuna.trial.TrialState.COMPLETE])

    @property
    def n_running_trials(self) -> int:
        """Number of currently running trials"""
        return len(self._running_trials)


# ============================================
# Predefined Parameter Spaces
# ============================================

def get_default_parameter_space() -> List[ParameterDefinition]:
    """
    Default parameter space for Polymarket trading strategy.

    This covers all ~45 parameters from the design.
    """
    return [
        # === COMBINER ===
        ParameterDefinition("combiner.minCombinedConfidence", "float", 0.1, 0.7),
        ParameterDefinition("combiner.minCombinedStrength", "float", 0.1, 0.7),
        ParameterDefinition("combiner.onlyDirection", "categorical", choices=[None, "LONG", "SHORT"]),
        ParameterDefinition("combiner.momentumWeight", "float", 0.0, 3.0),
        ParameterDefinition("combiner.meanReversionWeight", "float", 0.0, 3.0),
        ParameterDefinition("combiner.conflictResolution", "categorical", choices=["weighted", "strongest", "majority"]),
        ParameterDefinition("combiner.timeDecayFactor", "float", 0.5, 1.0),
        ParameterDefinition("combiner.maxSignalAgeMinutes", "int", 5, 60),

        # === RISK ===
        ParameterDefinition("risk.maxPositionSizePct", "float", 1.0, 25.0),
        ParameterDefinition("risk.maxExposurePct", "float", 20.0, 100.0),
        ParameterDefinition("risk.stopLossPct", "float", 5.0, 40.0),
        ParameterDefinition("risk.takeProfitPct", "float", 10.0, 150.0),
        ParameterDefinition("risk.maxPositions", "int", 3, 30),
        ParameterDefinition("risk.maxDrawdownPct", "float", 10.0, 40.0),
        ParameterDefinition("risk.minCashBufferPct", "float", 5.0, 30.0),

        # === SIZING ===
        ParameterDefinition("sizing.method", "categorical", choices=["fixed", "kelly", "volatility_adjusted"]),
        ParameterDefinition("sizing.kellyFraction", "float", 0.1, 0.5),
        ParameterDefinition("sizing.volatilityLookback", "int", 10, 50),

        # === MOMENTUM SIGNAL ===
        ParameterDefinition("momentum.rsiPeriod", "int", 5, 28),
        ParameterDefinition("momentum.rsiOverbought", "float", 60.0, 90.0),
        ParameterDefinition("momentum.rsiOversold", "float", 10.0, 40.0),
        ParameterDefinition("momentum.macdFast", "int", 6, 18),
        ParameterDefinition("momentum.macdSlow", "int", 18, 35),
        ParameterDefinition("momentum.macdSignal", "int", 5, 15),
        ParameterDefinition("momentum.trendLookback", "int", 10, 50),
        ParameterDefinition("momentum.minTrendStrength", "float", 0.0, 0.3),

        # === MEAN REVERSION SIGNAL ===
        ParameterDefinition("meanReversion.bollingerPeriod", "int", 10, 40),
        ParameterDefinition("meanReversion.bollingerStdDev", "float", 1.0, 4.0),
        ParameterDefinition("meanReversion.zScorePeriod", "int", 5, 40),
        ParameterDefinition("meanReversion.zScoreThreshold", "float", 1.0, 4.0),
        ParameterDefinition("meanReversion.meanType", "categorical", choices=["sma", "ema", "wma"]),

        # === MARKET FILTERS ===
        ParameterDefinition("marketFilters.minVolume24h", "float", 100.0, 10000.0, log=True),
        ParameterDefinition("marketFilters.minLiquidity", "float", 1000.0, 50000.0, log=True),
        ParameterDefinition("marketFilters.priceRangeMin", "float", 0.02, 0.15),
        ParameterDefinition("marketFilters.priceRangeMax", "float", 0.85, 0.98),
        ParameterDefinition("marketFilters.minDaysToExpiry", "int", 1, 14),

        # === TIMING ===
        ParameterDefinition("timing.tradingHoursStart", "int", 0, 12),
        ParameterDefinition("timing.tradingHoursEnd", "int", 12, 24),
        ParameterDefinition("timing.avoidWeekends", "categorical", choices=[True, False]),
        ParameterDefinition("timing.minBarsBetweenTrades", "int", 1, 24),

        # === EXECUTION ===
        ParameterDefinition("execution.slippageModel", "categorical", choices=["fixed", "proportional", "orderbook"]),
        ParameterDefinition("execution.fixedSlippageBps", "int", 10, 100),
        ParameterDefinition("execution.maxSlippagePct", "float", 0.5, 3.0),
    ]


def get_minimal_parameter_space() -> List[ParameterDefinition]:
    """
    Minimal parameter space for quick optimization.
    Only includes the most impactful parameters.
    """
    return [
        ParameterDefinition("combiner.minCombinedConfidence", "float", 0.1, 0.6),
        ParameterDefinition("combiner.minCombinedStrength", "float", 0.1, 0.6),
        ParameterDefinition("combiner.onlyDirection", "categorical", choices=[None, "LONG", "SHORT"]),
        ParameterDefinition("risk.maxPositionSizePct", "float", 2.0, 20.0),
        ParameterDefinition("risk.maxPositions", "int", 3, 20),
        ParameterDefinition("momentum.rsiPeriod", "int", 7, 21),
        ParameterDefinition("meanReversion.bollingerPeriod", "int", 15, 30),
        ParameterDefinition("meanReversion.zScoreThreshold", "float", 1.5, 3.0),
    ]
