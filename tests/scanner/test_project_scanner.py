import os

from backend.config import ExplorerConfig
from backend.scanner.project_scanner import scan_project

SAMPLE_PROJECT = os.path.join(os.path.dirname(__file__), "..", "..", "sample_project")


def _scan():
    config = ExplorerConfig(project_path=SAMPLE_PROJECT)
    return scan_project(config)


def _find_module(result, suffix):
    for module in result.modules:
        if module.file_path.replace("\\", "/").endswith(suffix):
            return module
    raise AssertionError(f"no module ending in {suffix} found in {[m.file_path for m in result.modules]}")


def test_discovers_all_sample_functions():
    result = _scan()
    math_module = _find_module(result, "math_service.py")
    names = {f.name for f in math_module.functions}
    assert names == {"calculate_total", "classify_number", "calculate_total_async", "divide"}


def test_discovers_classes_and_methods():
    result = _scan()
    math_module = _find_module(result, "math_service.py")
    assert len(math_module.classes) == 1
    helper = math_module.classes[0]
    assert helper.name == "MathHelper"
    method_names = {m.name for m in helper.methods}
    assert method_names == {"__init__", "add_and_track"}
    add_method = next(m for m in helper.methods if m.name == "add_and_track")
    assert add_method.class_name == "MathHelper"
    assert add_method.qualified_name.endswith("MathHelper.add_and_track")


def test_parameters_and_defaults():
    result = _scan()
    math_module = _find_module(result, "math_service.py")
    async_fn = next(f for f in math_module.functions if f.name == "calculate_total_async")
    assert async_fn.is_async is True
    delay_param = next(p for p in async_fn.parameters if p.name == "delay")
    assert delay_param.default == "0.0"
    assert delay_param.required is False
    items_param = next(p for p in async_fn.parameters if p.name == "items")
    assert items_param.required is True
    assert items_param.annotation == "list[float]"


def test_return_annotation_and_line_numbers():
    result = _scan()
    math_module = _find_module(result, "math_service.py")
    divide_fn = next(f for f in math_module.functions if f.name == "divide")
    assert divide_fn.return_annotation == "float"
    assert divide_fn.line_number > 0
    assert divide_fn.end_line_number >= divide_fn.line_number


def test_qualified_names_disambiguate_same_named_functions():
    result = _scan()
    workflow_module = _find_module(result, "workflow_service.py")
    generate = next(f for f in workflow_module.functions if f.name == "generate_workflow")
    assert generate.qualified_name == "services.workflow_service.generate_workflow"


def test_function_ids_are_stable_and_unique():
    result = _scan()
    all_functions = [f for m in result.modules for f in m.functions] + [
        method for m in result.modules for c in m.classes for method in c.methods
    ]
    ids = [f.function_id for f in all_functions]
    assert len(ids) == len(set(ids)), "function_ids must be unique across the project"

    result_again = _scan()
    ids_again = {f.function_id for m in result_again.modules for f in m.functions}
    ids_first = {f.function_id for m in result.modules for f in m.functions}
    assert ids_again == ids_first, "rescanning must produce the same ids for unchanged code"


def test_broken_file_reports_error_but_does_not_block_scan():
    result = _scan()
    assert any(e.file_path.replace("\\", "/").endswith("broken.py") for e in result.errors)
    # other files must still be discovered despite the broken one
    _find_module(result, "math_service.py")
    _find_module(result, "helpers.py")


def test_ignores_dot_directories_and_venvs(tmp_path):
    project = tmp_path / "proj"
    (project / ".venv" / "site-packages").mkdir(parents=True)
    (project / ".venv" / "site-packages" / "noise.py").write_text("def noise(): pass\n")
    (project / "app").mkdir()
    (project / "app" / "__init__.py").write_text("")
    (project / "app" / "real.py").write_text("def real_fn(): pass\n")

    config = ExplorerConfig(project_path=str(project))
    result = scan_project(config)

    file_paths = {m.file_path.replace("\\", "/") for m in result.modules}
    assert "app/real.py" in file_paths
    assert not any(".venv" in fp for fp in file_paths)
