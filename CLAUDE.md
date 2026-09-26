# Claude Code Integration Guide & Runtime Telemetry Skill

## Overview
This repository contains **Brain Terminal** (`python-backend-explorer`), a live telemetry, AST function scanner, and runtime I/O inspector for Python backends.

When writing, debugging, or modifying code in this codebase or the target backend, you have access to the **`brain-telemetry` MCP tools** to inspect real runtime behavior.

---

## 🛠️ Available MCP Tools

| Tool | Purpose |
| :--- | :--- |
| `list_functions(query)` | Search functions/methods discovered by the AST scanner in the backend code. Returns module paths, signatures, docstrings, and line numbers. |
| `arm_functions(function_ids, deep)` | Dynamically arm/instrument target functions (`module.path:QualName`) using PEP 669 `sys.monitoring` in the running backend. Set `deep=True` to trace child calls inside the function. |
| `get_recent_traces(limit, function_id, request_id)` | Query recent execution events, call hierarchy, timestamps, execution durations, and errors. |
| `get_function_io(request_id, span_id, field)` | Retrieve full, untruncated runtime `input` arguments, return `result`, or `exc` exception stack traces for a specific function span. |
| `get_status()` | Check if the backend ("brain") is connected and registered, and view active armed selections. |

---

## 🚀 Recommended Agent Workflow

### 1. When Fixing a Bug
1. Call `list_functions(query="<name>")` to find the exact target function ID (e.g. `app.services.quote:calculate_quote`).
2. Call `arm_functions(["app.services.quote:calculate_quote"], deep=True)` to enable tracing.
3. Trigger the failing flow.
4. Call `get_recent_traces(function_id="calculate_quote")` to inspect the failure.
5. Call `get_function_io(request_id=..., span_id=..., field="exc")` and `field="input"` to examine the exact arguments and exception.
6. Make the code fix with exact knowledge of the runtime payload.

### 2. When Refactoring or Adding Features
1. Before changing existing functions, check their actual input/output shapes via `get_recent_traces` and `get_function_io`.
2. Apply your changes.
3. Arm the functions and send a request to verify that return values and types remain compliant.

---

## ⚙️ Setup & Registration
To register this MCP server with Claude Code:
```bash
claude mcp add brain-telemetry python -m backend.mcp_server
```
or ensure `.mcp.json` exists in the repository root:
```json
{
  "mcpServers": {
    "brain-telemetry": {
      "command": "python",
      "args": ["-m", "backend.mcp_server"]
    }
  }
}
```

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
