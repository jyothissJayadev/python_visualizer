import os
import sys

import pytest

from backend.config import ExplorerConfig
from backend.tracer import monitor

SAMPLE_PROJECT = os.path.abspath(os.path.join(os.path.dirname(__file__), "sample_traced"))


@pytest.fixture
def config():
    return ExplorerConfig(project_path=SAMPLE_PROJECT, host_app="app.web:app", internal_api_key="s3cret")


@pytest.fixture(autouse=True)
def _import_environment():
    """Put the synthetic project on sys.path, and always release the
    sys.monitoring tool id afterwards so tests stay isolated."""
    original_path = list(sys.path)
    modules_before = set(sys.modules)
    sys.path.insert(0, SAMPLE_PROJECT)
    try:
        yield
    finally:
        monitor.uninstall()
        sys.path[:] = original_path
        for name in list(sys.modules):
            if name not in modules_before and (name == "app" or name.startswith("app.")):
                del sys.modules[name]
