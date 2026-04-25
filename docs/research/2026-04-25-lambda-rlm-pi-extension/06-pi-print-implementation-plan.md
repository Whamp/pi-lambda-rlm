# First-Draft Implementation Plan: Lambda-RLM via `pi -p` Leaf Calls

Date: 2026-04-25

## Goal

Build a first Pi-native Lambda-RLM integration where Lambda-RLM still owns the recursive planner/executor, but every Lambda-RLM neural call is serviced by a tightly constrained `pi -p` subprocess.

The first profile should behave as close as practical to direct completion:

- custom minimal Lambda-RLM leaf system prompt,
- no tools,
- no discovered extensions,
- no discovered skills,
- no discovered context files,
- no prompt templates,
- no persistent session,
- Pi model/auth resolution from Pi's existing model registry and `auth.json`.

This gives us a clean path to later experiment with selected skills or other Pi capabilities without rebuilding the integration around a different abstraction.

## Non-goals for this first slice

We are **not** trying to optimize latency yet. The first slice may spawn one `pi -p` process per Lambda-RLM LLM call.

We are **not** trying to make the leaf nodes agentic. The initial leaf node is intentionally model-like.

We are **not** trying to port Lambda-RLM to TypeScript.

We are **not** trying to expose arbitrary Pi tools, extensions, or project context to leaves.

We are **not** trying to auto-install Python dependencies or manage virtual environments.

## Architecture summary

```text
Pi parent session
  │
  ├─ .pi/extensions/lambda-rlm/index.ts
  │    └─ registers `lambda_rlm` tool and `/lambda-rlm-doctor`
  │
  └─ lambda_rlm tool execute(...)
       │
       ├─ validates input/config
       ├─ writes request JSON to temp file
       ├─ spawns Python bridge.py
       │    │
       │    ├─ imports local lambda-RLM
       │    ├─ creates LambdaRLM(client=PiPrintClient(...)) or equivalent backend hook
       │    ├─ runs LambdaRLM.completion(prompt)
       │    │    │
       │    │    ├─ task detection  ──────────────┐
       │    │    ├─ leaf calls      ──────────────┤
       │    │    ├─ filter calls    ──────────────┤ each calls PiPrintClient.completion(prompt)
       │    │    └─ reduce calls    ──────────────┘
       │    │                              │
       │    │                              └─ spawns constrained `pi -p` subprocess
       │    │
       │    └─ writes result JSON to temp file
       │
       └─ parses result, truncates output, returns Pi tool result
```

The key seam is a `BaseLM`-compatible Python client whose `completion(prompt)` implementation calls `pi -p`.

## First leaf profile: `pi_print_formal`

The initial leaf runner should use a command equivalent to:

```bash
pi \
  --print \
  --mode text \
  --no-session \
  --model "$LEAF_MODEL" \
  --thinking "$LEAF_THINKING" \
  --system-prompt "$LEAF_SYSTEM_PROMPT" \
  --no-tools \
  --no-extensions \
  --no-skills \
  --no-context-files \
  --no-prompt-templates \
  --offline \
  "@/tmp/pi-lambda-rlm-leaf-prompt.txt"
```

Notes:

- `--offline` disables startup network operations, not model calls. Confirm this behavior in a smoke test; remove if it interferes.
- Use an `@file` prompt rather than passing large prompts as argv strings.
- Use `--mode text` for the first proof if it returns only assistant content. If text mode includes unstable decoration, switch to `--mode json` and parse events.
- Always pass `--no-extensions` to prevent recursive loading of the Lambda-RLM extension inside child Pi processes.
- Always pass `--no-tools` initially to keep leaves non-agentic.

Minimal leaf system prompt draft:

```text
You are the bounded neural subroutine inside Lambda-RLM.
Follow the user prompt exactly.
Return only the requested result.
Do not mention Lambda-RLM unless the prompt asks you to.
Do not describe your process.
Do not ask follow-up questions.
```

## Proposed tool API

Tool name:

```text
lambda_rlm
```

First-draft parameters:

```ts
{
  prompt?: string;
  context?: string;
  contextPath?: string;
  question?: string;

  leafModel?: string;
  leafThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  leafSystemPrompt?: string;
  leafProfile?: "pi_print_formal";

  contextWindowChars?: number;
  accuracyTarget?: number;
  aLeaf?: number;
  aCompose?: number;

  timeoutSeconds?: number;
  timeoutSecondsPerLeaf?: number;
  maxLeafCalls?: number;
  maxInputChars?: number;
  verbose?: boolean;
  mock?: boolean;
}
```

Validation rules:

1. Accept exactly one of `prompt`, `context`, or `contextPath`.
2. Require `question` when using `context` or `contextPath`.
3. Normalize leading `@` in `contextPath`.
4. Require or default `leafModel` from env/flag/current parent model.
5. Enforce `maxInputChars` before starting Python.
6. Enforce `maxLeafCalls` in the Python `PiPrintClient`.
7. Enforce both whole-run timeout and per-leaf timeout.
8. Reject `leafSystemPrompt` above a configured max size.

Prompt builder for `context` / `contextPath`:

```text
Context:
{context}

Question: {question}

Answer:
```

## Configuration resolution

Resolution order:

1. Tool parameter.
2. Extension CLI flag.
3. Environment variable.
4. Parent Pi selected model where safe.
5. Hard-coded default only for non-sensitive values.

Suggested env/flags:

| Value | Flag | Env | Default |
|---|---|---|---|
| Lambda-RLM repo | `--lambda-rlm-repo` | `LAMBDA_RLM_REPO` | `${ctx.cwd}/lambda-RLM` |
| Python executable | `--lambda-rlm-python` | `LAMBDA_RLM_PYTHON` | `python3` |
| Pi executable | `--lambda-rlm-pi` | `LAMBDA_RLM_PI` | `pi` |
| Leaf model | `--lambda-rlm-leaf-model` | `LAMBDA_RLM_LEAF_MODEL` | parent `ctx.model` as `provider/id` if available |
| Leaf thinking | `--lambda-rlm-leaf-thinking` | `LAMBDA_RLM_LEAF_THINKING` | `off` |
| Context window chars | `--lambda-rlm-context-window-chars` | `LAMBDA_RLM_CONTEXT_WINDOW_CHARS` | `100000` |
| Max input chars | `--lambda-rlm-max-input-chars` | `LAMBDA_RLM_MAX_INPUT_CHARS` | `1200000` |
| Max leaf calls | `--lambda-rlm-max-leaf-calls` | `LAMBDA_RLM_MAX_LEAF_CALLS` | `20` initially |
| Whole timeout | `--lambda-rlm-timeout-seconds` | `LAMBDA_RLM_TIMEOUT_SECONDS` | `300` |
| Per-leaf timeout | `--lambda-rlm-leaf-timeout-seconds` | `LAMBDA_RLM_LEAF_TIMEOUT_SECONDS` | `120` |

No API key parameters are needed. Child `pi -p` processes use Pi's normal auth resolution, including `auth.json`.

## Python bridge design

File:

```text
.pi/extensions/lambda-rlm/bridge.py
```

Modes:

- `--doctor`: validate Python, repo import, Pi executable, and child Pi model availability.
- `--mock`: return deterministic offline data for tests.
- normal mode: run Lambda-RLM with `PiPrintClient`.

Bridge request JSON:

```json
{
  "prompt": "Context:\n...\n\nQuestion: ...\n\nAnswer:",
  "lambda_kwargs": {
    "context_window_chars": 100000,
    "accuracy_target": 0.8,
    "a_leaf": 0.95,
    "a_compose": 0.9,
    "verbose": false
  },
  "pi_print": {
    "pi_executable": "pi",
    "leaf_model": "google/gemini-3-flash-preview",
    "leaf_thinking": "off",
    "leaf_system_prompt": "...",
    "timeout_seconds_per_leaf": 120,
    "max_leaf_calls": 20,
    "mode": "text"
  }
}
```

Bridge result JSON:

```json
{
  "ok": true,
  "response": "...",
  "root_model": "pi-print:google/gemini-3-flash-preview",
  "execution_time": 12.34,
  "usage_summary": null,
  "plan": {
    "task_type": "qa",
    "compose_op": "select_relevant",
    "use_filter": true,
    "k_star": 2,
    "tau_star": 100000,
    "depth": 1,
    "cost_estimate": 100500.0,
    "n": 150000
  },
  "pi_print": {
    "call_count": 5,
    "total_process_ms": 43210,
    "leaf_model": "google/gemini-3-flash-preview",
    "leaf_thinking": "off"
  },
  "warnings": []
}
```

Errors should be structured:

```json
{
  "ok": false,
  "error": {
    "type": "TimeoutError",
    "message": "Leaf call timed out after 120s",
    "traceback": "..."
  },
  "partial": {
    "pi_print_call_count": 3
  }
}
```

## Python `PiPrintClient`

Implement a `BaseLM` subclass:

```python
class PiPrintClient(BaseLM):
    def completion(self, prompt: str | dict[str, Any]) -> str:
        self.call_count += 1
        if self.call_count > self.max_leaf_calls:
            raise RuntimeError("max_leaf_calls exceeded")

        prompt_text = normalize_prompt(prompt)
        with tempfile.NamedTemporaryFile(...) as f:
            f.write(prompt_text)
            cmd = [
                self.pi_executable,
                "--print",
                "--mode", self.output_mode,
                "--no-session",
                "--model", self.leaf_model,
                "--thinking", self.leaf_thinking,
                "--system-prompt", self.leaf_system_prompt,
                "--no-tools",
                "--no-extensions",
                "--no-skills",
                "--no-context-files",
                "--no-prompt-templates",
                f"@{f.name}",
            ]
            return run_and_capture(cmd, timeout=self.timeout_seconds_per_leaf)
```

Usage accounting:

- First slice may return unknown usage because `pi -p --mode text` does not expose provider token counts directly.
- Track operational usage instead:
  - number of Pi subprocess calls,
  - per-call duration,
  - prompt char counts,
  - response char counts.
- Future `--mode json` parsing may recover model usage if Pi emits it.

## Required Lambda-RLM adaptation

Preferred minimal adaptation:

- Add optional `client: BaseLM | None = None` to `LambdaRLM.__init__`.
- In `completion()`, use:

```python
client = self.client or get_client(self.backend, self.backend_kwargs)
```

This avoids inventing fake backend kwargs and keeps Pi-specific code in the bridge.

If we do not want to edit Lambda-RLM initially, the bridge can monkeypatch or subclass, but constructor injection is cleaner and testable.

## Extension implementation tasks

### Task 1: Document and fixture the leaf command

**Description:** Create fixtures and documentation for the exact constrained `pi -p` command shape.

**Acceptance criteria:**

- [ ] Plan documents the exact command and flags.
- [ ] A tiny shell/manual command can run a one-line leaf prompt with no tools/extensions/session.
- [ ] Recursive extension loading is prevented with `--no-extensions`.

**Verification:**

- [ ] Run `pi --help` and confirm all chosen flags exist.
- [ ] Run one manual `pi -p` smoke with a tiny prompt, if model auth is available.

**Dependencies:** None.

### Task 2: Add Python `PiPrintClient` unit tests

**Description:** Test the BaseLM-compatible client before wiring Lambda-RLM.

**Acceptance criteria:**

- [ ] Builds the expected `pi -p` command.
- [ ] Writes prompts through temp files.
- [ ] Enforces max call count.
- [ ] Enforces per-leaf timeout.
- [ ] Handles non-zero child exit with structured error.
- [ ] Supports mock runner for offline tests.

**Verification:**

- [ ] Python tests pass without calling a real model.

**Dependencies:** Task 1.

### Task 3: Add `LambdaRLM` client injection

**Description:** Add a small upstream-friendly injection point so Lambda-RLM can use `PiPrintClient` instead of `get_client(...)`.

**Acceptance criteria:**

- [ ] `LambdaRLM(..., client=client)` uses the injected client for task detection and all REPL/LMHandler calls.
- [ ] Existing behavior remains unchanged when `client` is omitted.
- [ ] Tests cover both injected and default client paths.

**Verification:**

- [ ] Python tests with fake client show task detection and leaf calls use the fake/injected client.

**Dependencies:** Task 2.

### Task 4: Build `bridge.py`

**Description:** Add the Python bridge with `--doctor`, `--mock`, and real execution modes.

**Acceptance criteria:**

- [ ] Reads request JSON from input path.
- [ ] Writes success/error JSON to output path.
- [ ] Emits progress JSONL to stderr.
- [ ] Captures Lambda plan metadata.
- [ ] Reports Pi print call counts and timings.
- [ ] Supports mock mode without model/provider calls.

**Verification:**

- [ ] `python bridge.py --mock --input fixture.json --output result.json` succeeds.
- [ ] `python bridge.py --doctor` reports actionable status.

**Dependencies:** Task 3.

### Task 5: Create project-local Pi extension skeleton

**Description:** Register `lambda_rlm` and `/lambda-rlm-doctor` in `.pi/extensions/lambda-rlm/index.ts`.

**Acceptance criteria:**

- [ ] Extension loads with `pi -e ./.pi/extensions/lambda-rlm`.
- [ ] Tool schema validates expected params.
- [ ] Doctor command spawns bridge doctor.
- [ ] No npm deps required beyond Pi-provided packages and Node built-ins.

**Verification:**

- [ ] Manual load smoke.
- [ ] Unit tests against registered tool definition if feasible.

**Dependencies:** Task 4.

### Task 6: Implement tool execution path

**Description:** Wire the TS tool to build prompts, write bridge request files, spawn Python, parse progress/results, and return a Pi tool result.

**Acceptance criteria:**

- [ ] Validates input source rules.
- [ ] Reads `contextPath` safely and normalizes leading `@`.
- [ ] Writes temp request/output files.
- [ ] Wires parent Pi `signal` to Python process kill.
- [ ] Parses progress JSONL and calls `onUpdate`.
- [ ] Parses success/error JSON.
- [ ] Truncates final output and saves full response when needed.

**Verification:**

- [ ] Tool execute works in mock mode.
- [ ] Abort test kills a mock long-running bridge.

**Dependencies:** Task 5.

### Task 7: Gated real Pi leaf smoke

**Description:** Run one real tiny Lambda-RLM call using child `pi -p` when Pi auth/model is available.

**Acceptance criteria:**

- [ ] Small prompt with `n <= contextWindowChars` returns non-empty result.
- [ ] Details include `pi_print.call_count`.
- [ ] Child Pi does not load extensions/tools/context files.
- [ ] No separate provider API key is required beyond Pi auth.

**Verification:**

- [ ] Manual/gated test command documented with output snippet.

**Dependencies:** Task 6.

## Milestones and checkpoints

### Checkpoint A: Python-only leaf runner works

After Tasks 1-4:

- [ ] `PiPrintClient` can run mock leaf calls.
- [ ] `LambdaRLM` can use an injected client.
- [ ] `bridge.py --mock` works.
- [ ] `bridge.py --doctor` is useful.

### Checkpoint B: Pi extension tool works in mock mode

After Tasks 5-6:

- [ ] Extension loads.
- [ ] `lambda_rlm` tool can execute mock bridge.
- [ ] Progress, errors, truncation, and cancellation are handled.

### Checkpoint C: Real constrained Pi leaf works

After Task 7:

- [ ] One real tiny Lambda-RLM run succeeds using child `pi -p`.
- [ ] No separate API keys were configured for Lambda-RLM.
- [ ] Results and limitations are documented.

## What we have ruled out for the first implementation

### Full TypeScript port of Lambda-RLM

Ruled out for now because it delays the first working tool and risks divergence from the Python reference. It remains a possible future optimization if the tool becomes core and Python setup/latency becomes unacceptable.

### Node/TypeScript REPL or sandbox

Ruled out because Lambda-RLM does not need arbitrary dynamic code execution. The current `_Phi` executor is deterministic. A sandbox would add complexity without helping the first integration.

### Normal/default Pi coding-agent leaves

Ruled out for the first profile. We will not let leaves inherit normal coding-agent tools, extensions, context files, or default project instructions. That would make leaves agentic and weaken Lambda-RLM's formal structure too much.

### Python provider credentials as the main path

Ruled out as the desired Pi-native path because it duplicates Pi auth setup. The first `pi -p` approach should use Pi `auth.json` instead of separate `NVIDIA_API_KEY`, `OPENAI_API_KEY`, etc. We may keep Python-provider mode only as a benchmark parity escape hatch later.

### Auto-installing Python dependencies

Ruled out for first slice. The extension should diagnose missing deps and explain setup, not mutate Python environments automatically.

### Tool-enabled leaves

Ruled out for first slice. Even allowlisted read-only tools should wait until we have baseline behavior and understand formalism/security implications.

## What we are holding off for future work

### Persistent `pi --mode rpc` leaf worker

Likely the first performance improvement after proof of concept. It should reuse the same formal profile but avoid process startup per leaf.

Open question: how to guarantee no cross-leaf context leakage in a persistent RPC worker.

### Skill-augmented leaves

Useful future experiment. Instead of relying on normal progressive skill loading with `read`, prefer first experimenting by inlining selected skill content into the leaf system prompt while keeping `--no-tools`.

Potential future profile:

```text
pi_print_skill_augmented
```

### Direct `@mariozechner/pi-ai complete(...)` leaf runner

Keep as a future implementation of the same `LeafRunner` abstraction. It will be faster and more formally clean than `pi -p`, but it does not exercise the future skill/capability path as directly.

### Token/usage accounting from child Pi

First slice tracks process calls and char counts. Later, parse `--mode json` or use Pi SDK/model responses to capture real token usage and cost.

### Batched/concurrent leaves

Hold until baseline correctness. Lambda-RLM currently runs leaf/filter calls mostly serially. Concurrency should be explicit and bounded.

### Task override

Potential future parameter to skip task detection and save one leaf call:

```ts
taskType?: "summarization" | "qa" | "translation" | "classification" | "extraction" | "analysis" | "general"
```

Hold until baseline works.

### Stronger sandboxing

Hold until needed. Initial profile runs trusted local Python and trusted Pi. If we expose tool-enabled or user-scripted leaves later, revisit sandboxing.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| `pi -p` process startup per leaf is slow | High for large inputs | Start with max leaf-call cap; later add RPC worker |
| Child Pi accidentally loads parent extension and recurses | High | Always pass `--no-extensions`; test for no recursive load |
| Leaf output includes CLI decoration in text mode | Medium | Switch to `--mode json` parser if needed |
| No token/cost usage from child Pi | Medium | Track char/process metrics first; parse JSON or direct complete later |
| Skills with `--no-tools` cannot progressively load full files | Medium for future skills | Inline selected skill content for skill-augmented mode |
| Formalism drift if future profiles add tools/skills | Medium | Make profile explicit: formal vs skill_augmented vs agentic |
| Python dependency setup friction | Medium | Add doctor command and clear setup docs; no auto-install first |
| Nested Pi auth/model mismatch | Medium | Use explicit `--model`; default from parent model only when available |

## Open questions

1. Should first child Pi output mode be `text` for simplicity or `json` for robust parsing?
2. Should `leafModel` default to the parent Pi model or be required explicitly?
3. Should `--offline` be included in child Pi invocations, or could it interfere with model/provider behavior?
4. Do we want the task-detection call to use the same `pi -p` leaf profile, or should it use a cheaper direct/direct-ish path later?
5. Should the initial max leaf-call cap be 20, 50, or configurable only via env?
6. Should we make constructor client injection in the nested `lambda-RLM` checkout, or avoid modifying it with a bridge-side subclass/monkeypatch for the first spike?

## Draft acceptance criteria for the first slice

- [ ] A user can invoke a `lambda_rlm` Pi tool on a tiny context/question.
- [ ] Lambda-RLM model calls are serviced by constrained child `pi -p` invocations.
- [ ] No separate Lambda-RLM provider API key is required; Pi auth handles model access.
- [ ] Child Pi invocations use custom Lambda-RLM system prompt and disable tools/extensions/skills/context files/prompt templates.
- [ ] The tool returns final answer text plus structured details including plan and Pi leaf-call counts.
- [ ] Output truncation follows Pi custom-tool guidance.
- [ ] Doctor/mock modes make the integration testable without real model calls.
- [ ] Known future options are documented without being built into the first slice.
