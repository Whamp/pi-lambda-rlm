# pi-lambda-rlm

`lambda_rlm` is an **agent-invoked Pi tool** for bounded long-context file QA and synthesis. The Pi Agent chooses this tool when ordinary context loading is inadequate; it is **not a user command, provider, or benchmark harness**.

The MVP uses Lambda-RLM behind a Pi extension boundary. TypeScript reads source paths, resolves TOML run controls and Markdown prompt overlays, starts a Python Lambda-RLM bridge, and services each Lambda-RLM model call through a constrained child `pi -p` Formal Leaf process.

## Operator quick start

1. Install dependencies: `npm ci`
2. Verify local behavior: `npm run typecheck && npm test`
3. Verify Python bridge syntax: `python3 -m py_compile .pi/extensions/lambda-rlm/bridge.py $(find .pi/extensions/lambda-rlm/rlm -name '*.py' -type f | sort)`
4. Optional real smoke with model access: `PI_LAMBDA_RLM_LEAF_SMOKE=1 LAMBDA_RLM_LEAF_MODEL=<model> npm run test:pi-leaf-smoke`
5. In Pi, use the diagnostic command `/lambda-rlm-doctor` to check configuration, prompt overlays, Python bridge setup, Pi executable shape, and mock bridge behavior.

## Agent-facing tool input

The public contract is path-based context ingestion only:

- `contextPath` — one file path, optionally prefixed with `@`.
- `contextPaths` — an ordered array of one or more file paths for one consolidated multi-source run.
- `question` — the question or synthesis request to answer over the referenced file(s).

Pass exactly one of `contextPath` or `contextPaths`; requests that mix both fields fail validation before execution. Optional per-run parameters may only tighten resolved limits: `maxInputBytes`, `outputMaxBytes`, `outputMaxLines`, `maxModelCalls`, `wholeRunTimeoutMs`, `modelCallTimeoutMs`.

There is **no inline source or raw prompt** public contract. Inline context, raw prompt strings, and ad hoc prompt/provider inputs are rejected so source material is read internally by the tool rather than being stuffed into the parent Pi Agent context.

## Context-budget invariant

The product invariant is **Agent Context Avoidance**: the Pi Agent passes file references (`contextPath` or `contextPaths`) and a `question`; `lambda_rlm` reads the source contents internally, assembles any source manifest/source-delimited context internally, and returns only a bounded answer plus compact structured details.

This protects the parent agent context budget. Full source contents, full prompt contents, and huge traces are not returned by default.

## TOML run configuration

Run-control defaults resolve as sparse TOML overlays in this order:

1. Built-in defaults.
2. Global config: `~/.pi/lambda-rlm/config.toml`.
3. Project config: `<cwd>/.pi/lambda-rlm/config.toml`.
4. Per-run tightening from tool parameters.

Project configuration is inside the project trust boundary and may freely override global values. Per-run values may only make limits smaller or equal to resolved config; attempts to loosen fail before execution with structured validation details.

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

## Prompt overlays

Built-in prompt defaults live under `.pi/extensions/lambda-rlm/prompts/` and are private extension defaults. Operators may take ownership of individual prompt files by creating sparse Markdown overlays:

- Global overlays: `~/.pi/lambda-rlm/prompts/`
- Project overlays: `<cwd>/.pi/lambda-rlm/prompts/`

Prompt overlays use one Markdown file per prompt with the conventional tree:

```text
FORMAL-LEAF-SYSTEM-PROMPT.md
TASK-DETECTION-PROMPT.md
tasks/qa.md
tasks/summarization.md
filters/relevance.md
reducers/select-relevant.md
reducers/merge-summaries.md
```

Templates use custom placeholders such as `<<text>>`, `<<query>>`, `<<metadata>>`, `<<preview>>`, and `<<parts>>`. Unknown or missing required placeholders fail validation before execution.

Copyable examples/templates live in `.pi/extensions/lambda-rlm/prompt-templates/`; they are **manual copy only**. Runtime loading never creates overlay files and there is no generated prompt pack.

## Source manifests and bounded results

For `contextPaths`, the TypeScript tool reads each file internally in the provided order, enforces `max_input_bytes` across all files, and assembles one internal context with a source manifest plus source-delimited sections:

```text
Sources:
[1] path/to/a.txt (123 bytes)
[2] path/to/b.txt (456 bytes)

--- BEGIN SOURCE 1: path/to/a.txt ---
...
--- END SOURCE 1 ---
```

Public results include compact source metadata (`sourceNumber`, path, resolved path, bytes, chars, lines, sha256), model-call counts, run-control details, prompt source hashes, and bounded/truncation metadata. Public results do not dump full source or prompt contents by default.

## Gated real smoke tests

Real model smoke tests skip by default. Enable them only when the local Pi CLI is authenticated and model access is available:

```bash
PI_LAMBDA_RLM_LEAF_SMOKE=1 \
LAMBDA_RLM_LEAF_MODEL=google/gemini-3-flash-preview \
npm run test:pi-leaf-smoke
```

The smoke suite covers:

- one tiny real constrained child `pi -p` Formal Leaf call;
- one tiny real end-to-end QA run through `lambda_rlm`, the Python bridge, and child `pi -p`.

## Examples

Reviewable example fixtures are intentionally tiny and do not include large generated outputs:

- `examples/single-file-qa/` — one-file QA with `contextPath`.
- `examples/multi-file-qa/` — multi-file QA with `contextPaths` and source labels.
- `examples/synthesis/` — long-context synthesis with `contextPaths`.

See `docs/manual-review-checkpoint.md` for the lightweight MVP output quality checkpoint.

## MVP non-goals

The MVP intentionally does not include:

- Agentic Leaf Profiles or tool-enabled child Pi leaves.
- Skill-augmented leaves.
- Persistent workers such as a long-lived `pi --mode rpc` process.
- Parallel or batched Lambda-RLM model calls.
- A TypeScript port of Lambda-RLM.
- Direct SDK completion or Pi provider integration.
- Pi session analysis or `.jsonl`-specific parsing as an acceptance dependency.
- Automatic Python dependency installation.
- Prompt optimization automation.
- Cross-session or machine-wide process concurrency coordination.
- Exposing inline source or raw prompts as public agent-facing inputs.

## Future work

Future-work notes are preserved in `docs/future-work.md`: Agentic Leaf Profiles, persistent workers, direct SDK completion, Pi session analysis, prompt optimization, and other improvements remain possible after the Formal Leaf MVP is reviewed. They are not MVP requirements.

## Scripts

```bash
npm test                    # run Vitest behavior tests
npm run typecheck           # run TypeScript type checking without emitting files
npm run test:pi-leaf-smoke  # gated real child Pi and end-to-end QA smoke tests; skips by default
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
