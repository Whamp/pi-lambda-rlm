# Proposed Pi Extension Surface and Implementation Plan for lambda-RLM

Date: 2026-04-25

## Summary

The first practical Pi integration should be a project-local custom tool named `lambda_rlm` that shells out to a small Python bridge. The bridge imports the local `lambda-RLM` package, runs `LambdaRLM.completion(prompt)`, and returns a JSON result to the TypeScript extension. This keeps the Pi extension thin, avoids reimplementing lambda-RLM in TypeScript, and lets us validate the end-to-end value quickly with the source already present at `lambda-RLM/`.

The initial implementation should prefer file-backed context (`contextPath`) over giant inline tool arguments, support explicit model/provider config via env/flags/tool params, surface lambda-RLM plan/usage metadata in `details`, truncate all returned text to Pi’s normal 50 KB / 2000-line limit, and include a `/lambda-rlm-doctor` command for setup verification.

## Research inputs inspected

Pi docs/examples:

- `docs/extensions.md`: `registerTool`, `promptSnippet`, `promptGuidelines`, progress `onUpdate`, tool result shape, custom rendering, mode behavior, error handling, output truncation utilities, extension locations.
- `docs/packages.md`: project-local vs package distribution, `pi` manifest, runtime dependencies, peer dependencies for Pi packages.
- `docs/settings.md`: global/project settings, package/extension loading, `npmCommand`, resource paths.
- `docs/json.md`: JSON event stream mode for verification.
- Examples: `hello.ts`, `dynamic-tools.ts`, `todo.ts`, `truncated-tool.ts`, `structured-output.ts`, `with-deps/`.

lambda-RLM source:

- `lambda-RLM/README.md`: install flow, example API usage, supported datasets, benchmark command shape.
- `lambda-RLM/pyproject.toml`: Python 3.11+, dependencies, package name.
- `lambda-RLM/rlm/lambda_rlm.py`: `LambdaRLM`, `LambdaPlan`, task detection, planning, deterministic Φ execution, constructor params.
- `lambda-RLM/rlm/core/types.py`: `RLMChatCompletion`, `UsageSummary`, `ModelUsageSummary` return serialization.
- `lambda-RLM/rlm/clients/__init__.py` and clients: supported backends and API key defaults.
- `lambda-RLM/rlm/environments/local_repl.py`, `rlm/core/lm_handler.py`: local REPL/temp-dir behavior, socket handler, cleanup model.
- `lambda-RLM/benchmarks/benchmark.py`: backend kwargs pattern, context-window setting, defaults used in benchmark runs.

## Proposed first tool

### Tool identity

- Tool name: `lambda_rlm`
- Label: `λ-RLM`
- Purpose: run lambda-RLM deterministic recursive long-context reasoning on a prompt or a context file plus question.
- Placement for the vertical slice: `.pi/extensions/lambda-rlm/index.ts` with a sibling Python bridge.

Suggested prompt metadata:

```ts
promptSnippet: "Run lambda-RLM deterministic recursive reasoning over a long prompt or context file"
promptGuidelines: [
  "Use lambda_rlm when the user explicitly wants lambda-RLM/λ-RLM or asks for long-context summarization, QA, extraction, or analysis over a large document.",
  "Prefer lambda_rlm contextPath over inline context for large inputs; do not paste entire large files into lambda_rlm context.",
  "lambda_rlm sends the provided context to the configured external model provider and may incur API cost; do not use it for routine code edits or small questions."
]
```

## Parameter schema

Use a flat TypeBox object instead of `oneOf`/deep unions for provider compatibility. Enforce conditional requirements in `execute()`.

```ts
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

const LambdaRlmParams = Type.Object({
  prompt: Type.Optional(Type.String({
    description: "Full prompt to pass directly to LambdaRLM.completion(). Mutually exclusive with context/contextPath."
  })),
  context: Type.Optional(Type.String({
    description: "Inline context text. Use only for modest inputs; prefer contextPath for long documents. Requires question."
  })),
  contextPath: Type.Optional(Type.String({
    description: "Path to a UTF-8 text file containing context. Relative paths resolve from the Pi cwd; leading @ is normalized away. Requires question."
  })),
  question: Type.Optional(Type.String({
    description: "Question, task, or instruction to answer using context/contextPath. If prompt is provided, this is optional."
  })),

  backend: Type.Optional(StringEnum([
    "openai",
    "vllm",
    "portkey",
    "openrouter",
    "vercel",
    "litellm",
    "anthropic",
    "azure_openai",
    "gemini"
  ] as const, { description: "lambda-RLM client backend. Defaults from flags/env." })),
  model: Type.Optional(Type.String({
    description: "Provider model name, e.g. meta/llama-3.3-70b-instruct. Defaults from flags/env; required after defaults are resolved."
  })),
  baseUrl: Type.Optional(Type.String({
    description: "OpenAI-compatible base URL, e.g. https://integrate.api.nvidia.com/v1. Defaults from flags/env when set."
  })),
  apiKeyEnv: Type.Optional(Type.String({
    description: "Environment variable name containing the provider API key. The raw key is never accepted as a tool argument."
  })),

  contextWindowChars: Type.Optional(Type.Number({
    minimum: 1000,
    maximum: 2000000,
    description: "lambda-RLM context_window_chars. Default 100000."
  })),
  accuracyTarget: Type.Optional(Type.Number({
    minimum: 0,
    maximum: 1,
    description: "lambda-RLM accuracy_target. Default 0.80."
  })),
  aLeaf: Type.Optional(Type.Number({
    minimum: 0,
    maximum: 1,
    description: "Estimated leaf-call accuracy. Default 0.95."
  })),
  aCompose: Type.Optional(Type.Number({
    minimum: 0,
    maximum: 1,
    description: "Estimated per-level composition accuracy. Default 0.90."
  })),

  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  topP: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  maxTokens: Type.Optional(Type.Number({ minimum: 1, maximum: 65536 })),
  stream: Type.Optional(Type.Boolean({
    description: "Forward stream to lambda-RLM OpenAI-compatible client. Default false initially for more reliable usage accounting."
  })),
  timeoutSeconds: Type.Optional(Type.Number({
    minimum: 1,
    maximum: 86400,
    description: "Wall-clock timeout for the Python bridge process. Default 300."
  })),
  verbose: Type.Optional(Type.Boolean({
    description: "Enable lambda-RLM verbose plan prints in the bridge logs. Default false."
  }))
}, { additionalProperties: false });
```

Runtime validation:

1. Accept exactly one input source:
   - `prompt`, or
   - `context`, or
   - `contextPath`.
2. Require `question` when using `context` or `contextPath`.
3. Reject unresolved `model` after merging params, flags, and env.
4. Reject missing `apiKeyEnv` value when the chosen backend/base URL cannot infer a key and no provider default applies.
5. Normalize a leading `@` on `contextPath`, matching Pi built-in path behavior.
6. Enforce a configurable max input size, initially `1_200_000` chars to mirror the benchmark hard cap unless the user opts in to larger runs via env/flag.

`prepareArguments()` should support small compatibility shims such as `path -> contextPath` and `instruction -> question`, but the public schema should stay strict.

## Prompt construction

When `prompt` is provided, pass it through unchanged.

When `context` or `contextPath` is provided, build the prompt in the shape already parsed by `LambdaRLM.completion()`:

```text
Context:
{context}

Question: {question}

Answer:
```

This matches `lambda_rlm.py`, which extracts the trailing `Question:` as `effective_query` and stores only the context text in `context_0`.

## Return and details shape

Pi tool success result:

```ts
return {
  content: [{ type: "text", text: visibleText }],
  details,
};
```

Errors should be signaled by throwing from `execute()` so Pi marks the tool result as `isError: true`.

Proposed `details` shape:

```ts
interface LambdaRlmToolDetails {
  ok: true;
  input: {
    source: "prompt" | "inline_context" | "file";
    contextPath?: string;
    promptChars: number;
    contextChars?: number;
    questionChars?: number;
    inputBytes?: number;
  };
  config: {
    repoPath: string;
    pythonPath: string;
    backend: string;
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    apiKeyPresent?: boolean;
    contextWindowChars: number;
    accuracyTarget: number;
    aLeaf: number;
    aCompose: number;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    stream: boolean;
    timeoutSeconds: number;
  };
  lambdaRlm: {
    rootModel: string;
    executionTimeSeconds: number;
    usageSummary?: {
      model_usage_summaries: Record<string, {
        total_calls: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost?: number;
      }>;
      total_cost?: number;
    };
    plan?: {
      taskType: string;
      composeOp: string;
      useFilter: boolean;
      kStar: number;
      tauStar: number;
      depth: number;
      costEstimate: number;
      n: number;
    };
  };
  output: {
    responseChars: number;
    responseLines: number;
    truncated: boolean;
    fullOutputPath?: string;
    truncation?: unknown;
  };
  timings: {
    totalMs: number;
    pythonMs?: number;
  };
  warnings: string[];
}
```

Notes:

- Do not store raw API keys in params, temp output, details, logs, or rendered text.
- `plan` can be captured in the bridge by subclassing `LambdaRLM` and overriding `_plan()` to save the returned `LambdaPlan`. This is private API usage, acceptable for the first slice but should become a lambda-RLM public hook later.
- `usageSummary` can use `RLMChatCompletion.to_dict()` semantics from `rlm/core/types.py`.

## Output truncation behavior

Custom tools must truncate output. Use Pi’s exported utilities:

- Default hard cap: `DEFAULT_MAX_BYTES` = 50 KB and `DEFAULT_MAX_LINES` = 2000.
- Use `truncateHead()` for the final answer because answer introductions and summaries usually start at the top.
- Use `truncateTail()` for stderr/traceback snippets when throwing errors.
- If the response is truncated:
  1. write the full response to an OS temp file, e.g. `/tmp/pi-lambda-rlm-*/response.txt`,
  2. include a clear truncation notice at the end of `content[0].text`,
  3. include `details.output.fullOutputPath`,
  4. include truncation counts in `details.output.truncation`.

Example visible suffix:

```text

[Output truncated: showing 2000 of 4312 lines (50KB of 178KB). Full output saved to: /tmp/pi-lambda-rlm-abc123/response.txt]
```

The first slice should not expose tool params that raise the output limit above Pi’s default. Lower per-call limits are fine later.

## Progress updates

The TypeScript tool should call `onUpdate` at coarse phases immediately, and the Python bridge should emit optional JSONL progress on stderr for finer updates.

Initial phases:

1. `prepare`: resolved input source, prompt/context size.
2. `validate`: repo/python/import/API-key checks.
3. `launch`: Python bridge started with backend/model.
4. `plan`: task type, `k*`, `tau*`, depth, compose op when `_plan()` runs.
5. `execute`: Φ execution started.
6. `complete`: response received, usage/truncation summary.

`onUpdate` payload shape:

```ts
onUpdate?.({
  content: [{ type: "text", text: "λ-RLM planning: qa, depth=1, k*=2" }],
  details: { phase: "plan", taskType: "qa", depth: 1, kStar: 2 }
});
```

Bridge progress format on stderr:

```jsonl
{"type":"progress","phase":"start","message":"Importing lambda-RLM"}
{"type":"progress","phase":"plan","taskType":"qa","composeOp":"select_relevant","kStar":2,"tauStar":100000,"depth":1}
{"type":"progress","phase":"execute","message":"Executing Φ"}
```

Non-JSON stderr should be accumulated as diagnostics and truncated on errors.

Cancellation behavior:

- Wire Pi’s `signal` to the child process.
- On abort, terminate the Python process group.
- Current lambda-RLM does not expose cooperative cancellation for in-flight provider calls, so process termination is the practical first-slice cancellation mechanism.

## Config and environment handling

### Resolution precedence

For each config value:

1. Tool parameter.
2. Pi registered CLI flag.
3. Environment variable.
4. Hard-coded default, if safe.

Suggested flags/env:

| Value | Pi flag | Env | Default |
|---|---|---|---|
| lambda-RLM repo | `--lambda-rlm-repo` | `LAMBDA_RLM_REPO` | `${ctx.cwd}/lambda-RLM` if it exists |
| Python executable | `--lambda-rlm-python` | `LAMBDA_RLM_PYTHON` | `${LAMBDA_RLM_VENV}/bin/python` or `python3` |
| backend | `--lambda-rlm-backend` | `LAMBDA_RLM_BACKEND` | `openai` |
| model | `--lambda-rlm-model` | `LAMBDA_RLM_MODEL` | none; require resolved value |
| base URL | `--lambda-rlm-base-url` | `LAMBDA_RLM_BASE_URL` | provider/client default |
| API key env var | `--lambda-rlm-api-key-env` | `LAMBDA_RLM_API_KEY_ENV` | infer for known providers/base URLs |
| context window | `--lambda-rlm-context-window-chars` | `LAMBDA_RLM_CONTEXT_WINDOW_CHARS` | `100000` |
| max input chars | `--lambda-rlm-max-input-chars` | `LAMBDA_RLM_MAX_INPUT_CHARS` | `1200000` |
| timeout | `--lambda-rlm-timeout-seconds` | `LAMBDA_RLM_TIMEOUT_SECONDS` | `300` |

API key handling:

- The tool accepts only `apiKeyEnv`, never raw `apiKey`.
- The bridge receives the env var name and resolves `os.environ[api_key_env]` inside Python.
- For `openai` with official OpenAI, OpenRouter, Vercel, Prime, or NVIDIA base URLs, the existing `OpenAIClient` already checks known env vars. Passing `apiKeyEnv` makes generic OpenAI-compatible endpoints work too.
- The lambda-RLM Python package calls `load_dotenv()`, so a `.env` in the repo/process cwd can participate.

Python environment:

- Run the bridge with `cwd` set to the lambda-RLM repo root.
- Set `PYTHONPATH={repoPath}:{existing PYTHONPATH}` so editable install is not strictly required for the first smoke test.
- Still recommend `pip install -e .` in a venv/conda env because dependencies are non-trivial.
- Add `/lambda-rlm-doctor` to check Python version, importability, package path, selected model/backend, and API key presence without making an LLM call.

Security/privacy note:

- The tool will send the provided prompt/context to the configured model provider.
- `LocalREPL` is safer than arbitrary generated code for lambda-RLM’s fixed Φ path, but it is still local Python execution with package dependencies and filesystem access. Treat the lambda-RLM checkout and extension as trusted code.

## Python bridge design

A small bridge keeps TypeScript simple and makes direct use of the Python API.

Invocation:

```bash
python bridge.py --input /tmp/pi-lambda-rlm-request.json --output /tmp/pi-lambda-rlm-result.json
```

Request JSON, with no raw secrets:

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

Bridge steps:

1. Parse request.
2. If `api_key_env` is set, read the env var and inject `backend_kwargs.api_key` in memory only.
3. Define `CapturingLambdaRLM(LambdaRLM)`:
   - override `_plan()` to save and emit plan progress,
   - optionally override `_register_library()` to emit execute progress.
4. Instantiate `CapturingLambdaRLM(...)`.
5. Call `.completion(prompt)`.
6. Write a JSON result containing `completion.to_dict()`, captured `plan`, Python/package metadata, and timings.

The bridge should also support:

- `--doctor`: import/config checks only.
- `--mock`: deterministic offline result for Node/Pi tests with no provider calls.

## Package layout

### Recommended vertical-slice layout

Start project-local for fast iteration and `/reload` support:

```text
.pi/extensions/lambda-rlm/
  index.ts              # registers lambda_rlm and /lambda-rlm-doctor
  bridge.py             # thin Python runner around LambdaRLM
  README.md             # setup notes after the first slice
```

No npm dependencies should be needed beyond Pi-provided imports (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `typebox`, `@mariozechner/pi-tui`). Use Node built-ins for filesystem/temp/process work.

### Later repo package layout

If this becomes shareable, move to a package:

```text
packages/pi-lambda-rlm-extension/
  package.json
  src/
    index.ts
    bridge.py
    config.ts
    prompt.ts
    truncation.ts
  tests/
    config.test.ts
    prompt.test.ts
    bridge-mock.test.ts
    truncation.test.ts
  README.md
```

`package.json` should include:

```json
{
  "name": "pi-lambda-rlm-extension",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./src/index.ts"] },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "typescript": "latest",
    "vitest": "latest",
    "tsx": "latest"
  }
}
```

Python dependencies should remain owned by the lambda-RLM environment, not bundled into the Pi npm package.

## Custom rendering

For the first slice, implement compact renderers only if time permits.

`renderCall` should show:

```text
λ-RLM file docs/long-context.txt → qa (model meta/llama-3.3-70b-instruct)
```

`renderResult` collapsed view should show:

```text
✓ λ-RLM completed in 42.1s · task=qa · depth=1 · calls=7 · truncated=no
```

Expanded view can include the first few answer lines, plan fields, usage totals, and full-output path when truncated.

## Tests and verification strategy

### Red/green unit tests

Write tests before implementation for:

1. Config resolution precedence and redaction.
2. Input validation:
   - rejects no input source,
   - rejects multiple input sources,
   - rejects context without question,
   - normalizes `@path`.
3. Prompt builder emits the exact `Context:/Question:/Answer:` shape parsed by `LambdaRLM.completion()`.
4. Truncation helper saves full output and reports counts.
5. Bridge result parser handles success, progress JSONL, non-JSON stderr, and error JSON.
6. Abort signal kills the child process in a mock long-running bridge.

### Python bridge tests

Prefer offline tests:

- `python bridge.py --doctor` in a prepared env.
- `python bridge.py --mock --input fixture.json --output result.json`.
- Optional pytest that monkeypatches `rlm.lambda_rlm.get_client` with a fake client so `LambdaRLM.completion()` can run without network while exercising planning and result serialization.

### Pi/tool integration tests

Use a mock `ExtensionAPI` in Node tests to capture the registered `lambda_rlm` tool and call `execute()` directly. This avoids depending on an LLM deciding to call the tool.

Then add smoke tests:

```bash
pi -e .pi/extensions/lambda-rlm --mode json "Use lambda_rlm with this tiny context: ..." 2>/tmp/pi-lambda-rlm.err
```

This verifies extension loading and JSON event stream behavior, but it is less deterministic than direct tool invocation.

### Real-provider gated verification

Run only when an API key is present:

```bash
export LAMBDA_RLM_REPO=$PWD/lambda-RLM
export LAMBDA_RLM_PYTHON=/path/to/venv/bin/python
export LAMBDA_RLM_BACKEND=openai
export LAMBDA_RLM_MODEL=meta/llama-3.3-70b-instruct
export LAMBDA_RLM_BASE_URL=https://integrate.api.nvidia.com/v1
export LAMBDA_RLM_API_KEY_ENV=NVIDIA_API_KEY
```

Use a tiny context where `n <= context_window_chars` to minimize calls. Assert:

- tool returns non-empty response,
- `details.lambdaRlm.usageSummary` exists when provider returns usage,
- `details.lambdaRlm.plan.depth === 0` for small input,
- no raw API key appears in output/details/temp result JSON.

## Small vertical-slice plan

1. **Test scaffold first**
   - Add Node tests for config, prompt building, result parsing, truncation, and mock bridge execution.
   - Add a minimal bridge mock fixture.

2. **Project-local extension skeleton**
   - Create `.pi/extensions/lambda-rlm/index.ts`.
   - Register flags, `/lambda-rlm-doctor`, and a placeholder `lambda_rlm` tool.
   - Verify `/reload` discovers the extension.

3. **Python bridge**
   - Add `bridge.py` with `--doctor`, `--mock`, and real execution modes.
   - Implement `CapturingLambdaRLM` plan capture.
   - Emit JSONL progress to stderr and final JSON to output file.

4. **Tool execution path**
   - Resolve config.
   - Build/read prompt.
   - Write request temp file.
   - Spawn Python with cancellation and timeout.
   - Parse final JSON.
   - Apply output truncation and return Pi result/details.

5. **Minimal rendering and verification**
   - Add compact `renderCall`/`renderResult`.
   - Run unit tests, bridge mock test, doctor check, then one gated provider smoke.
   - Capture the exact commands and output snippets in a follow-up implementation note.

## Open questions and decisions before coding

1. **Provider/model source of truth**
   - Should `lambda_rlm` use its own backend/model config, or try to map Pi’s current `ctx.model` to lambda-RLM client backends? First slice should use explicit lambda-RLM config; mapping can come later.

2. **Default model/provider**
   - README examples use NVIDIA NIM (`meta/llama-3.3-70b-instruct`, `https://integrate.api.nvidia.com/v1`), while the benchmark default currently uses a Qwen NVIDIA model. Decide whether to provide an NVIDIA default or require `LAMBDA_RLM_MODEL`.

3. **Plan/progress public API**
   - Capturing `_plan()` via subclass is practical but private. Should lambda-RLM expose public callbacks or include plan metadata in `RLMChatCompletion.metadata`?

4. **Task override**
   - Current lambda-RLM always performs task detection. Should the tool expose a `taskType` override later to avoid the detection call when the user knows the task?

5. **Context input policy**
   - Should `contextPath` be the only accepted large-input mode? Inline `context` is convenient but can bloat tool-call arguments and session context.

6. **Final-answer behavior**
   - Should the tool return `terminate: true` when it likely has the final answer, or should Pi always do a follow-up assistant synthesis? First slice should not terminate automatically.

7. **Budget and cost limits**
   - `LambdaRLM` exposes a cost estimate but not a hard budget/call cap. Do we need extension-level max calls/cost enforcement before real use on large contexts?

8. **Cancellation semantics**
   - Process kill is adequate for the first slice, but graceful provider-request cancellation would require lambda-RLM/client changes.

9. **Python environment management**
   - Should the extension only diagnose missing deps, or offer an install helper? First slice should diagnose only to avoid surprising environment changes.

10. **Concurrency**
    - Pi tools can run in parallel. Should the extension serialize `lambda_rlm` calls per session to avoid multiple expensive Python/provider runs at once? First slice should probably guard with a simple in-memory mutex or explicit warning.

11. **Security posture**
    - lambda-RLM’s deterministic Φ avoids arbitrary LLM-generated control code, but the local Python runtime still has filesystem/network access. Decide whether to document stronger sandboxing expectations before distribution.

## Recommendation

Implement the project-local `lambda_rlm` tool first, backed by a Python bridge and strong doctor/mock tests. Keep the first slice narrow: one completion tool, file-or-inline prompt construction, explicit provider config, progress updates, truncation, and result metadata. Do not attempt Pi model-registry integration, auto-installation, task overrides, or full package distribution until the vertical slice proves reliable with a real provider.
