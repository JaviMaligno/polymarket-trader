"""Actual optimizer ASGI routes with synthetic in-memory optimizer responses."""

import importlib
from dataclasses import dataclass
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
import httpx
import pytest


@pytest.fixture
def api(monkeypatch):
    # Do not import Optuna, its samplers, storage adapters or scientific jobs.
    @dataclass
    class ParameterDefinition:
        name: str
        param_type: str
        low: float | None = None
        high: float | None = None
        choices: list | None = None
        log: bool = False

    optimizer = SimpleNamespace(
        suggest=Mock(return_value=[{"trial_id": 3, "params": {"threshold": 0.25}}]),
    )
    constructor = Mock(return_value=optimizer)
    constructor.load = Mock(side_effect=AssertionError("Forbidden storage access"))

    class OfflineOptimizer:
        def __new__(cls, *args, **kwargs):
            return constructor(*args, **kwargs)

        load = staticmethod(constructor.load)

    stub = ModuleType("app.optuna_optimizer")
    stub.ParameterDefinition = ParameterDefinition
    stub.OptunaOptimizer = OfflineOptimizer
    monkeypatch.setitem(sys.modules, "app.optuna_optimizer", stub)
    monkeypatch.delitem(sys.modules, "app.main", raising=False)
    monkeypatch.syspath_prepend(
        str(Path(__file__).resolve().parents[1] / "services/optimizer-server")
    )

    def refuse_network(*args, **kwargs):
        raise AssertionError("Forbidden external HTTP transport")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse_network)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse_network)
    main = importlib.import_module("app.main")
    main._active_optimizers.clear()
    with TestClient(main.app) as client:
        yield client, main, constructor, optimizer
    main._active_optimizers.clear()


def test_actual_health_contract_without_study_or_storage(api):
    client, _, constructor, _ = api
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
    assert isinstance(response.json()["timestamp"], str)
    constructor.assert_not_called()


def test_actual_create_and_suggest_json_contract_with_mock_optimizer(api):
    client, _, constructor, optimizer = api
    response = client.post(
        "/optimizer/create",
        json={
            "name": "synthetic-contract",
            "parameters": [{"name": "threshold", "type": "float", "low": 0, "high": 1}],
            "direction": "maximize",
            "sampler": "tpe",
            "n_startup_trials": 10,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["optimizer_id"].startswith("synthetic-contract-")
    assert body["parameter_names"] == ["threshold"]
    arguments = constructor.call_args.kwargs
    assert arguments["direction"] == "maximize"
    assert arguments["sampler"] == "tpe"
    assert arguments["parameters"][0].name == "threshold"
    suggested = client.post(
        "/optimizer/suggest",
        json={
            "optimizer_id": body["optimizer_id"],
            "n_suggestions": 1,
        },
    )
    assert suggested.status_code == 200
    assert suggested.json() == {"trial_ids": [3], "suggestions": [{"threshold": 0.25}]}
    optimizer.suggest.assert_called_once_with(1)


def test_invalid_json_never_constructs_an_optimizer(api):
    client, _, constructor, _ = api
    response = client.post("/optimizer/create", json={"name": "synthetic", "parameters": "invalid"})
    assert response.status_code == 422
    constructor.assert_not_called()
