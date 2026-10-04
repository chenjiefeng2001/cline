---
"@cline/shared": minor
"@cline/agents": minor
"@cline/llms": minor
"@cline/core": minor
"@cline/sdk": minor
"@cline/cli": minor
"claude-dev": minor
---

feat: find files by name pattern, reach MCP resources, and bound what a run can cost

Three additions and two corrections that change what an agent can do and what a
host guarantees.

**A `glob` tool.** `search_codebase` answers "where is this text"; answering
"which files are named `*.spec.ts`" meant shelling out to `rg --files` and paying
a command round-trip for a directory listing. The new tool matches against the
workspace file index that `search_codebase` already uses, so both see the same
files, repeated globs cost one directory walk, and results cannot escape the
workspace.

**MCP resources and prompts, in the VS Code extension.** `McpHub` could list and
read resources and list prompts the whole time, but nothing exposed them to the
model, so a server publishing a resource was half-connected.
`list_mcp_resources`, `read_mcp_resource` and `list_mcp_prompts` close that, with
cross-server aggregation that survives one unreachable server. Prompt *execution*
is deliberately not exposed: it returns a message list rather than a tool result,
which is a product decision. The SDK's own MCP layer still speaks tools only, so
this is an extension capability for now.

**Run guardrails on ACP.** ACP is a real host, and an IDE session had no
iteration bound and no spend ceiling while the same agent in a terminal was
capped at 50 round-trips and $5. Both entry points now resolve through one
`resolveRunGuards` helper, so they cannot drift apart again. A malformed value
falls back to the default rather than removing the ceiling, and a spend-capped
run is no longer reported to the IDE as a clean completion.

Two corrections worth calling out, because both were documented as working:

- **A run budget of `0` now means no ceiling.** The settings UI and
  `package.json` promised that, and the extension silently applied a $5 limit
  instead.
- **Provider retry classification lives in `@cline/llms`** rather than in each
  host, so the CLI retries a 503 the way the extension always did. `401` is
  deliberately excluded, and a mid-stream 401 is now surfaced before it can be
  persisted as assistant text.

Also: tools declare `concurrency: "safe" | "exclusive"` (exclusive by default)
so read-only calls batch instead of running one at a time; the `pre_compact` hook
event is emitted from every path that compacts; tool output streams progressively
and is rendered by the VS Code extension; every VS Code setting is now reachable
from the UI; and approval routing and UI rendering exist for each new tool, since
a tool missing from either runs unapproved or renders as a blank row.