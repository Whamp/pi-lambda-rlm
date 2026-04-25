# Lambda-RLM as a Pi Extension Tool — Research Synthesis

Date: 2026-04-25  
Repository: `/home/will/projects/pi-lambda-rlm`

## Research artifacts

This synthesis combines four parallel research tracks:

1. [`01-pi-extension-tools.md`](./01-pi-extension-tools.md) — Pi extension/tool API, packaging, execution, truncation, and testing.
2. [`02-lambda-rlm-python-internals.md`](./02-lambda-rlm-python-internals.md) — Lambda-RLM Python architecture, data flow, clients, REPL bridge, and failure modes.
3. [`03-integration-options-python-vs-typescript.md`](./03-integration-options-python-vs-typescript.md) — Python subprocess/worker vs TypeScript port vs hybrid options, including JS/TS REPL considerations.
4. [`04-proposed-extension-surface-and-plan.md`](./04-proposed-extension-surface-and-plan.md) — Candidate Pi tool surface, bridge design, progress/details shape, and vertical-slice plan.
5. [`05-pi-leaf-agent-option-addendum.md`](./05-pi-leaf-agent-option-addendum.md) — Correction/addendum covering constrained Pi leaf agents, `pi --help` CLI controls, and Pi `auth.json` integration.
6. [`06-pi-print-implementation-plan.md`](./06-pi-print-implementation-plan.md) — First-draft implementation plan for the constrained `pi -p` leaf-call approach.

Primary source files and docs inspected:

- Pi docs:
  - `/home/will/.local/share/mise/installs/node/25.2.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
  - `/home/will/.local/share/mise/installs/node/25.2.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
  - `/home/will/.local/share/mise/installs/node/25.2.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`
- Pi examples:
  - `examples/extensions/hello.ts`
  - `examples/extensions/truncated-tool.ts`
  - `examples/extensions/with-deps/`
  - `examples/extensions/qna.ts`
  - `examples/extensions/handoff.ts`
  - `examples/extensions/summarize.ts`
- Lambda-RLM source:
  - `lambda-RLM/README.md`
  - `lambda-RLM/pyproject.toml`
  - `lambda-RLM/rlm/lambda_rlm.py`
  - `lambda-RLM/rlm/environments/local_repl.py`
  - `lambda-RLM/rlm/core/lm_handler.py`
  - `lambda-RLM/rlm/core/types.py`
  - `lambda-RLM/rlm/clients/*.py`
  - `lambda-RLM/benchmarks/benchmark.py`

## Executive recommendation

Build this in phases:

1. **First slice:** project-local Pi extension tool backed by a small Python CLI/JSON bridge.
2. **Second slice:** persistent Python worker if repeated use or startup latency matters.
3. **Third slice:** hybrid Python worker with a Pi-native leaf-call bridge so Lambda-RLM can use Pi’s currently selected model and auth.
4. **Only later:** TypeScript port of the deterministic Lambda-RLM planner/executor if the tool proves valuable and Python setup becomes a real adoption or latency blocker.

Do **not** start by converting all of `lambda-RLM/` to TypeScript. Also do **not** spend time building a TypeScript/JavaScript REPL for Lambda-RLM. The current Lambda-RLM algorithm does not need arbitrary dynamic code execution; its recursive executor can be ordinary deterministic functions once ported.

Best immediate name and placement:

```text
.pi/extensions/lambda-rlm/
  index.ts
  bridge.py
  README.md
```

Tool name:

```text
lambda_rlm
```

## Why this should be a Pi extension tool, not a provider yet

Pi extensions can register custom tools with `pi.registerTool()`. A custom tool is right when Lambda-RLM is an auxiliary workflow: “run this long-context recursive reasoning method over this prompt/context and return a result.”

A Pi custom provider would be right only if Lambda-RLM should appear in `/model` as the primary chat model. That is not the first goal. Lambda-RLM internally makes many model calls and has its own planner/executor; exposing it as a tool keeps the semantics clear and avoids confusing it with a normal chat-completion provider.

## Key Pi extension findings

A Pi tool is a TypeScript extension loaded from project or global extension paths. The extension exports a default function receiving `ExtensionAPI`, then registers a tool:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lambda_rlm",
    label: "λ-RLM",
    description: "Run Lambda-RLM deterministic recursive long-context reasoning.",
    parameters: Type.Object({ /* ... */ }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // implement tool
      return { content: [{ type: "text", text: "..." }], details: {} };
    },
  });
}
```

Important implementation constraints:

- Use TypeBox schemas for parameters.
- Use `StringEnum()` from `@mariozechner/pi-ai` for string enums.
- Throw errors from `execute()` to make Pi mark tool results as failed.
- Pass `signal` into `fetch`, child processes, worker calls, or direct Pi model calls.
- Use `onUpdate` for progress; Lambda-RLM runs may be long.
- Truncate all large outputs before returning them to the LLM context.
- Save full output to a temp file when truncated.
- Avoid raw API keys as tool parameters; prefer env var names or Pi auth retrieval.
- Pi executes sibling tool calls in parallel by default, so the first slice should either serialize `lambda_rlm` calls or clearly bound concurrency.

Pi can also call the currently selected model directly inside an extension via `complete(...)` from `@mariozechner/pi-ai`, using `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!)`. This is important for the long-term hybrid design.

## Key Lambda-RLM findings

`LambdaRLM.completion(prompt)` currently does this:

1. Validates `prompt` is a string.
2. Parses benchmark-style prompts shaped as:
   ```text
   Context:
   ...

   Question: ...

   Answer:
   ```
3. Extracts `context_text` and `effective_query`.
4. Builds a Python provider client with `get_client(backend, backend_kwargs)`.
5. Starts `LMHandler`, a localhost socket bridge for REPL-originating LLM calls.
6. Creates `LocalREPL` and stores context as `context_0`.
7. Makes one task-detection LLM call.
8. Computes a deterministic `LambdaPlan`.
9. Registers fixed combinators:
   - `_Split`
   - `_Peek`
   - `_Reduce`
   - `_FilterRelevant`
10. Builds and executes deterministic Python `_Phi(P)` code.
11. Returns `RLMChatCompletion` with response, usage summary, and execution time.

The core Lambda-RLM value is the fixed recursive pipeline:

```text
Split → optional Filter → Map(Φ) → Reduce
```

It replaces normal RLM’s open-ended LLM-generated REPL loop with deterministic control flow.

Reusable pieces:

- Task and compose enums.
- Task detection prompt and parser.
- Planning formulas.
- Split/filter/reduce semantics.
- `RLMChatCompletion` and usage result shapes.
- Provider client interface if using Python providers.

Risky or missing pieces:

- `LocalREPL` is not a strong sandbox. It still exposes host Python capabilities such as import/open.
- Lambda-RLM always instantiates `LocalREPL`; the `environment` argument is misleading.
- Current planning is character-based, not token-aware.
- There is no built-in Lambda-RLM cancellation, timeout, retry, max-call, or budget guard.
- Leaf/filter/reduce calls are mostly serial.
- The computed `LambdaPlan` is not exposed in `RLMChatCompletion.metadata` today.
- Provider config is separate from Pi’s model/auth system.

## TypeScript conversion decision

### Do not port first

A full TypeScript port is attractive long-term but expensive now. It would require:

- Porting planning/math exactly.
- Porting split/filter/reduce behavior.
- Replacing Python clients with Pi model calls.
- Adding parity tests against Python.
- Rebuilding usage aggregation and error semantics.
- Deciding how much to intentionally improve vs preserve from the reference implementation.

That is too much before we know whether the Pi tool is valuable.

### Do port later if these become true

Consider a TypeScript port if:

- Python environment setup is the main blocker.
- The tool becomes core to Pi workflows.
- We need low latency and tight cancellation/concurrency.
- The Lambda-RLM algorithm stabilizes enough for parity tests to stay cheap.
- We want first-class use of Pi’s selected model without a Python bridge.

### If porting, do not port the REPL

A TypeScript port should implement Lambda-RLM as plain async functions:

```ts
async function phi(text: string): Promise<string> {
  if (text.length <= plan.tauStar) {
    return leafModel.complete(formatLeafPrompt(text));
  }

  let chunks = split(text, plan.kStar);
  if (plan.pipeline.useFilter && query) {
    chunks = await filterRelevant(query, chunks, leafModel);
  }

  const parts = await mapWithConcurrencyLimit(chunks, concurrency, phi);
  return reduce(parts, plan.composeOp, leafModel, query);
}
```

No Node `vm`, no `vm2`, no arbitrary TS/JS REPL is needed.

## Integration options compared

| Option | First-tool speed | Pi current model support | Runtime complexity | Safety | Latency | Recommendation |
|---|---:|---:|---:|---:|---:|---|
| Direct Python subprocess | Excellent | Weak | Medium | Medium | Poor | Too ad hoc except for quick experiments |
| Python CLI/JSON bridge | Good | Weak initially | Medium-low | Medium | Poor per call | **Best first slice** |
| Persistent Python worker | Medium | Weak unless bridged | Medium-high | Medium | Good | Best second slice |
| Hybrid worker + Pi leaf calls | Medium | Excellent | High | Good | Good | Best production target |
| Full TypeScript port | Slow | Excellent | Low after built | Best | Best | Long-term only |
| JS/TS REPL/sandbox | Slow | Mixed | High | Mixed | Mixed | Avoid for Lambda-RLM |

## Proposed first tool surface

Tool name:

```text
lambda_rlm
```

Primary use cases:

- Long-context QA over a file or inline context.
- Long-context summarization.
- Extraction or analysis where the user explicitly wants Lambda-RLM.
- Research/benchmark-style comparisons.

Suggested inputs:

```ts
{
  prompt?: string;
  context?: string;
  contextPath?: string;
  question?: string;

  backend?: "openai" | "vllm" | "portkey" | "openrouter" | "vercel" | "litellm" | "anthropic" | "azure_openai" | "gemini";
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;

  contextWindowChars?: number;
  accuracyTarget?: number;
  aLeaf?: number;
  aCompose?: number;

  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream?: boolean;
  timeoutSeconds?: number;
  verbose?: boolean;
}
```

Validation rules:

1. Accept exactly one of `prompt`, `context`, or `contextPath`.
2. Require `question` when using `context` or `contextPath`.
3. Normalize leading `@` in `contextPath`.
4. Resolve model/backend/base URL/API-key env from params, extension flags, env vars, then defaults.
5. Do not accept raw API keys as tool params.
6. Enforce max input chars before spawning Python.
7. Enforce timeout and cancellation at the process level.

Prompt construction when using context/question:

```text
Context:
{context}

Question: {question}

Answer:
```

This matches the existing `LambdaRLM.completion()` parser.

## Proposed result shape

Visible `content` should contain:

- The final Lambda-RLM answer.
- A short run summary.
- A truncation notice if needed.

Structured `details` should include:

```ts
{
  ok: true,
  input: {
    source: "prompt" | "inline_context" | "file",
    contextPath?: string,
    promptChars: number,
    contextChars?: number,
    questionChars?: number
  },
  config: {
    repoPath: string,
    pythonPath: string,
    backend: string,
    model: string,
    baseUrl?: string,
    apiKeyEnv?: string,
    apiKeyPresent?: boolean,
    contextWindowChars: number,
    accuracyTarget: number,
    aLeaf: number,
    aCompose: number,
    timeoutSeconds: number
  },
  lambdaRlm: {
    rootModel: string,
    executionTimeSeconds: number,
    usageSummary?: unknown,
    plan?: {
      taskType: string,
      composeOp: string,
      useFilter: boolean,
      kStar: number,
      tauStar: number,
      depth: number,
      costEstimate: number,
      n: number
    }
  },
  output: {
    responseChars: number,
    responseLines: number,
    truncated: boolean,
    fullOutputPath?: string,
    truncation?: unknown
  },
  warnings: string[]
}
```

Do not include raw API keys, unredacted env, full huge prompts, or full huge responses in `details`.

## Python bridge design

Add `bridge.py` beside `index.ts` for the first slice.

Invocation shape:

```bash
python bridge.py --input /tmp/pi-lambda-rlm-request.json --output /tmp/pi-lambda-rlm-result.json
```

Request shape:

```json
{
  "prompt": "Context:\n...\n\nQuestion: ...\n\nAnswer:",
  "backend": "openai",
  "backend_kwargs": {
    "model_name": "meta/llama-3.3-70b-instruct",
    "base_url": "https://integrate.api.nvidia.com/v1",
    "temperature": 0.6,
    "top_p": 0.7,
    "max_tokens": 4096,
    "stream": false
  },
  "api_key_env": "NVIDIA_API_KEY",
  "lambda_kwargs": {
    "context_window_chars": 100000,
    "accuracy_target": 0.8,
    "a_leaf": 0.95,
    "a_compose": 0.9,
    "verbose": false
  }
}
```

Bridge responsibilities:

1. Load request JSON.
2. Resolve `api_key_env` inside Python and inject the value into `backend_kwargs` in memory only.
3. Import local `rlm.LambdaRLM`.
4. Capture plan metadata by subclassing `LambdaRLM` and overriding `_plan()` for the first slice.
5. Run `.completion(prompt)`.
6. Write a strict JSON result to the output path.
7. Emit optional progress JSONL to stderr.
8. Support `--doctor` for setup checks.
9. Support `--mock` for deterministic offline Node/Pi tests.

The first slice should not auto-install Python dependencies. It should diagnose missing Python, missing imports, missing model, and missing API key.

## Progress and cancellation

The TypeScript tool should emit coarse progress:

1. `prepare` — input source and size.
2. `validate` — Python/repo/API-key checks.
3. `launch` — child process started.
4. `plan` — task type, `k*`, `tau*`, depth, compose op.
5. `execute` — Φ execution started.
6. `complete` — response received and truncated/saved if needed.

For cancellation:

- Wire Pi’s `signal` to the child process.
- Kill the process group on abort or timeout.
- Treat process-kill cancellation as acceptable for the first slice.
- Later, add cooperative cancellation in the persistent worker and Python client bridge.

## Testing strategy

Use TDD for the first implementation.

### TypeScript tests

Write tests before code for:

- Config precedence and redaction.
- Input-source validation.
- `@path` normalization.
- Prompt builder exact output.
- Temp file request construction.
- Bridge result parsing.
- Progress JSONL parsing.
- Error JSON and non-JSON stderr handling.
- Output truncation and full-output file saving.
- Abort/timeout kills a mock long-running bridge.

### Python bridge tests

Write offline tests for:

- `--doctor` without provider calls.
- `--mock` deterministic success.
- Invalid request returns structured JSON error.
- Plan-capture subclass serializes `LambdaPlan`.
- Optional fake-client execution with monkeypatched `get_client`.

### Integration smoke

After unit tests:

1. Load extension with `pi -e ./.pi/extensions/lambda-rlm`.
2. Run `/lambda-rlm-doctor`.
3. Run tool in mock mode.
4. Run one gated real-provider test only when the configured API key is present.
5. Verify no raw API key appears in visible output, details, temp files, stdout, or stderr.

## Open decisions before coding

1. **Default model:** require `LAMBDA_RLM_MODEL`, or default to the README’s NVIDIA NIM model?
2. **Provider config:** first slice should use explicit Lambda-RLM backend config; Pi-current-model mapping comes later.
3. **Plan API:** should we accept private `_plan()` subclass capture initially, then upstream a public callback/metadata hook?
4. **Task override:** should a later version expose `taskType` to skip task detection?
5. **Large-input policy:** should `contextPath` be required above a certain size?
6. **Concurrency:** should `lambda_rlm` enforce a per-session mutex from day one?
7. **Budget guard:** should we add max estimated leaves/calls before real-provider runs on large contexts?
8. **Python env management:** diagnose only, or provide an install helper? Recommendation: diagnose only first.
9. **Termination:** should the tool return `terminate: true`? Recommendation: no for first slice; let Pi synthesize/follow up.
10. **Long-term port:** exact Python parity vs intentionally improved Pi-native executor?

## Recommended next implementation slice

Create a vertical slice with these deliverables:

1. `.pi/extensions/lambda-rlm/index.ts`
   - Registers `lambda_rlm`.
   - Registers `/lambda-rlm-doctor`.
   - Resolves config from params/env/flags.
   - Builds prompt from `prompt` or `context/contextPath + question`.
   - Spawns `bridge.py` with request/output temp files.
   - Wires timeout and cancellation.
   - Parses progress and result.
   - Truncates output.

2. `.pi/extensions/lambda-rlm/bridge.py`
   - `--doctor` mode.
   - `--mock` mode.
   - Real `LambdaRLM` execution mode.
   - Structured success/error JSON.
   - Plan capture.

3. Tests
   - Node tests for config, validation, prompt, parser, truncation, and mock bridge.
   - Python bridge mock/doctor tests.
   - One optional real-provider smoke gated by env.

4. Documentation
   - Setup notes for Python 3.11+ and `pip install -e lambda-RLM`.
   - Required env vars.
   - Examples for file QA and summarization.
   - Safety/cost warnings.

## Correction: Pi leaf agents are more viable than first stated

After checking `pi --help`, Pi's CLI provides enough controls to make leaf-node Pi invocations much narrower than a default coding-agent run:

- `--system-prompt` can replace the default coding prompt.
- `--no-tools`, `--tools`, `--no-extensions`, `--extension`, `--no-context-files`, `--no-prompt-templates`, `--no-session`, and `--mode json|rpc` can isolate the leaf environment.
- `--no-skills` disables discovery, while explicit `--skill` paths can still load selected skills according to Pi's skills docs.

This means there are two distinct Pi-native future paths:

1. **Formal path:** use direct `@mariozechner/pi-ai complete(...)` calls with Pi model-registry/auth. This is closest to replacing Python `BaseLM.completion()` and preserves Lambda-RLM's bounded neural-call assumption.
2. **Pi-augmented path:** use constrained `pi -p` or persistent `pi --mode rpc` leaf agents with a custom system prompt, no tools by default, no discovered context, and optionally selected skills. This weakens formalism relative to direct completion, but may improve quality for smaller leaf models.

See [`05-pi-leaf-agent-option-addendum.md`](./05-pi-leaf-agent-option-addendum.md) for details.

## Final call

The right first move is **not** a TypeScript rewrite. Build a thin, testable Pi extension around the existing Python implementation, using a strict JSON bridge and good Pi tool hygiene. That gives us a working tool quickly and creates a stable seam for future improvements.

If the tool is useful, evolve toward a Pi-auth-integrated mode. The default formal mode should have Python retain the reference Lambda-RLM algorithm while TypeScript services leaf LLM calls through Pi's model registry and `auth.json`. Separately, keep a constrained Pi leaf-agent mode available as an opt-in research path for selected skills and small-model augmentation. Only then decide whether a full TypeScript port is worth the maintenance cost.
