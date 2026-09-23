# Selective upstream integration — 2026-09-17

## Scope and result

- Baseline: `f35414c0a84d20addec4e9961865724cf82e09a8`.
- Fetched upstream/main: `ad521395f2ee4150d8eadd04a5861dea4797952c`.
- Backup reference: `backup/selective-upstream-20260917`.
- Integrated upstream `0bcd602150d6a9709be89c73d9ebca8da60e5cb3` as `64012a65b`, with a follow-up local architecture adaptation.
- This is a partial integration, not a merge of all upstream fixes.

## Integrated behavior

The authoritative initial task message now includes supplied images/files. Explicit New Task (also used by the task close button) clears the local optimistic user message before awaiting the clearTask RPC. Tests cover attachment propagation, absence of empty attachment fields, and optimistic-message cleanup.

The upstream fix referenced `setPendingResponse`, which does not exist in this fork. The adaptation removes that reference and its test assertion instead of resurrecting the removed upstream loading-state architecture. The existing TurnState and MessagesStateContext paths remain unchanged.

## Deferred/excluded commits

- `721d18548`: subagent concurrency performance/correctness improvement; deferred. Trial cherry-pick was aborted; no SDK concurrency changes retained.
- `2ce4facd9`: immediate thinking UI; deferred because it conflicts with the local ChatView/MessagesArea architecture and modifies deleted loading hooks. Trial cherry-pick was aborted.
- `16d0d0457`, `f4230e475`: history-resume feedback and compaction UX; reviewed but not integrated in this batch.
- `7f75100da`: recommended-model client identity/request-contract expansion; excluded from this narrow batch.
- `ad521395f`: desktop release bookkeeping; excluded.
- No new features, release version changes, or upstream changeset files were integrated.

## Validation

- `bun run package`: completed, including extension/webview type checks, compatibility type checks, webview production build, TypeScript lint and extension bundle.
- Important limitation: the existing protobuf lint script reports missing `buf` but exits successfully. Protobuf lint is therefore NOT validated. No proto source was changed.
- Targeted backend Vitest suites (task start, task control, followup): 39 passed, 0 failed.
- Targeted webview Vitest suites (message handlers, replica reducer): 31 passed, 0 failed.
- Biome check of the four changed source/test files: passed.
- `git diff --check`: passed.
- An earlier full-webview run did not produce reliable captured completion evidence; it is not counted as passed.

## Outstanding acceptance criteria

Real-host regression of completion -> direct followup without clicking New Task, queue/steer, and task close remains unverified. The previous investigation's replica/epoch and snapshot-race findings are not fixed by this batch. No claim is made that the original extension freeze is resolved, or that all functionality has passed end-to-end acceptance.
