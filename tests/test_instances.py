import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import dev
from backend.app import create_app
from backend.config import ExplorerConfig
from backend.instances import InstanceError, load_instances, project_key


def write(tmp_path: Path, instances: list[dict]) -> Path:
    f = tmp_path / "instances.json"
    f.write_text(json.dumps({"instances": instances}))
    return f


def base(**over):
    d = {"name": "a", "project": "/tmp", "backend_port": 9001, "frontend_port": 9002}
    d.update(over)
    return d


def test_shipped_instances_file_is_valid_and_ports_are_distinct():
    inst = load_instances()
    assert {"atomics", "arthur"} <= set(inst)
    ports = [p for i in inst.values() for p in (i.backend_port, i.frontend_port)]
    assert len(ports) == len(set(ports))
    assert inst["atomics"].backend_port == 24811 and inst["atomics"].frontend_port == 24821   # unchanged defaults
    assert set(inst["arthur"].features) == {"terminal", "routes", "map"}


def test_env_for_target_points_at_this_instances_collector():
    arthur = load_instances()["arthur"]
    env = arthur.env_for_target()
    assert env["VISUALIZER_SINK_URL"] == f"http://127.0.0.1:{arthur.backend_port}"
    assert env["VISUALIZER_SELF_URL"] == "http://127.0.0.1:8080"


@pytest.mark.parametrize("items,msg", [
    ([base(), base(backend_port=9003, frontend_port=9004)], "duplicate instance name"),
    ([base(), base(name="b", backend_port=9001, frontend_port=9005)], "port 9001 used by both"),
    ([base(features=["terminal", "bogus"])], "unknown feature"),
    ([base(features=["routes"])], "'terminal' is required"),
    ([{"name": "x"}], "missing 'project'"),
    ([], "non-empty"),
])
def test_validation_errors(tmp_path, items, msg):
    with pytest.raises(InstanceError, match=msg):
        load_instances(write(tmp_path, items))


def test_missing_and_invalid_files(tmp_path):
    with pytest.raises(InstanceError, match="not found"):
        load_instances(tmp_path / "nope.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{")
    with pytest.raises(InstanceError, match="invalid JSON"):
        load_instances(bad)


def test_launcher_commands_use_each_instances_own_ports_and_features():
    inst = load_instances()
    a, b = inst["atomics"], inst["arthur"]
    cmd = dev.backend_command(b)
    assert cmd[cmd.index("--port") + 1] == "24812" and cmd[cmd.index("--name") + 1] == "arthur"
    assert cmd[cmd.index("--features") + 1] == "terminal,routes,map"
    fcmd = dev.frontend_command(b)
    assert fcmd[fcmd.index("--port") + 1] == "24822" and "--strictPort" in fcmd
    assert dev.frontend_env(a)["BRAIN_TERMINAL_BACKEND_PORT"] == "24811"
    assert dev.frontend_env(b)["BRAIN_TERMINAL_BACKEND_PORT"] == "24812"
    assert dev.frontend_env(b)["VIZ_FRONTEND_PORT"] == "24822"


def test_launcher_resolution(capsys):
    import argparse
    parser = argparse.ArgumentParser()
    ns = dev.argparse.Namespace(project=None, instance=["arthur", "arthur"], all=False, list=False,
                                instances_file=str(dev.DEFAULT_INSTANCES_FILE), backend_port=1, frontend_port=2, ignore=[])
    assert [i.name for i in dev.resolve(ns, parser)] == ["arthur"]                      # de-duplicated
    ns.instance, ns.all = [], True
    assert {i.name for i in dev.resolve(ns, parser)} == {"atomics", "arthur"}
    ns.all, ns.instance = False, ["nope"]
    with pytest.raises(SystemExit):
        dev.resolve(ns, parser)


def test_instance_endpoint_and_per_project_lineage_cache(tmp_path):
    cfg = ExplorerConfig(project_path=str(tmp_path), name="arthur", features=("terminal", "routes"))
    app = create_app(cfg, watch=False, cache_dir=tmp_path / ".cache", analyze_on_start=False)
    with TestClient(app) as c:
        body = c.get("/viewer/instance").json()
    assert body["name"] == "arthur" and body["features"] == ["terminal", "routes"]
    assert project_key("/a") != project_key("/b") and len(project_key("/a")) == 12


def test_seed_script_is_idempotent_against_a_collector(tmp_path, monkeypatch):
    """create -> 'created'; again -> 'exists' (409), never a failure."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("seed", Path(__file__).resolve().parent.parent / "scripts" / "seed_templates.py")
    seed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(seed)
    app = create_app(ExplorerConfig(project_path=str(tmp_path)), watch=False, cache_dir=tmp_path / ".cache",
                     analyze_on_start=False)
    with TestClient(app) as client:
        def fake_post(url, body):
            r = client.post(url.replace("http://127.0.0.1:24812", ""), json=body)
            return r.status_code, r.json()
        monkeypatch.setattr(seed, "post", fake_post)
        f = tmp_path / "t.json"
        f.write_text(json.dumps({"templates": [{"name": "one", "functions": [{"id": "a.b:c", "deep": False}]}]}))
        assert seed.main(["--instance", "arthur", "--file", str(f)]) == 0
        assert seed.main(["--instance", "arthur", "--file", str(f)]) == 0
        names = [t["name"] for t in client.get("/viewer/terminal/templates").json()["templates"]]
    assert names == ["one"]


def test_map_enabled_by_default_and_opt_out(tmp_path):
    import json
    from backend.instances import load_instances

    def load(extra):
        f = tmp_path / "i.json"
        f.write_text(json.dumps({"instances": [{"name": "a", "project": ".", "backend_port": 1, "frontend_port": 2,
                                                 "features": ["terminal", "routes"], **extra}]}))
        return load_instances(f)["a"].features

    assert "map" in load({})
    assert "map" not in load({"disable": ["map"]})
