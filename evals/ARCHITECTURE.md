# Cline Evals Architecture

> Note: Smoke tests (Layer 2) run in CI again. The eval framework is now wired at the SDK CLI (`bun run build:sdk` then `bun -F @cline/cli build`, linked onto `PATH`). `cline-evals-nightly.yml` runs the scenarios nightly against a live provider and reports pass@3; it does not gate PRs, and it enforces no pass-rate threshold yet. The deterministic behavioural gate is the separate offline `agent-conformance` job in `sdk-test.yml`. See `evals/smoke-tests/README.md`.

## Overview

The evals system provides multi-layered testing for Cline's AI capabilities.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TESTING PYRAMID                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────┐                                    │
│                             /   E2E    \         Layer 3: Full Agent        │
│                            /  cline-   \         - Real coding tasks        │
│                           /   bench     \        - Harbor execution         │
│                          /_______________\       - Nightly runs             │
│                                                                             │
│                        ┌───────────────────┐                                │
│                       /    Smoke Tests     \     Layer 2: Provider          │
│                      /   run-smoke-tests    \    - 8 curated scenarios      │
│                     /    (cline provider)    \   - 3 models via Vercel      │
│                    /_________________________\   - pass@k metrics           │
│                                                                             │
│              ┌─────────────────────────────────┐                            │
│             /        Contract Tests            \  Layer 1: Unit             │
│            /   thinking-traces.test.ts          \ - No LLM calls            │
│           /    tool-parsing.test.ts              \ - Fast, deterministic    │
│          /______________________________________ \ - API format validation  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
evals/
├── ARCHITECTURE.md          # This file
├── README.md                # Quick start guide
│
├── analysis/                # Shared metrics & reporting
│   └── src/
│       ├── metrics.ts       # pass@k, pass^k, flakiness calculations
│       └── cli.ts           # Analysis CLI
│
├── smoke-tests/             # Layer 2: Provider smoke tests
│   ├── run-smoke-tests.ts   # Main runner
│   ├── README.md            # Usage docs
│   ├── scenarios/           # Test definitions
│   │   ├── 01-create-file/
│   │   │   ├── config.json  # Prompt, expected files/content
│   │   │   ├── template/    # Initial files (if any)
│   │   │   └── workspace/   # Working dir (cleaned each run)
│   │   ├── 02-edit-file/
│   │   ├── 03-read-summarize/
│   │   ├── 04-multi-file/
│   │   └── 05-typescript-function/
│   └── results/             # Generated outputs
│       ├── latest -> 2026-01-27T.../  # Symlink to most recent
│       └── 2026-01-27T19-50-54-391Z/
│           ├── report.json  # Full results
│           ├── summary.md   # CI-friendly markdown
│           └── 01-create-file/
│               └── claude-sonnet/
│                   ├── trial-1.log           # CLI stdout/stderr
│                   └── workspace-trial-1/    # Kept for failures only
│
├── e2e/                     # Layer 3: Full agent E2E
│   ├── run-cline-bench.ts   # Harbor runner
│   └── README.md
│
└── cline-bench/             # Git submodule with real coding tasks
    └── tasks/               # SWE-bench style problems
```

## Smoke Test Workflow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         SMOKE TEST EXECUTION FLOW                            │
└──────────────────────────────────────────────────────────────────────────────┘

 npm run eval:smoke:run
        │
        ▼
┌───────────────────┐
│ Load scenarios    │  Read config.json from each scenarios/* dir
│ from disk         │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Create results    │  evals/smoke-tests/results/2026-01-27T.../
│ directory         │
└────────┬──────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────┐
│                    FOR EACH SCENARIO                          │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                  FOR EACH MODEL                         │  │
│  │  ┌───────────────────────────────────────────────────┐  │  │
│  │  │           RUN 3 TRIALS SEQUENTIALLY               │  │  │
│  │  │                                                   │  │  │
│  │  │  Trial 1 ──► Trial 2 ──► Trial 3 ──► Results      │  │  │
│  │  │  (Sequential - Cline instance handles one at a time)  │  │
│  │  │                                                   │  │  │
│  │  │  Each trial:                                      │  │  │
│  │  │  1. Create workspace-trial-N/                     │  │  │
│  │  │  2. Copy template files (if any)                  │  │  │
│  │  │  3. Run: cline -y -o "prompt"                     │  │  │
│  │  │  4. Verify expected files exist                   │  │  │
│  │  │  5. Verify expected content                       │  │  │
│  │  │  6. Save trial-N.log                              │  │  │
│  │  │  7. If failed, copy workspace to results/         │  │  │
│  │  └───────────────────────────────────────────────────┘  │  │
│  │                         │                               │  │
│  │                         ▼                               │  │
│  │  ┌───────────────────────────────────────────────────┐  │  │
│  │  │ Calculate metrics: pass@1, pass@3, pass^3, flaky  │  │  │
│  │  └───────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────┐
│ Generate outputs  │
│ - report.json     │
│ - summary.md      │
│ - latest symlink  │
└───────────────────┘
```

## Models Tested

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLINE PROVIDER ROUTING                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────┐                                               │
│   │ Smoke Test  │                                               │
│   │   Runner    │                                               │
│   └──────┬──────┘                                               │
│          │                                                      │
│          │  cline -y -o "prompt" --model <model>                │
│          │                                                      │
│          ▼                                                      │
│   ┌─────────────┐                                               │
│   │   Cline     │                                               │
│   │  Provider   │ ◄─── Uses your Cline auth (cline auth)        │
│   └──────┬──────┘                                               │
│          │                                                      │
│          │ Routes to backend                                    │
│          ▼                                                      │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   Default Models                        │   │
│   ├─────────────────────────────────────────────────────────┤   │
│   │  claude-sonnet-4-20250514                               │   │
│   │  gpt-4o                                                 │   │
│   │  gemini-2.5-pro-preview-06-05                           │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Metrics Explained

```
┌─────────────────────────────────────────────────────────────────┐
│                        METRICS                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  pass@k   "What's the probability of getting at least one      │
│            success if I run k trials?"                          │
│                                                                 │
│            Example: 2/3 trials pass → pass@3 ≈ 96%              │
│            (Very likely to pass if you run 3 times)             │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  pass^k   "What's the probability of ALL k trials succeeding?" │
│                                                                 │
│            Example: 2/3 trials pass → pass^3 ≈ 30%              │
│            (Only 30% chance all 3 would pass)                   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Status   PASS  = All trials passed                             │
│           FLAKY = Some passed, some failed                      │
│           FAIL  = All trials failed                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Commands

```bash
# Run all smoke tests (all models, 3 trials each)
npm run eval:smoke:run

# Run single model (use exact model ID for reproducibility)
npm run eval:smoke:run -- --model claude-sonnet-4-20250514

# Run single scenario
npm run eval:smoke:run -- --scenario 01-create-file

# Quick check (1 trial)
npm run eval:smoke:run -- --trials 1

# View latest results
cat evals/smoke-tests/results/latest/summary.md

# Debug a failure
cat evals/smoke-tests/results/latest/<scenario>/<model>/trial-1.log
ls evals/smoke-tests/results/latest/<scenario>/<model>/workspace-trial-1/
```

## CI Integration

Two layers with opposite contracts. The model-backed layer runs nightly against a
live provider; the deterministic behavioural invariants that gate PRs are a
separate offline suite. See `evals/smoke-tests/README.md` for the full table.

| | PR gate | Nightly model eval |
|---|---|---|
| Workflow | `agent-conformance` in `sdk-test.yml` | `cline-evals-nightly.yml` |
| Model | none (scripted) | live provider, 3 trials (pass@3) |
| Secret | none | `CLINE_API_KEY` |
| Blocks PRs | yes | no |

The nightly does not enforce a pass-rate threshold; what counts as a regression
is an open release-gate decision.

### Required Secrets

- `CLINE_API_KEY` — needed only by the model-backed workflows. A missing secret on
  the canonical repository fails the nightly; on a fork it is skipped.

### Viewing CI Results

1. **Job Summary**: Each run posts results to the Actions tab
2. **Artifacts**: Full results downloadable as `model-eval-report-<run_id>`
   (90-day retention)

### Running CI-like Tests Locally

```bash
# Use an installed or locally linked cline binary
npx tsx evals/smoke-tests/run-smoke-tests.ts --trials 1
```

### Re-enabling CI

The old workflow built the legacy CLI from `cli/`. Re-enable it only after replacing that build step with the SDK CLI under `apps/cli`.

## Contract Tests (Layer 1)

> **Note**: The old `evals/benchmarks/tool-precision/` tests have been removed. Their functionality is now covered by contract tests in `src/core/**/__tests__/` and the 52 system prompt snapshot tests that run with `npm run test:unit`.

Located in `src/core/api/transform/__tests__/`:

```
thinking-traces.test.ts
├── convertToOpenAiMessages preserves reasoning_details
├── convertToAnthropicMessage preserves thinking blocks
└── sanitizeGeminiMessages handles provider-specific cleaning

tool-parsing.test.ts
├── Anthropic tool_use → OpenAI tool_calls conversion
├── Tool call ID truncation (>40 chars)
├── OpenAI Responses API ID transformation
└── Tool result matching
```

Run with:
```bash
npm run test:unit -- --grep "Thinking Trace"  # 9 tests
npm run test:unit -- --grep "Tool Call"       # 11 tests
```
