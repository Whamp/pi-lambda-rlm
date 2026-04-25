# pi-lambda-rlm

`lambda_rlm` is an **agent-invoked Pi tool** for asking questions over files that are too large, too numerous, or too awkward to paste into the parent agent conversation.

Beginner version: give the Pi Agent **file path(s)** plus a **question**. The tool reads those files internally, runs vendored Lambda-RLM through a Python bridge, services Lambda-RLM model callbacks with constrained child Pi calls, and returns a bounded answer.

It is **not a user command, provider, or benchmark harness**. It is a Pi extension tool that an agent chooses when ordinary file reading would waste the parent agent context budget.

Last reviewed: 2026-04-25.

## Table of contents

- [Why this exists](#why-this-exists)
- [When to use it](#when-to-use-it)
- [Quick start](#quick-start)
- [How the tool is called](#how-the-tool-is-called)
- [Context-budget invariant](#context-budget-invariant)
- [Configuration with `config.toml`](#configuration-with-configtoml)
- [Prompt overlays](#prompt-overlays)
- [Examples](#examples)
- [What a run returns](#what-a-run-returns)
- [Project layout](#project-layout)
- [Verification](#verification)
- [Pi extension entrypoint and dogfooding](#pi-extension-entrypoint-and-dogfooding)
- [MVP non-goals](#mvp-non-goals)
- [Credits and acknowledgements](#credits-and-acknowledgements)

## Why this exists

Pi agents often need to answer questions like:

- “What changed across these long notes?”
- “Which invariant is described in this large design file?”
- “Summarize these several source documents without dumping them into chat.”

A normal agent can read files directly, but that can flood the parent agent context. `lambda_rlm` protects that context by moving the long-context work behind a tool boundary.

The tool’s job is to:

1. accept path-based input from the Pi Agent;
2. read source files internally;
3. assemble a source manifest for multi-file runs;
4. run Lambda-RLM’s recursive long-context reasoning path;
5. answer with compact visible output and structured metadata.

## When to use it

Use `lambda_rlm` when the Pi Agent needs a bounded answer from one or more UTF-8 text files and ordinary context loading is a poor fit.

Good fits:

- question answering over a large file;
- question answering over multiple related files;
- synthesis across long research notes;
- keeping source material out of the parent agent context.

Poor fits:

- tiny files where normal `read` is simpler;
- interactive user commands;
- benchmarking Lambda-RLM methods;
- provider/model integration experiments;
- arbitrary prompt execution without source files.

## Quick start

Prerequisites:

- Node.js and npm;
- Python 3 available as `python3`;
- the Pi CLI available as `pi` for real Formal Leaf calls;
- local Pi model/auth setup for gated real smoke tests.

From the repository root:

```bash
npm ci
npm run typecheck
npm test
```

Check that the Python bridge and vendored Python package parse:

```bash
python3 -m py_compile .pi/extensions/lambda-rlm/bridge.py $(find .pi/extensions/lambda-rlm/rlm -name '*.py' -type f | sort)
```

Inside Pi, run the non-mutating diagnostic command:

```text
/lambda-rlm-doctor
```

The doctor checks Python availability, vendored Lambda-RLM imports, local fork seams, TOML configuration, prompt overlays, Pi executable availability, Formal Leaf command shape, and a mock bridge run.

Optional real smoke test, only when Pi is authenticated and model access is available:

```bash
PI_LAMBDA_RLM_LEAF_SMOKE=1 \
LAMBDA_RLM_LEAF_MODEL=google/gemini-3-flash-preview \
npm run test:pi-leaf-smoke
```

## How the tool is called

Most users do not call this directly. The Pi Agent invokes `lambda_rlm` when it decides the task is a long-context file question or synthesis task.

Single-file shape:

```json
{
  "contextPath": "examples/single-file-qa/context.md",
  "question": "Which invariant protects the parent agent context budget?"
}
```

Multi-file shape:

```json
{
  "contextPaths": [
    "examples/multi-file-qa/design.md",
    "examples/multi-file-qa/ops.md"
  ],
  "question": "What should an operator remember about configuration and prompt ownership?"
}
```

Public input fields:

| Field | Required? | Meaning |
| --- | --- | --- |
| `contextPath` | yes, unless `contextPaths` is used | Path to one UTF-8 text file. A leading `@` is allowed and stripped before reading. |
| `contextPaths` | yes, unless `contextPath` is used | Ordered array of one or more UTF-8 text file paths for one consolidated run. |
| `question` | yes | The question or synthesis instruction to answer from the referenced file(s). |
| `maxInputBytes` | optional | Per-run tightening for total input bytes. |
| `outputMaxBytes` | optional | Per-run tightening for visible output bytes. |
| `outputMaxLines` | optional | Per-run tightening for visible output lines. |
| `maxModelCalls` | optional | Per-run tightening for maximum Formal Leaf model callbacks. |
| `wholeRunTimeoutMs` | optional | Per-run tightening for the whole Lambda-RLM run timeout. |
| `modelCallTimeoutMs` | optional | Per-run tightening for each child Pi model callback. |

Rules:

- Pass exactly one of `contextPath` or `contextPaths`.
- Always pass `question`.
- Optional per-run limits can only make resolved limits smaller or equal.
- There is **no inline source or raw prompt** public contract. Inline source text, raw prompt strings, and ad hoc provider inputs are rejected before execution.

## Context-budget invariant

The product invariant is **Agent Context Avoidance**.

That means the Pi Agent passes only file references and a question. `lambda_rlm` reads the source contents internally, builds the Lambda-RLM input internally, and returns only bounded output plus compact details.

For `contextPaths`, the internal context starts with a source manifest and then wraps each file in source-delimited sections:

```text
Sources:
[1] path/to/a.txt (123 bytes)
[2] path/to/b.txt (456 bytes)

--- BEGIN SOURCE 1: path/to/a.txt ---
...
--- END SOURCE 1 ---

--- BEGIN SOURCE 2: path/to/b.txt ---
...
--- END SOURCE 2 ---
```

The parent agent should not receive full source contents, full prompt bodies, or huge execution traces by default.

## Configuration with `config.toml`

Run-control defaults resolve as sparse TOML overlays in this order:

1. built-in defaults;
2. global config at `~/.pi/lambda-rlm/config.toml`;
3. project config at `<cwd>/.pi/lambda-rlm/config.toml`;
4. per-run tightening from the tool call.

Project configuration is inside the project trust boundary, so it may freely override global defaults for that project. Per-run tool parameters may only tighten the resolved values.

Minimal shape:

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

Supported `[run]` keys:

| TOML key | Meaning |
| --- | --- |
| `max_input_bytes` | Maximum total UTF-8 bytes read from all context files. |
| `output_max_bytes` | Maximum visible response bytes returned to the parent agent. |
| `output_max_lines` | Maximum visible response lines returned to the parent agent. |
| `max_model_calls` | Maximum Lambda-RLM model callback count for one run. |
| `whole_run_timeout_ms` | Whole-run timeout. |
| `model_call_timeout_ms` | Timeout for each child Pi Formal Leaf call. |
| `model_process_concurrency` | Number of child Pi model processes allowed at once in one extension instance. |

Invalid TOML, unknown tables, unknown keys, duplicate keys, and non-positive values fail before execution with structured validation details.

## Prompt overlays

Built-in prompt defaults live in:

```text
.pi/extensions/lambda-rlm/prompts/
```

Operators may override individual prompts by creating sparse Markdown overlays:

```text
~/.pi/lambda-rlm/prompts/        # global overlays
<cwd>/.pi/lambda-rlm/prompts/    # project overlays
```

Overlay files follow this tree:

```text
FORMAL-LEAF-SYSTEM-PROMPT.md
TASK-DETECTION-PROMPT.md
tasks/analysis.md
tasks/classification.md
tasks/extraction.md
tasks/general.md
tasks/qa.md
tasks/summarization.md
tasks/translation.md
filters/relevance.md
reducers/combine-analysis.md
reducers/merge-summaries.md
reducers/select-relevant.md
```

Prompt templates use strict placeholders such as `<<text>>`, `<<query>>`, `<<metadata>>`, `<<preview>>`, and `<<parts>>`. Unknown placeholders, unknown prompt files, and missing required placeholders fail validation before execution.

Copyable prompt examples live in:

```text
.pi/extensions/lambda-rlm/prompt-templates/
```

Those templates are **manual copy only**. Runtime loading never creates or mutates operator-owned prompt overlays.

## Examples

Small fixtures are included so reviewers can understand the intended tool shape without committing large generated outputs.

| Example | Use when | Files |
| --- | --- | --- |
| Single-file QA | One question over one file | `examples/single-file-qa/` |
| Multi-file QA | One question needs evidence from several files | `examples/multi-file-qa/` |
| Long-context synthesis | Several notes should be consolidated into one answer | `examples/synthesis/` |

See also `docs/manual-review-checkpoint.md` for lightweight output quality criteria: usefulness, boundedness, and clarity.

## What a run returns

A successful run returns visible text like:

```text
Run summary: Real Lambda-RLM completed; source chars=..., lines=....
Model calls: ...

<answer>
```

Structured details include compact metadata such as:

- source count, file paths, byte/character/line counts, and SHA-256 hashes;
- question length;
- model-call counts and phases;
- bridge run metadata;
- prompt source layers and prompt hashes;
- output boundedness and truncation metadata.

A failed run marks the answer as non-authoritative. Validation failures happen before execution. Runtime failures may include sanitized partial details, but the visible response should not present a partial answer as final.

## Project layout

```text
src/
  extension.ts          # Pi extension registration, tool schema, doctor command
  lambdaRlmTool.ts      # public tool validation, source loading, config/prompt resolution
  bridgeRunner.ts       # NDJSON bridge process orchestration
  leafRunner.ts         # constrained child Pi Formal Leaf calls
  configResolver.ts     # sparse TOML config overlays
  promptResolver.ts     # built-in/global/project prompt overlays
  resultFormatter.ts    # bounded visible output and structured details

.pi/extensions/lambda-rlm/
  index.ts              # project-local extension entrypoint
  bridge.py             # Python bridge into vendored Lambda-RLM
  prompts/              # built-in prompt defaults
  prompt-templates/     # copyable prompt overlay templates
  rlm/                  # vendored local/forked Lambda-RLM package

examples/               # tiny reviewable tool-call fixtures
docs/                   # smoke-test notes, future work, manual review checkpoint
tests/                  # Vitest behavior tests and gated real smoke test
```

## Verification

Common development commands:

```bash
npm test                    # run Vitest behavior tests
npm run typecheck           # run TypeScript type checking without emitting files
npm run test:pi-leaf-smoke  # gated real child Pi and end-to-end QA smoke tests; skips by default
```

Python checks:

```bash
python3 -m unittest discover -s tests/python -v
python3 -m py_compile .pi/extensions/lambda-rlm/bridge.py $(find .pi/extensions/lambda-rlm/rlm -name '*.py' -type f | sort)
```

Real smoke tests are gated because they require local Pi CLI authentication and model access:

```bash
PI_LAMBDA_RLM_LEAF_SMOKE=1 \
LAMBDA_RLM_LEAF_MODEL=google/gemini-3-flash-preview \
npm run test:pi-leaf-smoke
```

The smoke suite covers:

1. one tiny constrained child Pi Formal Leaf call;
2. one tiny end-to-end QA run through `lambda_rlm`, the Python bridge, vendored Lambda-RLM, and child Pi callbacks.

## Pi extension entrypoint and dogfooding

This repository intentionally includes a project-local Pi extension entrypoint:

```text
.pi/extensions/lambda-rlm/index.ts
```

Pi auto-discovers `.pi/extensions/*/index.ts` when a Pi coding agent starts in this repository. That means `lambda_rlm` is registered as an available tool even when it has not been installed globally.

This is intentional dogfooding. Ordinary Pi sessions in this repo exercise the same registration path that future users will hit, so schema and runtime problems show up early.

The entrypoint is not a symlink. It re-exports the source implementation:

```ts
export { default } from "../../../src/extension.js";
```

After editing extension code, reload or restart Pi so the project-local extension sees the change. Runtime assets such as `bridge.py`, `prompts/`, `prompt-templates/`, and `rlm/` live under `.pi/extensions/lambda-rlm/` as tracked files.

Important gotcha: Pi sends registered tool schemas to the active model provider before the agent can answer a prompt. An invalid `lambda_rlm` schema can therefore break unrelated requests in this repository even if the agent never calls the tool. Keep public tool parameter schemas provider-compatible: top-level object schemas only, with conditional rules enforced in runtime validation.

To bypass the dogfooded extension while debugging unrelated work, start Pi with extensions disabled or temporarily rename `.pi/extensions/lambda-rlm/`.

## MVP non-goals

The MVP intentionally does not include:

- Agentic Leaf Profiles or tool-enabled child Pi leaves;
- skill-augmented leaves;
- persistent workers such as a long-lived Pi RPC process;
- parallel or batched Lambda-RLM model calls within a run;
- a TypeScript port of Lambda-RLM;
- direct SDK completion or Pi provider integration;
- Pi session analysis or session-log-specific parsing as an acceptance dependency;
- automatic Python dependency installation;
- prompt optimization automation;
- cross-session or machine-wide process concurrency coordination;
- inline source or raw prompt public inputs.

Future-work notes are preserved in `docs/future-work.md`, including Agentic Leaf Profiles, persistent workers, direct SDK completion, Pi session analysis, prompt optimization, and related improvements.

## Credits and acknowledgements

This project is an integration layer. It does not claim credit for the underlying RLM or Lambda-RLM research.

With thanks to:

- **Original RLM repository:** [alexzhang13/rlm](https://github.com/alexzhang13/rlm), the Recursive Language Models implementation and research code by Alex L. Zhang and collaborators. The upstream repository is MIT licensed and is the source of the “normal RLM” components that Lambda-RLM builds on.
- **Lambda-RLM repository:** [lambda-calculus-LLM/lambda-RLM](https://github.com/lambda-calculus-LLM/lambda-RLM), the λ-RLM implementation for typed recursive long-context reasoning. This repository vendors a local/forked copy from commit `3874d393483dc4299101918cf8e9af670194bd88` under `.pi/extensions/lambda-rlm/rlm/`.

The vendored Lambda-RLM package is MIT licensed. Keep the upstream license notice at `.pi/extensions/lambda-rlm/rlm/LICENSE` and the local fork boundary notes at `.pi/extensions/lambda-rlm/rlm/LOCAL_FORK.md` when updating, pruning, or replacing the vendored code.

This repository adds the Pi-specific boundary: path-based tool validation, TOML run controls, prompt overlays, the Python NDJSON bridge, constrained Formal Leaf Pi callbacks, diagnostics, and bounded result formatting.
