# Installing telelog in a target project

Telelog has three parts: the visualizer (already running for this project), this skill, and an edit hook.

1. **MCP server.** The target's Claude Code needs the instance's server so the tools exist
   (`list_untagged`, `get_function`, `validate_tags`, ...). Copy the matching entry from the visualizer's
   `.mcp.json` (`brain-telemetry-<instance>`) into the target's `.mcp.json`; use absolute paths for `command`.
2. **Skill.** Copy or symlink this directory to `<target>/.claude/skills/telelog/`:
   `ln -s /path/to/python_visualizer/telelog <target>/.claude/skills/telelog`
3. **Hook.** Add to `<target>/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PostToolUse": [
         {
           "matcher": "Edit|Write|MultiEdit",
           "hooks": [
             { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/skills/telelog/hook.py\"" }
           ]
         }
       ]
     }
   }
   ```

   The hook finds the collector from `BRAIN_COLLECTOR_URL`, or from `instances.json` next to a symlinked
   `telelog/` (set `TELELOG_INSTANCES=/path/to/instances.json` if you copied instead). It is silent when the
   collector is down.
4. **`.telelog/` in the target.** Create `<target>/.telelog/` and commit `config`; gitignore `state/`:

   ```
   # .telelog/config  (all optional; tests, migrations and generated code are skipped by default)
   exclude: scripts/**
   defaults: off        # also stop skipping the built-in test/migration patterns
   ```

   ```
   # .gitignore
   .telelog/state/
   ```

Then run `/telelog` in Claude Code to tag the project. Watch the Map tab fill in.
