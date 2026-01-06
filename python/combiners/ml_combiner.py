"""
ML-based Signal Combiners

Uses machine learning models to learn optimal signal combination
strategies from historical data.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Any
import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, brier_score_loss
import xgboost as xgb
import logging
import pickle
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class SignalFeatures:
    """Features from a single signal observation."""

    signal_id: str
    market_id: str
    timestamp: str
    direction: str  # 'LONG', 'SHORT', 'NEUTRAL'
    strength: float
    confidence: float
    features: List[float]  # Additional signal-specific features


@dataclass
class TrainingExample:
    """A single training example for the combiner."""

    signals: List[SignalFeatures]
    market_id: str
    timestamp: str
    actual_outcome: float  # 1.0 for correct, 0.0 for incorrect
    pnl: float  # Actual P&L from the trade


@dataclass
class CombinerOutput:
    """Output from the ML combiner."""

    direction: str
    strength: float
    confidence: float
    predicted_edge: float
    feature_importance: Dict[str, float]


class MLCombiner(ABC):
    """Abstract base class for ML-based signal combiners."""

    @abstractmethod
    def fit(self, examples: List[TrainingExample]) -> Dict[str, float]:
        """
        Train the combiner on historical data.

        Args:
            examples: List of training examples

        Returns:
            Dictionary of training metrics
        """
        pass

    @abstractmethod
    def predict(self, signals: List[SignalFeatures]) -> CombinerOutput:
        """
        Combine signals to produce a trading decision.

        Args:
            signals: List of signal outputs for a market

        Returns:
            Combined signal output
        """
        pass

    @abstractmethod
    def save(self, path: str) -> None:
        """Save model to disk."""
        pass

    @abstractmethod
    def load(self, path: str) -> None:
        """Load model from disk."""
        pass


class XGBoostCombiner(MLCombiner):
    """
    XGBoost-based signal combiner.

    Features:
    - Handles non-linear signal interactions
    - Built-in feature importance
    - Robust to overfitting with proper regularization
    - Supports incremental training
    """

    def __init__(
        self,
        signal_ids: List[str],
        n_estimators: int = 100,
        max_depth: int = 4,
        learning_rate: float = 0.1,
        min_child_weight: int = 5,
        subsample: float = 0.8,
        colsample_bytree: float = 0.8,
        reg_alpha: float = 0.1,
        reg_lambda: float = 1.0,
    ):
        """
        Initialize the XGBoost combiner.

        Args:
            signal_ids: List of signal identifiers
            n_estimators: Number of boosting rounds
            max_depth: Maximum tree depth
            learning_rate: Boosting learning rate
            min_child_weight: Minimum sum of instance weight in child
            subsample: Subsample ratio of training instances
            colsample_bytree: Subsample ratio of columns for each tree
            reg_alpha: L1 regularization
            reg_lambda: L2 regularization
        """
        self.signal_ids = signal_ids
        self.n_features_per_signal = 4  # direction, strength, confidence, base_features

        self.model_params = {
            "n_estimators": n_estimators,
            "max_depth": max_depth,
            "learning_rate": learning_rate,
            "min_child_weight": min_child_weight,
            "subsample": subsample,
            "colsample_bytree": colsample_bytree,
            "reg_alpha": reg_alpha,
            "reg_lambda": reg_lambda,
            "objective": "binary:logistic",
            "eval_metric": "auc",
            "random_state": 42,
        }

        self.model: Optional[xgb.XGBClassifier] = None
        self.scaler = StandardScaler()
        self.feature_names: List[str] = []
        self.is_fitted = False

    def _build_feature_vector(self, signals: List[SignalFeatures]) -> np.ndarray:
        """Convert signals to feature vector."""
        features = []
        signal_map = {s.signal_id: s for s in signals}

        for signal_id in self.signal_ids:
            signal = signal_map.get(signal_id)

            if signal:
                # Direction encoding
                dir_encoding = {
                    "LONG": 1.0,
                    "SHORT": -1.0,
                    "NEUTRAL": 0.0
                }.get(signal.direction, 0.0)

                features.extend([
                    dir_encoding,
                    signal.strength,
                    signal.confidence,
                    signal.strength * signal.confidence,  # Interaction
                ])

                # Add additional features if available
                if signal.features:
                    features.extend(signal.features[:4])  # Limit to 4 extra features
                else:
                    features.extend([0.0] * 4)
            else:
                # Signal not present, fill with zeros
                features.extend([0.0] * 8)

        # Cross-signal features
        strengths = [signal_map[sid].strength if sid in signal_map else 0.0 for sid in self.signal_ids]
        confidences = [signal_map[sid].confidence if sid in signal_map else 0.0 for sid in self.signal_ids]

        features.extend([
            np.mean(strengths),
            np.std(strengths),
            np.mean(confidences),
            np.std(confidences),
            sum(1 for s in signals if s.direction == "LONG"),
            sum(1 for s in signals if s.direction == "SHORT"),
        ])

        return np.array(features)

    def _prepare_training_data(
        self,
        examples: List[TrainingExample],
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Prepare training data from examples."""
        X = []
        y = []

        for example in examples:
            features = self._build_feature_vector(example.signals)
            X.append(features)
            y.append(example.actual_outcome)

        return np.array(X), np.array(y)

    def fit(self, examples: List[TrainingExample]) -> Dict[str, float]:
        """Train the XGBoost model."""
        if len(examples) < 50:
            logger.warning(f"Only {len(examples)} examples, model may underfit")

        X, y = self._prepare_training_data(examples)

        # Scale features
        X_scaled = self.scaler.fit_transform(X)

        # Time series cross-validation
        tscv = TimeSeriesSplit(n_splits=3)
        cv_scores = []

        for train_idx, val_idx in tscv.split(X_scaled):
            X_train, X_val = X_scaled[train_idx], X_scaled[val_idx]
            y_train, y_val = y[train_idx], y[val_idx]

            model = xgb.XGBClassifier(**self.model_params)
            model.fit(
                X_train, y_train,
                eval_set=[(X_val, y_val)],
                verbose=False,
            )

            y_pred = model.predict_proba(X_val)[:, 1]
            cv_scores.append(roc_auc_score(y_val, y_pred))

        # Train final model on all data
        self.model = xgb.XGBClassifier(**self.model_params)
        self.model.fit(X_scaled, y, verbose=False)

        # Build feature names
        self._build_feature_names()
        self.is_fitted = True

        # Calculate metrics
        y_pred = self.model.predict_proba(X_scaled)[:, 1]
        train_auc = roc_auc_score(y, y_pred)
        brier = brier_score_loss(y, y_pred)

        metrics = {
            "train_auc": train_auc,
            "cv_auc_mean": np.mean(cv_scores),
            "cv_auc_std": np.std(cv_scores),
            "brier_score": brier,
            "n_examples": len(examples),
        }

        logger.info(f"XGBoost trained: AUC={train_auc:.4f}, CV AUC={np.mean(cv_scores):.4f}")
        return metrics

    def _build_feature_names(self) -> None:
        """Build feature names for interpretation."""
        self.feature_names = []

        for signal_id in self.signal_ids:
            self.feature_names.extend([
                f"{signal_id}_direction",
                f"{signal_id}_strength",
                f"{signal_id}_confidence",
                f"{signal_id}_strength_x_conf",
                f"{signal_id}_feat1",
                f"{signal_id}_feat2",
                f"{signal_id}_feat3",
                f"{signal_id}_feat4",
            ])

        self.feature_names.extend([
            "mean_strength",
            "std_strength",
            "mean_confidence",
            "std_confidence",
            "n_long_signals",
            "n_short_signals",
        ])

    def predict(self, signals: List[SignalFeatures]) -> CombinerOutput:
        """Predict combined signal."""
        if not self.is_fitted or self.model is None:
            raise ValueError("Model not fitted. Call fit() first.")

        features = self._build_feature_vector(signals)
        features_scaled = self.scaler.transform(features.reshape(1, -1))

        # Get prediction
        proba = self.model.predict_proba(features_scaled)[0]
        win_prob = proba[1]  # Probability of positive outcome

        # Determine direction and strength
        if win_prob > 0.55:
            direction = "LONG"
            strength = (win_prob - 0.5) * 2  # Scale to 0-1
        elif win_prob < 0.45:
            direction = "SHORT"
            strength = (0.5 - win_prob) * 2
        else:
            direction = "NEUTRAL"
            strength = 0.0

        # Get feature importance
        importance = dict(zip(
            self.feature_names,
            self.model.feature_importances_,
        ))

        # Aggregate importance by signal
        signal_importance = {}
        for signal_id in self.signal_ids:
            signal_features = [k for k in importance if k.startswith(signal_id)]
            signal_importance[signal_id] = sum(importance[k] for k in signal_features)

        # Predicted edge (expected value)
        predicted_edge = win_prob - 0.5

        return CombinerOutput(
            direction=direction,
            strength=strength,
            confidence=win_prob,
            predicted_edge=predicted_edge,
            feature_importance=signal_importance,
        )

    def save(self, path: str) -> None:
        """Save model to disk."""
        save_data = {
            "model": self.model,
            "scaler": self.scaler,
            "signal_ids": self.signal_ids,
            "model_params": self.model_params,
            "feature_names": self.feature_names,
            "is_fitted": self.is_fitted,
        }
        with open(path, "wb") as f:
            pickle.dump(save_data, f)

    def load(self, path: str) -> None:
        """Load model from disk."""
        with open(path, "rb") as f:
            save_data = pickle.load(f)

        self.model = save_data["model"]
        self.scaler = save_data["scaler"]
        self.signal_ids = save_data["signal_ids"]
        self.model_params = save_data["model_params"]
        self.feature_names = save_data["feature_names"]
        self.is_fitted = save_data["is_fitted"]

    def get_feature_importance(self) -> Dict[str, float]:
        """Get feature importance scores."""
        if not self.is_fitted or self.model is None:
            return {}

        return dict(zip(
            self.feature_names,
            self.model.feature_importances_,
        ))

    def partial_fit(self, new_examples: List[TrainingExample]) -> Dict[str, float]:
        """
        Incrementally update model with new data.

        Uses the existing model as a starting point.
        """
        if not self.is_fitted:
            return self.fit(new_examples)

        X, y = self._prepare_training_data(new_examples)
        X_scaled = self.scaler.transform(X)

        # Continue training with new data
        self.model.fit(
            X_scaled, y,
            xgb_model=self.model.get_booster(),
            verbose=False,
        )

        y_pred = self.model.predict_proba(X_scaled)[:, 1]
        return {
            "update_auc": roc_auc_score(y, y_pred) if len(set(y)) > 1 else 0.5,
            "n_new_examples": len(new_examples),
        }


class EnsembleCombiner(MLCombiner):
    """
    Ensemble of multiple combiners.

    Combines predictions from multiple models for more robust predictions.
    """

    def __init__(
        self,
        signal_ids: List[str],
        n_models: int = 5,
    ):
        """
        Initialize ensemble combiner.

        Args:
            signal_ids: List of signal identifiers
            n_models: Number of models in ensemble
        """
        self.signal_ids = signal_ids
        self.n_models = n_models
        self.models: List[XGBoostCombiner] = []
        self.is_fitted = False

    def fit(self, examples: List[TrainingExample]) -> Dict[str, float]:
        """Train ensemble with bootstrap sampling."""
        self.models = []
        all_metrics = []

        for i in range(self.n_models):
            # Bootstrap sample
            indices = np.random.choice(len(examples), size=len(examples), replace=True)
            sample = [examples[j] for j in indices]

            # Train model
            model = XGBoostCombiner(
                self.signal_ids,
                random_state=42 + i,
            )
            metrics = model.fit(sample)
            self.models.append(model)
            all_metrics.append(metrics)

        self.is_fitted = True

        return {
            "n_models": self.n_models,
            "mean_cv_auc": np.mean([m["cv_auc_mean"] for m in all_metrics]),
            "std_cv_auc": np.std([m["cv_auc_mean"] for m in all_metrics]),
        }

    def predict(self, signals: List[SignalFeatures]) -> CombinerOutput:
        """Predict using ensemble averaging."""
        if not self.is_fitted:
            raise ValueError("Model not fitted. Call fit() first.")

        predictions = [model.predict(signals) for model in self.models]

        # Average predictions
        avg_strength = np.mean([p.strength for p in predictions])
        avg_confidence = np.mean([p.confidence for p in predictions])
        avg_edge = np.mean([p.predicted_edge for p in predictions])

        # Vote on direction
        directions = [p.direction for p in predictions]
        direction_counts = {d: directions.count(d) for d in set(directions)}
        direction = max(direction_counts, key=direction_counts.get)

        # Average feature importance
        all_importance = [p.feature_importance for p in predictions]
        avg_importance = {}
        for signal_id in self.signal_ids:
            avg_importance[signal_id] = np.mean([
                imp.get(signal_id, 0) for imp in all_importance
            ])

        return CombinerOutput(
            direction=direction,
            strength=avg_strength,
            confidence=avg_confidence,
            predicted_edge=avg_edge,
            feature_importance=avg_importance,
        )

    def save(self, path: str) -> None:
        """Save ensemble to disk."""
        save_data = {
            "signal_ids": self.signal_ids,
            "n_models": self.n_models,
            "models": self.models,
            "is_fitted": self.is_fitted,
        }
        with open(path, "wb") as f:
            pickle.dump(save_data, f)

    def load(self, path: str) -> None:
        """Load ensemble from disk."""
        with open(path, "rb") as f:
            save_data = pickle.load(f)

        self.signal_ids = save_data["signal_ids"]
        self.n_models = save_data["n_models"]
        self.models = save_data["models"]
        self.is_fitted = save_data["is_fitted"]
