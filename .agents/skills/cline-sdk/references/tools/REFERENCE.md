# Tools

Tools are how agents interact with the world. The Cline SDK supports both built-in tools (via ClineCore) and custom tools you define yourself.

## Creating Custom Tools

Use `createTool()` from `@cline/sdk` (or `@cline/shared`):

```typescript
import { createTool } from "@cline/sdk"

const myTool = createTool({
  name: "search_issues",
  description: "Search GitHub issues by query. Returns up to 10 results.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      state: { type: "string", enum: ["open", "closed", "all"] },
    },
    required: ["query"],
  },
  execute: async (input) => {
    const issues = await github.searchIssues(input.query, input.state)
    return { issues, count: issues.length }
  },
})
```

### With Zod Schema

```typescript
import { createTool } from "@cline/sdk"
import { z } from "zod"

const deployTool = createTool({
  name: "deploy",
  description: "Deploy the app to the specified environment.",
  inputSchema: z.object({
    environment: z.enum(["staging", "production"]).describe("Target environment"),
    version: z.string().optional().describe("Version tag, defaults to latest"),
  }),
  execute: async (input) => {
    const result = await deploy(input.environment, input.version)
    return { url: result.url, status: "deployed" }
  },
})
```

### Tool Config Options

```typescript
createTool({
  name: string,                         // snake_case, unique per agent
  description: string,                  // what the tool does (model reads this)
  inputSchema: JSONSchema | ZodSchema,  // input validation
  execute: async (input, context) => output,
  concurrency?: "safe" | "exclusive",   // default: "exclusive"
  timeoutMs?: number,                   // default: 30000
  retryable?: boolean,                  // default: false
  maxRetries?: number,                  // default: 0
  lifecycle?: {
    completesRun?: boolean              // true = ends agent loop on success
  },
})
```

`concurrency` is the one to reason about before writing a tool. Leave it alone
and the tool runs alone, which is safe by default. Set `"safe"` only for a tool
that reads and keeps no shared state; the runtime then batches the safe tools of
a turn together behind a worker pool while preserving result order.

Retries are **off** by default (`retryable: false`, `maxRetries: 0`). Enabling
them is an explicit statement that the operation is idempotent.

### AgentToolContext

The second argument to `execute` provides runtime context:

```typescript
interface AgentToolContext {
  agentId: string
  conversationId: string
  iteration: number
  signal?: AbortSignal                 // cancelled when the run is aborted
  globPath?: string                    // per-call scope for name-pattern lookups
  metadata?: Record<string, unknown>
}
```

## Tool Naming Rules

- Names must be `snake_case` (e.g., `search_issues`, `deploy_app`)
- Names must be unique within a single agent's tool set
- Choose descriptive names since the model uses them to decide which tool to call

## Tool Descriptions Matter

The model reads the tool description to decide when and how to use it. Write clear, specific descriptions:

```typescript
// Bad: vague
description: "Does deployment stuff"

// Good: specific with constraints
description: "Deploy the application to staging or production. " +
  "Staging deployments are immediate. Production requires a passing CI build. " +
  "Returns the deployment URL and status."
```

Include constraints, rate limits, and expected behavior in the description.

## Error Handling in Tools

Return errors as structured data instead of throwing:

```typescript
// Good: return error data
execute: async (input) => {
  const file = await readFile(input.path).catch(() => null)
  if (!file) {
    return { error: "File not found", path: input.path }
  }
  return { content: file }
}
```

Thrown exceptions count as "mistakes" against the agent's mistake limit. Returned error data lets the agent adjust its approach.

## Completion Tools

Tools with `lifecycle: { completesRun: true }` end the agent loop when they execute successfully:

```typescript
const submitAnswer = createTool({
  name: "submit_answer",
  description: "Submit the final answer and end the task.",
  inputSchema: z.object({
    answer: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  lifecycle: { completesRun: true },
  execute: async (input) => input,
})
```

The model sees the tool result and the run ends. Access the output via `result.toolCalls`.

## Built-in Tools (ClineCore Only)

When using `ClineCore` with `enableTools: true`, these tools are available automatically:

| Tool | Name | What It Does |
|------|------|-------------|
| Read | `read_files` | Read file contents, optionally a line range |
| Search | `search_codebase` | Regex search file contents |
| Glob | `glob` | Find files by name pattern, e.g. `**/*.test.ts` |
| Shell | `run_commands` | Execute shell commands in the session workspace |
| Editor | `editor` | Create and edit files |
| Patch | `apply_patch` | Apply unified diffs to files |
| Web | `fetch_web_content` | Fetch URL content for analysis |
| Skills | `skills` | Run a configured skill in the main conversation |
| Ask | `ask_question` | Ask the user one multiple-choice question |
| Submit | `submit_and_exit` | Submit a final answer and stop (opt-in) |

`read_files`, `search_codebase` and `glob` declare `concurrency: "safe"` and are
the only tools that batch together by default; everything else runs alone.

Built-in tools respect the `cwd` setting in `CoreSessionConfig`.

## Tool Policies

Control which tools are available and whether they require approval:

```typescript
// In Agent config
const agent = new Agent({
  tools: [toolA, toolB, toolC],
  toolPolicies: {
    tool_a: { autoApprove: true },    // runs without asking
    tool_b: { autoApprove: false },   // requires approval
    tool_c: { enabled: false },       // hidden from model
  },
})

// In ClineCore session
await cline.start({
  prompt: "...",
  config: { ... },
  toolPolicies: {
    bash: { autoApprove: true },
    editor: { autoApprove: false },
  },
})
```

### Policy Options

| Policy | Effect |
|--------|--------|
| `{ autoApprove: true }` | Tool runs without approval |
| `{ autoApprove: false }` | Triggers approval callback before running |
| `{ enabled: false }` | Tool is hidden from the model entirely |
| No policy set | Defaults to enabled and auto-approved |

## Abort Signal in Long-Running Tools

Respect the abort signal for tools that take a long time:

```typescript
execute: async (input, context) => {
  const results = []
  for (const item of input.items) {
    if (context.signal?.aborted) {
      return { results, aborted: true, processed: results.length }
    }
    results.push(await processItem(item))
  }
  return { results, processed: results.length }
}
```

## Streaming Tool Output

Use the `onChange` callback (third argument) to stream partial results:

```typescript
execute: async (input, context, onChange) => {
  let progress = 0
  for (const step of steps) {
    progress++
    onChange?.(`Processing step ${progress}/${steps.length}...`)
    await processStep(step)
  }
  return { completed: true }
}
```

## Testing Tools

Tools are plain async functions, so they're straightforward to test:

```typescript
import { describe, it, expect } from "vitest"

describe("deploy tool", () => {
  it("deploys to staging", async () => {
    const context = { agentId: "test", conversationId: "test", iteration: 1 }
    const result = await deployTool.execute({ environment: "staging" }, context)
    expect(result.status).toBe("deployed")
  })
})
```

## MCP Tool Integration

ClineCore can connect to MCP (Model Context Protocol) servers for additional tools. The server list is read from `cline_mcp_settings.json` under the Cline data directory (override the directory with `CLINE_DATA_DIR`, or the file itself with `CLINE_MCP_SETTINGS_PATH`):

```json
{
  "servers": {
    "my-server": {
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  }
}
```

MCP tools appear alongside built-in and custom tools automatically.

The SDK's MCP layer speaks **tools only**. `list_mcp_resources`,
`read_mcp_resource` and `list_mcp_prompts` are contributed by the VS Code
extension's own MCP integration, so a headless host connected to the same server
can call its tools but cannot read its resources or prompts. Prompts are listed,
never executed.

## See Also

- `../agent/REFERENCE.md` - Using tools with Agent
- `../clinecore/REFERENCE.md` - Using tools with ClineCore
- `../plugins/REFERENCE.md` - Packaging tools as plugins
