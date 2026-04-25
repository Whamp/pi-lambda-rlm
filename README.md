# pi-lambda-rlm

Pi custom tool named `lambda_rlm` for bounded long-context file QA through a real Lambda-RLM Python bridge and constrained child Pi leaf calls.

## Public tool input

The agent-facing tool accepts path-based context ingestion only:

- `contextPath` — one file path, optionally prefixed with `@`.
- `question` — the question to answer over the file.
- Optional per-run tightening only: `maxInputBytes`, `outputMaxBytes`, `outputMaxLines`, `maxModelCalls`, `wholeRunTimeoutMs`, `modelCallTimeoutMs`.

Inline/raw context and raw prompts are rejected so source material is read internally by the tool instead of being stuffed into the parent agent context.

## TOML run configuration

Run-control defaults resolve as sparse overlays in this order:

1. Built-in defaults.
2. Global config: `~/.pi/lambda-rlm/config.toml`.
3. Project config: `<cwd>/.pi/lambda-rlm/config.toml`.
4. Per-run tightening from tool parameters.

Project configuration is inside the project trust boundary and may freely override global values. Per-run values may only make limits smaller or equal to the resolved config; attempts to loosen fail before execution with structured validation details.

Minimal config shape:

```toml
[run]
max_input_bytes = 1200000
output_max_bytes = 51200
output_max_lines = 2000
max_model_calls = 1000
whole_run_timeout_ms = 300000
model_call_timeout_ms = 60000
model_process_concurrency = 2
```

Missing keys inherit from lower-precedence layers. Invalid TOML, unknown tables/keys, and invalid values fail before execution with actionable structured validation errors.

## Enforced run controls in this slice

- `max_input_bytes` is enforced after internal file stat/read and before the real bridge path starts.
- `max_model_calls` is enforced by the TypeScript bridge runner before each child Pi leaf process starts.
- `whole_run_timeout_ms` aborts the Python bridge and returns a structured runtime failure with partial details.
- `model_call_timeout_ms` aborts a stuck child Pi leaf call and returns a structured runtime failure with partial details.
- `model_process_concurrency` limits simultaneously running child Pi model processes within one loaded extension instance; extra ready model calls wait in an in-memory FIFO queue.
- Tool cancellation aborts the Python bridge and propagates an abort signal to active or queued child Pi leaf calls. Queued calls cancelled before capacity is available do not start.
- `output_max_bytes` and `output_max_lines` bound visible tool output on success and runtime failure, with optional recoverable full-output file support for tests/internal callers.

Multi-file input, metadata expansion, and prompt overlays are deferred to later issues.

## Scripts

```bash
npm test                    # run Vitest behavior tests
npm run typecheck           # run TypeScript type checking without emitting files
npm run test:pi-leaf-smoke  # gated real child Pi smoke test
```

Python verification:

```bash
python3 -m unittest discover -s tests/python -v
python3 -m py_compile .pi/extensions/lambda-rlm/bridge.py $(find .pi/extensions/lambda-rlm/rlm -name '*.py' -type f | sort)
```

## Pi extension entrypoint

The project-local Pi extension entrypoint is:

```text
.pi/extensions/lambda-rlm/index.ts
```
