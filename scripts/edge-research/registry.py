from __future__ import annotations
import pathlib, yaml

_DEFAULT = pathlib.Path(__file__).resolve().parent / "registry.yaml"

def load_registry(path: str | None = None) -> list[dict]:
    p = pathlib.Path(path) if path else _DEFAULT
    with open(p) as f:
        entries = yaml.safe_load(f)
    if not isinstance(entries, list):
        raise ValueError("registry.yaml must be a list of entries")
    for e in entries:
        if "id" not in e or "status" not in e:
            raise ValueError(f"registry entry missing id/status: {e!r}")
    return entries

def runnable(entries: list[dict], available_data: set[str]) -> tuple[list[dict], list[dict]]:
    run, blocked = [], []
    for e in entries:
        if e["status"] == "closed":
            continue  # dead ends stay in registry but never run
        needs = set(e.get("required_data") or [])
        if needs <= available_data:
            run.append(e)
        else:
            blocked.append(e)
    return run, blocked
