# Sourced by the workflow (decision loop and smoke test). Sets the claude CLI search
# flags for AGENT_WEB_SEARCH; entry_gate.reviewer_tool_args() does the same for the
# reviewer, so researcher and reviewer always search the same way.
#   builtin: Claude Code's WebSearch.
#   mcp:     search_mcp.py, with the built-in WebSearch disabled (Sonnet 5.5 on Foundry
#            rejects WebSearch's forced tool_choice, 2026-10-03).
_search_mcp="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/search_mcp.py"
case "${AGENT_WEB_SEARCH:-builtin}" in
  builtin)
    SEARCH_FLAGS=()
    SEARCH_TOOLS="WebSearch"
    ;;
  mcp)
    SEARCH_FLAGS=(--strict-mcp-config
      --mcp-config "{\"mcpServers\":{\"search\":{\"command\":\"python\",\"args\":[\"$_search_mcp\"]}}}"
      --disallowedTools WebSearch)
    SEARCH_TOOLS="mcp__search__web_search mcp__search__news_search"
    ;;
  *)
    echo "::error::unknown AGENT_WEB_SEARCH '$AGENT_WEB_SEARCH'" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac
