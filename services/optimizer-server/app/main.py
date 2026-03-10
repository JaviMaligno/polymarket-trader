"""
Polymarket Strategy Optimizer Server

FastAPI server that provides Bayesian optimization via Optuna
for the TypeScript trading system.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, List, Optional, Any
import uuid
import logging
from datetime import datetime

from .optuna_optimizer import OptunaOptimizer, ParameterDefinition

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Polymarket Strategy Optimizer",
    description="Bayesian optimization service for trading strategy parameters",
    version="2.0.0"
)

# CORS for TypeScript client
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cache of loaded optimizer instances (reloaded from PostgreSQL on miss)
_active_optimizers: Dict[str, OptunaOptimizer] = {}


def _get_optimizer(optimizer_id: str) -> OptunaOptimizer:
    """
    Retrieve an optimizer by ID, first checking the in-memory cache,
    then attempting to reload from PostgreSQL storage.
    """
    if optimizer_id in _active_optimizers:
        return _active_optimizers[optimizer_id]

    # Try to reload from PostgreSQL
    try:
        optimizer = OptunaOptimizer.load(optimizer_id)
        _active_optimizers[optimizer_id] = optimizer
        logger.info(f"Reloaded optimizer '{optimizer_id}' from PostgreSQL")
        return optimizer
    except KeyError:
        raise HTTPException(status_code=404, detail="Optimizer not found")


# ============================================
# Request/Response Models
# ============================================

class ParameterBounds(BaseModel):
    name: str
    type: str  # 'float', 'int', 'categorical'
    low: Optional[float] = None
    high: Optional[float] = None
    choices: Optional[List[Any]] = None
    log: bool = False  # log scale for float/int


class CreateOptimizerRequest(BaseModel):
    name: str
    parameters: List[ParameterBounds]
    direction: str = "maximize"  # 'maximize' or 'minimize'
    sampler: str = "tpe"  # 'tpe', 'cmaes', 'random', 'grid'
    n_startup_trials: int = 10


class CreateOptimizerResponse(BaseModel):
    optimizer_id: str
    name: str
    parameter_names: List[str]
    created_at: str


class SuggestRequest(BaseModel):
    optimizer_id: str
    n_suggestions: int = 1


class SuggestResponse(BaseModel):
    trial_ids: List[int]
    suggestions: List[Dict[str, Any]]


class ReportRequest(BaseModel):
    optimizer_id: str
    trial_id: int
    score: float
    metrics: Optional[Dict[str, float]] = None


class ReportResponse(BaseModel):
    recorded: bool
    best_score: Optional[float]
    best_params: Optional[Dict[str, Any]]
    n_trials: int


class BestParamsResponse(BaseModel):
    best_params: Optional[Dict[str, Any]]
    best_score: Optional[float]
    n_trials: int
    optimization_history: List[Dict[str, Any]]


class OptimizerStatusResponse(BaseModel):
    optimizer_id: str
    name: str
    n_trials: int
    n_complete: int
    n_running: int
    best_score: Optional[float]
    best_params: Optional[Dict[str, Any]]


# ============================================
# Endpoints
# ============================================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}


@app.post("/optimizer/create", response_model=CreateOptimizerResponse)
async def create_optimizer(request: CreateOptimizerRequest):
    """Create a new optimization session"""
    optimizer_id = f"{request.name}-{uuid.uuid4().hex[:8]}"

    # Convert parameter bounds to internal format
    param_defs = []
    for p in request.parameters:
        param_def = ParameterDefinition(
            name=p.name,
            param_type=p.type,
            low=p.low,
            high=p.high,
            choices=p.choices,
            log=p.log
        )
        param_defs.append(param_def)

    # Create optimizer (study is persisted to PostgreSQL)
    optimizer = OptunaOptimizer(
        name=optimizer_id,
        parameters=param_defs,
        direction=request.direction,
        sampler=request.sampler,
        n_startup_trials=request.n_startup_trials
    )

    _active_optimizers[optimizer_id] = optimizer

    return CreateOptimizerResponse(
        optimizer_id=optimizer_id,
        name=request.name,
        parameter_names=[p.name for p in request.parameters],
        created_at=datetime.utcnow().isoformat()
    )


@app.post("/optimizer/suggest", response_model=SuggestResponse)
async def suggest_params(request: SuggestRequest):
    """Get next parameter suggestions from the optimizer"""
    optimizer = _get_optimizer(request.optimizer_id)
    suggestions = optimizer.suggest(request.n_suggestions)

    return SuggestResponse(
        trial_ids=[s["trial_id"] for s in suggestions],
        suggestions=[s["params"] for s in suggestions]
    )


@app.post("/optimizer/report", response_model=ReportResponse)
async def report_result(request: ReportRequest):
    """Report the result of a trial"""
    optimizer = _get_optimizer(request.optimizer_id)
    optimizer.report(request.trial_id, request.score, request.metrics)

    best = optimizer.get_best()

    return ReportResponse(
        recorded=True,
        best_score=best["score"] if best else None,
        best_params=best["params"] if best else None,
        n_trials=optimizer.n_complete_trials
    )


@app.get("/optimizer/{optimizer_id}/best", response_model=BestParamsResponse)
async def get_best_params(optimizer_id: str):
    """Get the best parameters found so far"""
    optimizer = _get_optimizer(optimizer_id)
    best = optimizer.get_best()
    history = optimizer.get_optimization_history()

    return BestParamsResponse(
        best_params=best["params"] if best else None,
        best_score=best["score"] if best else None,
        n_trials=optimizer.n_complete_trials,
        optimization_history=history
    )


@app.get("/optimizer/{optimizer_id}/status", response_model=OptimizerStatusResponse)
async def get_optimizer_status(optimizer_id: str):
    """Get the current status of an optimizer"""
    optimizer = _get_optimizer(optimizer_id)
    best = optimizer.get_best()

    return OptimizerStatusResponse(
        optimizer_id=optimizer_id,
        name=optimizer.name,
        n_trials=optimizer.n_trials,
        n_complete=optimizer.n_complete_trials,
        n_running=optimizer.n_running_trials,
        best_score=best["score"] if best else None,
        best_params=best["params"] if best else None
    )


@app.delete("/optimizer/{optimizer_id}")
async def delete_optimizer(optimizer_id: str):
    """Delete an optimizer from PostgreSQL and cache"""
    OptunaOptimizer.delete_study(optimizer_id)
    _active_optimizers.pop(optimizer_id, None)
    return {"deleted": True}


@app.get("/optimizers")
async def list_optimizers():
    """List all active optimizers (from in-memory cache)"""
    result = []
    for opt_id, optimizer in _active_optimizers.items():
        best = optimizer.get_best()
        result.append({
            "optimizer_id": opt_id,
            "name": optimizer.name,
            "n_trials": optimizer.n_complete_trials,
            "best_score": best["score"] if best else None
        })
    return {"optimizers": result}


# ============================================
# Main
# ============================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
