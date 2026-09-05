import os
import sys

import pytest

from backend.config import ExplorerConfig
from backend.runner.function_runner import prepare_import_environment
from backend.scanner.project_scanner import scan_project

SAMPLE_PROJECT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "sample_project"))


@pytest.fixture
def config():
    return ExplorerConfig(project_path=SAMPLE_PROJECT)


@pytest.fixture
def scan_result(config):
    return scan_project(config)


@pytest.fixture(autouse=True)
def _import_environment(config):
    original_cwd = os.getcwd()
    original_path = list(sys.path)
    modules_before = set(sys.modules)
    prepare_import_environment(config)
    yield
    os.chdir(original_cwd)
    sys.path[:] = original_path
    for name in list(sys.modules):
        if name not in modules_before:
            del sys.modules[name]


def find_function(scan_result, name, *, class_name=None):
    for module in scan_result.modules:
        for fn in module.functions:
            if fn.name == name and fn.class_name == class_name:
                return fn
        for cls in module.classes:
            for method in cls.methods:
                if method.name == name and method.class_name == class_name:
                    return method
    raise AssertionError(f"function '{name}' (class_name={class_name}) not found in scan result")
