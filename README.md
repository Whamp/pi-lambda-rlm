# pi-lambda-rlm

`lambda_rlm` is an **agent-invoked Pi tool** for asking questions over files that are too large, too numerous, or too awkward to paste into the parent agent conversation.

Beginner version: install the Pi package, restart or `/reload` Pi so extension load creates the **Lambda-RLM User Workspace** at `~/.pi/lambda-rlm/`, run interactive `/lambda-rlm-doctor` to validate setup and optionally enter a Formal Leaf model after diagnostics, then ask Pi a question that references one or more file paths. Manual `[leaf].model` TOML editing remains the fallback for non-interactive or diagnostic-only contexts. The agent decides when calling `lambda_rlm` is better than reading those files directly.

It is **not a provider or benchmark harness**. It is also not something most users call by hand. It is a Pi extension tool that protects the parent agent context budget by doing long-context file work behind a tool boundary.

Last reviewed: 2026-04-25.

## Quick start for users

### 1. Install the Pi package

From a local checkout:

```bash
pi install /absolute/path/to/pi-lambda-rlm
```

From a git source:

```bash
pi install git:github.com/Whamp/pi-lambda-rlm
```

By default, `pi install` writes to global Pi settings at `~/.pi/agent/settings.json`, so the extension is available in all Pi sessions. Use `pi install -l ...` only if you want a project-local install.

After installing, start a new Pi session or run:

```text
/reload
```

### 2. Inspect the Lambda-RLM User Workspace

When the extension loads after install, Workspace Scaffolding creates `~/.pi/lambda-rlm/` if it is missing and shows a one-time Scaffold Notification. The scaffold is non-destructive: existing `config.toml`, `README.md`, Copied Example Fixtures, and prompt overlays are never overwritten.

The generated `config.toml` is a Transparent Sparse Config Scaffold. It is valid TOML before model setup, keeps the Formal Leaf model commented so no billable model is auto-selected, and documents Run Control Policy defaults as comments instead of active copied overrides:

```toml
[leaf]
# Add a Formal Leaf model manually before real Lambda-RLM runs.
# Use a model accepted by Pi, for example: model = "<provider>/<model-id>"
# model = "<provider>/<model-id>"
thinking = "off"
pi_executable = "pi"

[run]
# Built-in Run Control Policy defaults are documented here as comments.
# Uncomment only values you intentionally want to override.
# max_input_bytes = 1200000
# output_max_bytes = 51200
# output_max_lines = 2000
# max_model_calls = 1000
# whole_run_timeout_ms = 300000
# model_call_timeout_ms = 60000
# model_process_concurrency = 2
```

### 3. Configure the Formal Leaf model

`lambda_rlm` services Lambda-RLM model callbacks by spawning constrained child Pi processes. Those child calls need an explicit Pi model. In interactive Pi sessions, run `/lambda-rlm-doctor`: after diagnostics, its Doctor Repair Flow can offer Formal Leaf Model Selection and prompt for a manual `provider/model-id` value.

Write target behavior follows config precedence. If no distinct project `.pi/lambda-rlm/config.toml` exists, Formal Leaf Model Selection writes the global config at `~/.pi/lambda-rlm/config.toml` without asking for a target. If a project config exists, doctor prompts for Global Tool Configuration versus Project Tool Configuration. The highlighted default matches the effective owner of `[leaf].model`: project-local is highlighted when project config owns the effective model, otherwise global is highlighted while project-local remains available.

Manual editing remains the fallback for non-interactive or diagnostic-only contexts. Add `[leaf].model` to the effective config file doctor reports, or to `~/.pi/lambda-rlm/config.toml` for global setup, using a model that already works in Pi:

```toml
[leaf]
model = "<provider>/<model-id>"
```

Useful ways to find a working model:

```bash
pi --list-models
```

or open `/model` inside Pi.

### 4. Make sure Pi can authenticate that model

For built-in cloud providers, use `/login` in Pi or set the provider API key. Pi stores credentials in `~/.pi/agent/auth.json`.

For local or proxy providers such as Ollama, vLLM, LM Studio, or a custom OpenAI-compatible endpoint, add the provider/model to `~/.pi/agent/models.json`, then use that provider/model in `[leaf].model`.

Example local provider shape:

```json
{
  "providers": {
    "local-vllm": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "local-key",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen3-coder" }
      ]
    }
  }
}
```

Then use:

```toml
[leaf]
model = "local-vllm/qwen3-coder"
```

### 5. Run the doctor

Inside Pi:

```text
/lambda-rlm-doctor
```

The doctor defensively reruns Workspace Scaffolding to restore missing onboarding files without overwriting user-owned files, then checks:

- Python availability;
- vendored Lambda-RLM importability and local fork seams;
- `~/.pi/lambda-rlm/config.toml` and project `.pi/lambda-rlm/config.toml` syntax;
- required `[leaf].model` setup;
- Pi executable availability;
- Formal Leaf command shape;
- prompt overlays;
- a deterministic mock bridge run that does not spend model credits.

In interactive sessions, the doctor shows a post-diagnostics action menu. Formal Leaf Model Selection can prompt for a manual model pattern and update the selected config after diagnostics. With no project config, it defaults to the global config without asking. When project config exists, it asks for a write target and highlights project-local when that project config owns the effective model. If the doctor reports invalid TOML/configuration, it reports code/field/source/path details before offering repair choices. The safe default is cancel, which leaves the file unchanged. If you explicitly confirm, doctor can create a backup and replace the exact invalid config file with a normalized scaffold; non-interactive Diagnostic-Only Doctor Mode never rewrites config. The model action remains blocked while config is invalid. If the doctor reports a `leaf_model` error, use the model action or manually fix `[leaf].model`, Pi credentials, or `~/.pi/agent/models.json`, then rerun it.

### 6. Use it naturally

Ask Pi questions like:

```text
What changed across docs/research/a.md and docs/research/b.md? Use lambda_rlm if reading both files would waste context.
```

or:

```text
Answer this from @large-notes.md without pasting the whole file into our conversation.
```

The agent should call `lambda_rlm` with paths and a question when it needs bounded long-context file reasoning.

## What gets installed

This package declares itself as a Pi package with this extension entrypoint:

```text
.pi/extensions/lambda-rlm/index.ts
```

Runtime assets are included under:

```text
.pi/extensions/lambda-rlm/
  bridge.py
  prompts/
  prompt-templates/
  rlm/
```

The extension registers:

- the `lambda_rlm` tool, available to the agent;
- the `/lambda-rlm-doctor` command, available to you.

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

## Configuration reference

Configuration resolves as sparse overlays in this order:

1. built-in defaults;
2. global config at `~/.pi/lambda-rlm/config.toml`;
3. project config at `<cwd>/.pi/lambda-rlm/config.toml`;
4. per-run tightening from the tool call for supported `[run]` limits only.

Project configuration is inside the project trust boundary, so it may override global defaults for that project. When `cwd` is the home directory and the global and project paths are the same `~/.pi/lambda-rlm/config.toml`, that file is treated as Global Tool Configuration only.

### `[leaf]` keys

`[leaf].model` is the important user setup step.

| TOML key | Required? | Meaning |
| --- | --- | --- |
| `model` | yes for real installed use | Pi model pattern passed to child `pi --model`, normally `<provider>/<model-id>`. |
| `thinking` | optional | Child Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Default: `off`. |
| `pi_executable` | optional | Pi executable for child calls. Default: `pi`. |

For development smoke tests, use the same config path. If you want smoke tests to use a different model than your global setup, create a project-local `.pi/lambda-rlm/config.toml` with its own `[leaf].model`.

### `[run]` keys

| TOML key | Meaning |
| --- | --- |
| `max_input_bytes` | Maximum total UTF-8 bytes read from all context files. |
| `output_max_bytes` | Maximum visible response bytes returned to the parent agent. |
| `output_max_lines` | Maximum visible response lines returned to the parent agent. |
| `max_model_calls` | Maximum Lambda-RLM model callback count for one run. |
| `whole_run_timeout_ms` | Whole-run timeout. |
| `model_call_timeout_ms` | Timeout for each child Pi Formal Leaf call. |
| `model_process_concurrency` | Number of child Pi model processes allowed at once in one extension instance. |

Invalid TOML, unknown tables, unknown keys, duplicate keys, non-positive `[run]` values, and invalid `[leaf]` values fail before execution with structured validation details.

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

## Troubleshooting

### `/lambda-rlm-doctor` says `leaf_model` is missing

Create or update `~/.pi/lambda-rlm/config.toml`:

```toml
[leaf]
model = "<provider>/<model-id>"
```

Use a model shown by `/model` or `pi --list-models`.

### The model exists but doctor says credentials are missing

Authenticate the provider with `/login`, an environment variable, or `~/.pi/agent/auth.json`.

### A local model is not found

Add it to `~/.pi/agent/models.json`, confirm `pi --model provider/model-id "hello"` works, then rerun `/lambda-rlm-doctor`.

### Runs time out or spawn too many child processes

Lower or raise these values in `~/.pi/lambda-rlm/config.toml` or project `.pi/lambda-rlm/config.toml`:

```toml
[run]
model_call_timeout_ms = 60000
whole_run_timeout_ms = 300000
model_process_concurrency = 2
```

## Examples

Small fixtures are included so users can see intended tool-call shapes without committing large generated outputs.

| Example | Use when | Files |
| --- | --- | --- |
| Single-file QA | One question over one file | `examples/single-file-qa/` |
| Multi-file QA | One question needs evidence from several files | `examples/multi-file-qa/` |
| Long-context synthesis | Several notes should be consolidated into one answer | `examples/synthesis/` |

See also `docs/manual-review-checkpoint.md` for lightweight output quality criteria: usefulness, boundedness, and clarity.

## Development notes

Most users can ignore this section.

From a checkout:

```bash
npm ci
npm test
npm run typecheck
python3 -m py_compile .pi/extensions/lambda-rlm/bridge.py $(find .pi/extensions/lambda-rlm/rlm -name '*.py' -type f | sort)
```

Real smoke tests require a working Pi model in `~/.pi/lambda-rlm/config.toml` or project `.pi/lambda-rlm/config.toml`:

```toml
[leaf]
model = "<provider>/<model-id>"
```

Then run:

```bash
npm run test:pi-leaf-smoke
```

This repository also includes a project-local dogfooding entrypoint at `.pi/extensions/lambda-rlm/index.ts`. When Pi starts in this checkout, that entrypoint registers `lambda_rlm` even before a global install. After editing extension code, run `/reload` or restart Pi.

Important gotcha: Pi sends registered tool schemas to the active model provider before the agent can answer a prompt. An invalid `lambda_rlm` schema can therefore break unrelated requests in this repository even if the agent never calls the tool. Keep public tool parameter schemas provider-compatible: top-level object schemas only, with conditional rules enforced in runtime validation.

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
