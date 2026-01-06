"""
FastAPI Server for ML Optimization Services

Exposes Bayesian optimization and ML combiner functionality via REST API.
"""

from contextlib import asynccontextmanager
from typing import Dict, List, Optional, Any
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import numpy as np
import logging
import uuid
from pathlib import Path
import asyncio
from concurrent.futures import ThreadPoolExecutor

from optimizers.bayesian_optimizer import (
    BayesianOptimizer,
    OnlineBayesianOptimizer,
    SignalBounds,
    OptimizationResult,
)
from combiners.ml_combiner import (
    XGBoostCombiner,
    EnsembleCombiner,
    SignalFeatures,
    TrainingExample,
    CombinerOutput,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Thread pool for CPU-bound operations
executor = ThreadPoolExecutor(max_workers=4)

# Storage for active optimizers and models
active_optimizers: Dict[str, OnlineBayesianOptimizer] = {}
active_combiners: Dict[str, XGBoostCombiner] = {}
optimization_jobs: Dict[str, Dict[str, Any]] = {}

# Model storage path
MODEL_PATH = Path("models")
MODEL_PATH.mkdir(exist_ok=True)


# ============================================
# Pydantic Models
# ============================================


class SignalBoundsRequest(BaseModel):
    """Request model for signal bounds."""

    signal_id: str
    min_weight: float = 0.0
    max_weight: float = 1.0
    initial_weight: float = 0.5


class OptimizeRequest(BaseModel):
    """Request to start optimization."""

    signal_bounds: List[SignalBoundsRequest]
    n_calls: int = Field(default=50, ge=10, le=200)
    n_initial_points: int = Field(default=10, ge=5, le=50)
    objective_scores: Optional[List[Dict[str, Any]]] = None


class EvaluationRequest(BaseModel):
    """Request to record a weight evaluation."""

    optimizer_id: str
    weights: Dict[str, float]
    score: float


class SuggestRequest(BaseModel):
    """Request for next weight suggestions."""

    optimizer_id: str
    n_suggestions: int = 1


class SignalFeaturesRequest(BaseModel):
    """Signal features for prediction."""

    signal_id: str
    market_id: str
    timestamp: str
    direction: str
    strength: float
    confidence: float
    features: List[float] = []


class TrainingExampleRequest(BaseModel):
    """Training example for ML combiner."""

    signals: List[SignalFeaturesRequest]
    market_id: str
    timestamp: str
    actual_outcome: float
    pnl: float


class TrainCombinerRequest(BaseModel):
    """Request to train ML combiner."""

    signal_ids: List[str]
    examples: List[TrainingExampleRequest]
    model_type: str = "xgboost"  # or "ensemble"


class PredictRequest(BaseModel):
    """Request for combiner prediction."""

    combiner_id: str
    signals: List[SignalFeaturesRequest]


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    active_optimizers: int
    active_combiners: int


# ============================================
# Lifespan
# ============================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    logger.info("Starting ML Optimization Server")
    yield
    logger.info("Shutting down ML Optimization Server")
    executor.shutdown(wait=True)


# ============================================
# FastAPI App
# ============================================


def create_app() -> FastAPI:
    """Create FastAPI application."""
    app = FastAPI(
        title="Polymarket ML Optimizer",
        description="ML optimization services for signal weight tuning",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return app


app = create_app()


# ============================================
# Health & Info Endpoints
# ============================================


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    return HealthResponse(
        status="healthy",
        active_optimizers=len(active_optimizers),
        active_combiners=len(active_combiners),
    )


@app.get("/info")
async def get_info():
    """Get server info."""
    return {
        "name": "Polymarket ML Optimizer",
        "version": "0.1.0",
        "features": [
            "bayesian_optimization",
            "online_optimization",
            "xgboost_combiner",
            "ensemble_combiner",
        ],
    }


# ============================================
# Bayesian Optimization Endpoints
# ============================================


@app.post("/optimizer/create")
async def create_optimizer(request: OptimizeRequest):
    """Create a new online optimizer."""
    optimizer_id = str(uuid.uuid4())

    bounds = [
        SignalBounds(
            signal_id=b.signal_id,
            min_weight=b.min_weight,
            max_weight=b.max_weight,
            initial_weight=b.initial_weight,
        )
        for b in request.signal_bounds
    ]

    optimizer = OnlineBayesianOptimizer(
        signal_bounds=bounds,
        window_size=100,
        update_interval=10,
    )

    active_optimizers[optimizer_id] = optimizer

    logger.info(f"Created optimizer {optimizer_id} with {len(bounds)} signals")

    return {
        "optimizer_id": optimizer_id,
        "signal_ids": [b.signal_id for b in bounds],
        "initial_weights": optimizer.current_weights,
    }


@app.post("/optimizer/evaluate")
async def record_evaluation(request: EvaluationRequest):
    """Record a weight/score evaluation."""
    if request.optimizer_id not in active_optimizers:
        raise HTTPException(status_code=404, detail="Optimizer not found")

    optimizer = active_optimizers[request.optimizer_id]
    optimizer.record_evaluation(request.weights, request.score)

    return {
        "recorded": True,
        "should_update": optimizer.should_update(),
        "statistics": optimizer.get_statistics(),
    }


@app.post("/optimizer/suggest")
async def suggest_weights(request: SuggestRequest):
    """Get next weight suggestions."""
    if request.optimizer_id not in active_optimizers:
        raise HTTPException(status_code=404, detail="Optimizer not found")

    optimizer = active_optimizers[request.optimizer_id]

    # Run in thread pool (CPU-bound)
    loop = asyncio.get_event_loop()
    suggestions = await loop.run_in_executor(
        executor,
        lambda: [optimizer.get_next_weights() for _ in range(request.n_suggestions)],
    )

    return {
        "suggestions": suggestions,
        "best_weights": optimizer.get_best_weights(),
    }


@app.get("/optimizer/{optimizer_id}/best")
async def get_best_weights(optimizer_id: str):
    """Get the best weights found so far."""
    if optimizer_id not in active_optimizers:
        raise HTTPException(status_code=404, detail="Optimizer not found")

    optimizer = active_optimizers[optimizer_id]
    return {
        "best_weights": optimizer.get_best_weights(),
        "statistics": optimizer.get_statistics(),
    }


@app.post("/optimizer/batch")
async def batch_optimize(
    request: OptimizeRequest,
    background_tasks: BackgroundTasks,
):
    """
    Run batch Bayesian optimization.

    This is a long-running operation that runs in the background.
    """
    job_id = str(uuid.uuid4())

    bounds = [
        SignalBounds(
            signal_id=b.signal_id,
            min_weight=b.min_weight,
            max_weight=b.max_weight,
            initial_weight=b.initial_weight,
        )
        for b in request.signal_bounds
    ]

    optimization_jobs[job_id] = {
        "status": "running",
        "progress": 0,
        "result": None,
    }

    async def run_optimization():
        try:
            optimizer = BayesianOptimizer(signal_bounds=bounds)

            # If we have pre-evaluated scores, use them
            if request.objective_scores:
                evaluated_points = [
                    (s["weights"], s["score"]) for s in request.objective_scores
                ]
                suggestions = optimizer.suggest_next(
                    evaluated_points,
                    n_suggestions=request.n_calls,
                )
                optimization_jobs[job_id]["result"] = {
                    "suggestions": suggestions,
                    "evaluated_points": request.objective_scores,
                }
            else:
                # Just return initial suggestions
                suggestions = optimizer.suggest_next([], n_suggestions=request.n_initial_points)
                optimization_jobs[job_id]["result"] = {
                    "suggestions": suggestions,
                    "message": "Provide evaluated scores to continue optimization",
                }

            optimization_jobs[job_id]["status"] = "completed"
            optimization_jobs[job_id]["progress"] = 100

        except Exception as e:
            optimization_jobs[job_id]["status"] = "failed"
            optimization_jobs[job_id]["error"] = str(e)
            logger.error(f"Optimization failed: {e}")

    background_tasks.add_task(run_optimization)

    return {
        "job_id": job_id,
        "status": "started",
    }


@app.get("/optimizer/job/{job_id}")
async def get_optimization_job(job_id: str):
    """Get the status of an optimization job."""
    if job_id not in optimization_jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    return optimization_jobs[job_id]


@app.delete("/optimizer/{optimizer_id}")
async def delete_optimizer(optimizer_id: str):
    """Delete an optimizer."""
    if optimizer_id not in active_optimizers:
        raise HTTPException(status_code=404, detail="Optimizer not found")

    del active_optimizers[optimizer_id]
    return {"deleted": True}


# ============================================
# ML Combiner Endpoints
# ============================================


def _convert_training_example(req: TrainingExampleRequest) -> TrainingExample:
    """Convert request to training example."""
    signals = [
        SignalFeatures(
            signal_id=s.signal_id,
            market_id=s.market_id,
            timestamp=s.timestamp,
            direction=s.direction,
            strength=s.strength,
            confidence=s.confidence,
            features=s.features,
        )
        for s in req.signals
    ]
    return TrainingExample(
        signals=signals,
        market_id=req.market_id,
        timestamp=req.timestamp,
        actual_outcome=req.actual_outcome,
        pnl=req.pnl,
    )


@app.post("/combiner/train")
async def train_combiner(request: TrainCombinerRequest):
    """Train a new ML combiner."""
    combiner_id = str(uuid.uuid4())

    # Convert examples
    examples = [_convert_training_example(e) for e in request.examples]

    if len(examples) < 20:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 20 training examples, got {len(examples)}",
        )

    # Create and train combiner
    if request.model_type == "ensemble":
        combiner = EnsembleCombiner(signal_ids=request.signal_ids)
    else:
        combiner = XGBoostCombiner(signal_ids=request.signal_ids)

    # Run training in thread pool
    loop = asyncio.get_event_loop()
    metrics = await loop.run_in_executor(
        executor,
        lambda: combiner.fit(examples),
    )

    active_combiners[combiner_id] = combiner

    # Save model
    model_path = MODEL_PATH / f"{combiner_id}.pkl"
    combiner.save(str(model_path))

    logger.info(f"Trained combiner {combiner_id}: {metrics}")

    return {
        "combiner_id": combiner_id,
        "metrics": metrics,
        "model_path": str(model_path),
    }


@app.post("/combiner/predict")
async def predict_combined_signal(request: PredictRequest):
    """Get prediction from ML combiner."""
    if request.combiner_id not in active_combiners:
        # Try to load from disk
        model_path = MODEL_PATH / f"{request.combiner_id}.pkl"
        if not model_path.exists():
            raise HTTPException(status_code=404, detail="Combiner not found")

        combiner = XGBoostCombiner(signal_ids=[])
        combiner.load(str(model_path))
        active_combiners[request.combiner_id] = combiner

    combiner = active_combiners[request.combiner_id]

    signals = [
        SignalFeatures(
            signal_id=s.signal_id,
            market_id=s.market_id,
            timestamp=s.timestamp,
            direction=s.direction,
            strength=s.strength,
            confidence=s.confidence,
            features=s.features,
        )
        for s in request.signals
    ]

    output = combiner.predict(signals)

    return {
        "direction": output.direction,
        "strength": output.strength,
        "confidence": output.confidence,
        "predicted_edge": output.predicted_edge,
        "feature_importance": output.feature_importance,
    }


@app.post("/combiner/{combiner_id}/update")
async def update_combiner(
    combiner_id: str,
    request: TrainCombinerRequest,
):
    """Incrementally update a combiner with new data."""
    if combiner_id not in active_combiners:
        raise HTTPException(status_code=404, detail="Combiner not found")

    combiner = active_combiners[combiner_id]
    examples = [_convert_training_example(e) for e in request.examples]

    loop = asyncio.get_event_loop()
    metrics = await loop.run_in_executor(
        executor,
        lambda: combiner.partial_fit(examples),
    )

    # Save updated model
    model_path = MODEL_PATH / f"{combiner_id}.pkl"
    combiner.save(str(model_path))

    return {
        "combiner_id": combiner_id,
        "metrics": metrics,
        "updated": True,
    }


@app.get("/combiner/{combiner_id}/importance")
async def get_feature_importance(combiner_id: str):
    """Get feature importance from combiner."""
    if combiner_id not in active_combiners:
        raise HTTPException(status_code=404, detail="Combiner not found")

    combiner = active_combiners[combiner_id]
    importance = combiner.get_feature_importance()

    return {
        "combiner_id": combiner_id,
        "feature_importance": importance,
    }


@app.delete("/combiner/{combiner_id}")
async def delete_combiner(combiner_id: str):
    """Delete a combiner."""
    if combiner_id in active_combiners:
        del active_combiners[combiner_id]

    model_path = MODEL_PATH / f"{combiner_id}.pkl"
    if model_path.exists():
        model_path.unlink()

    return {"deleted": True}


# ============================================
# Run Server
# ============================================


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "optimizer_server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
