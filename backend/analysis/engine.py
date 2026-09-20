"""backend/analysis/engine.py — one-stop facade: index the project once, then
serve endpoints and their call-hierarchy trees.

    python -m backend.analysis.engine --project <root> --endpoint "POST /x" [--depth 6]
"""

from __future__ import annotations

import argparse
from typing import Any

from backend.analysis.callgraph import CallGraph
from backend.analysis.models import Endpoint, RouteAnalysis
from backend.analysis.registry import Registry
from backend.analysis.routes import RouteAnalyzer
from backend.analysis.symbols import ProjectIndex
from backend.config import DEFAULT_IGNORED_DIRECTORIES, ExplorerConfig


class Analysis:
    """A full static analysis of one project snapshot."""

    def __init__(self, project_path: str, extra_ignored: frozenset[str] = frozenset()):
        config = ExplorerConfig(
            project_path=project_path,
            ignored_directories=frozenset(DEFAULT_IGNORED_DIRECTORIES | set(extra_ignored)),
        )
        self.index = ProjectIndex(config)
        analyzer = RouteAnalyzer(self.index)
        analyzer.collect()
        analyzer.attach()
        self.routes: RouteAnalysis = analyzer.expand()
        self.registry = Registry(self.index)
        self.callgraph = CallGraph(self.index, self.registry)
        self._by_id: dict[str, Endpoint] = {e.id: e for e in self.routes.endpoints}

    def endpoint(self, endpoint_id: str) -> Endpoint | None:
        return self._by_id.get(endpoint_id)

    def tree(self, endpoint_id: str) -> dict[str, Any] | None:
        ep = self.endpoint(endpoint_id)
        return self.callgraph.endpoint_tree(ep) if ep else None


_ICONS = {"function": "ƒ", "external": "⊕", "unresolved": "?", "loop": "↻", "branch": "⑂", "arm": "·",
          "graph": "◈", "dispatch": "⇉", "class": "C"}


def print_tree(node: dict[str, Any], max_depth: int, depth: int = 0) -> None:
    if depth > max_depth:
        return
    label = f" {node['label']}" if node.get("label") and node["kind"] != "function" else ""
    edge = f" [{node['edge']}]" if node.get("edge") else ""
    count = f" ×{node['meta']['count']}" if node.get("meta", {}).get("count") else ""
    cyc = " (recursive)" if node.get("cyclic") else ""
    print(f"{'  ' * depth}{_ICONS.get(node['kind'], '?')} {node['name']}{edge}{label}{count}{cyc}")
    for child in node.get("children", []):
        print_tree(child, max_depth, depth + 1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Print an endpoint's call hierarchy.")
    parser.add_argument("--project", required=True)
    parser.add_argument("--endpoint", required=True, help='e.g. "POST /quotation/graph/{quotation_id}/commit"')
    parser.add_argument("--depth", type=int, default=6)
    args = parser.parse_args()
    analysis = Analysis(args.project)
    tree = analysis.tree(args.endpoint)
    if tree is None:
        raise SystemExit(f"no such endpoint: {args.endpoint}")
    print(tree["stats"])
    print_tree(tree["root"], args.depth)


if __name__ == "__main__":
    main()
