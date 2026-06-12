from registry import load_registry, runnable

def test_load_registry_parses_catalogue():
    entries = load_registry()  # default path = registry.yaml next to module
    ids = {e["id"] for e in entries}
    assert "H-CAL-1" in ids and "H-ARB-1" in ids
    assert len(entries) == 18

def test_runnable_filters_on_available_data_and_status():
    entries = [
        {"id": "A", "status": "planned", "required_data": ["market_panel_resolved"]},
        {"id": "B", "status": "planned", "required_data": ["gamma_rewards"]},
        {"id": "C", "status": "closed", "required_data": []},
    ]
    available = {"market_panel_resolved"}
    run, blocked = runnable(entries, available)
    assert [e["id"] for e in run] == ["A"]
    assert {e["id"] for e in blocked} == {"B"}  # C is closed, not blocked — excluded entirely
