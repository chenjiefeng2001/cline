# Smoke Tests

Curated smoke tests that verify Cline works correctly with LLM providers.

## Purpose

These tests catch regressions in:
- Tool execution (read, write, edit files)
- Provider response parsing
- Tool chaining (multiple operations)
- Basic code generation

## Quick Start

```bash
# One-time auth setup
cline auth

# Run tests (3 trials by default)
npm run eval:smoke:run
```

## Commands

| Command | What it does |
|---------|--------------|
| `npm run eval:smoke:run` | Run tests (uses installed CLI) |

## Options

```bash
# Run specific scenario
npm run eval:smoke:run -- --scenario 01-create-file

# Run with fewer trials (faster)
npm run eval:smoke:run -- --trials 1

# Run with specific model (overrides any per-scenario models)
npm run eval:smoke:run -- --model claude-sonnet-4-5-20250929
```

## Authentication

### Interactive (recommended for local dev)

```bash
cline auth
```

### With API key (for automation)

```bash
cline auth -p cline -k "$CLINE_API_KEY" -m anthropic/claude-sonnet-4.5
```

## Scenarios

| ID | Name | What it tests |
|----|------|---------------|
| 01-create-file | Create a simple file | `write_to_file` |
| 02-edit-file | Edit existing file | `replace_in_file` |
| 03-read-summarize | Read and summarize | `read_file` |
| 04-multi-file | Create multiple files | Multiple tool calls |
| 05-typescript-function | Generate TypeScript | Code generation |
| 06-apply-patch | Edit file (GPT-5) | `apply_patch` tool, native tool calling |
| 07-edit-gemini | Edit file (Gemini) | Gemini model variant |

### Per-Scenario Models

Scenarios can specify their own model(s) via the `models` field in `config.json`. This is useful for testing model-specific code paths like `apply_patch` (GPT-5 only).

If you pass `--model`, it overrides any per-scenario `models` list.

Examples:
```bash
# Run apply_patch scenario with its default model (GPT-5)
npm run eval:smoke:run -- --scenario 06-apply-patch

# Force that scenario to use a specific model
npm run eval:smoke:run -- --scenario 06-apply-patch --model openai/gpt-4o
```

## Metrics

- **pass@k**: Probability at least 1 of k trials succeeds
- **pass^k**: Probability ALL k trials succeed (reliability)

Shows `pass@1` when trials < 3, `pass@3` otherwise.

## Adding New Scenarios

1. Create directory: `scenarios/<name>/`
2. Add `config.json`:
   ```json
   {
     "name": "Human-readable name",
     "description": "What this tests",
     "prompt": "The task prompt for Cline",
     "expectedFiles": ["file1.txt"],
     "expectedContent": [
       { "file": "file1.txt", "contains": "expected text" }
     ],
     "timeout": 60
   }
   ```
3. (Optional) Add `template/` directory with starting files

## CI Integration

There are two independent layers, with deliberately opposite contracts. Neither
one substitutes for the other.

| | PR gate | Nightly model eval |
|---|---|---|
| Workflow | `agent-conformance` in `sdk-test.yml` | `cline-evals-nightly.yml` |
| Trigger | every PR | `schedule` (03:17 UTC) + manual dispatch |
| Model | none (scripted) | live provider |
| Credential | none | `CLINE_API_KEY` |
| Measures | behavioural invariants | behavioural quality, pass@k |
| Blocks PRs | **yes** | **no** |

### PR gate — `agent-conformance`

Runs `sdk/packages/core/src/eval/agent-conformance.ts`: deterministic, offline,
no secret, no clock. Case coverage is pinned by
`sdk/packages/core/src/eval/conformance-baseline.json`, so deleting a case fails
the build instead of quietly reducing coverage. Run it locally with
`bun run test:conformance` from the repo root.

### Nightly model eval — `cline-evals-nightly`

Runs these scenarios against a live provider with 3 trials, so pass@3 is a real
number. It is intentionally **not** triggered by `pull_request` and is not a
required status check, so model and provider variability can never make a PR
flaky.

A scenario failure is recorded as **data, not a build break**: the run is
`continue-on-error`, the report is always published to the job summary and
uploaded as an artifact (90-day retention), and the job reports a warning. This
layer deliberately enforces **no pass-rate threshold** — deciding what counts as
a regression, and at what pass@k, is an open release-gate decision. Producing
comparable data every night is what makes that decision possible later.

What does still fail loudly is a nightly that cannot run at all: a missing
`CLINE_API_KEY` on the canonical repository is a hard error, because it would
otherwise look like a healthy run. On a fork the secret is unreachable, so the
run is skipped with a notice instead of failing every night.

Manual runs remain available via `cline-evals-smoke.yml` (dispatch-only) and
`workflow_dispatch` on the nightly.

### Required Secrets

- `CLINE_API_KEY` - Cline API key. Needed **only** by the two model-backed
  workflows. The deterministic PR gate needs no credentials.

### Viewing Results

- Local summaries are written under `evals/smoke-tests/results/latest/`
- Nightly runs publish a summary in the job summary and upload
  `model-eval-report-<run id>` as an artifact

## TODO

- [ ] Native tool calling tests: Add CLI support for `native_tool_call_enabled` setting, then create a scenario that tests Claude 4 with native tool calling enabled (currently only GPT-5 models automatically use native tools via the Responses API)
