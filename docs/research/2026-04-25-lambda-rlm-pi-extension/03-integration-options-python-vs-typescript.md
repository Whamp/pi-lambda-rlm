# λ-RLM Pi Tool Integration Options: Python vs TypeScript vs Hybrid

Date: 2026-04-25

## Executive summary

The best integration path depends on whether the first goal is **fast exposure** or **Pi-native ergonomics**.

Recommended path:

1. **Near-term proof of concept:** add a small Python CLI/JSON bridge around the existing `LambdaRLM` package and spawn it from a TypeScript Pi extension tool. This preserves the local Python implementation, avoids a risky port, and gives a stable contract for tests.
2. **Near-term production shape:** evolve the CLI into a **persistent Python worker** if the tool will be called frequently or on large inputs. Add a custom Python `BaseLM` bridge so leaf calls can be serviced by the TypeScript extension using Pi's current model credentials via `@mariozechner/pi-ai` `complete(...)`.
3. **Long-term Pi-native option:** port the deterministic λ-RLM planner/executor to TypeScript only if this becomes a first-class Pi feature and upstream Python churn is low. A TS port should not recreate Python's REPL layer; λ-RLM's executor is deterministic, so it can be ordinary TS functions.
4. **Avoid JS/TS REPL as a primary strategy for λ-RLM.** Current JS sandbox choices are useful for arbitrary user/plugin code, but λ-RLM does not need arbitrary generated-code execution. Node `vm` is explicitly not a security boundary, `vm2` remains a bad choice for untrusted code, and heavier isolates/QuickJS/Deno add complexity without solving the main integration need.

Best overall balance for Pi: **hybrid persistent Python worker + TS leaf-call bridge**. It preserves the Python research code while letting λ-RLM use the same selected Pi model, auth, abort signal, and extension UX.

## Sources inspected

Local Pi docs/examples:

- Pi extension docs: `docs/extensions.md`
  - Extensions are TypeScript modules loaded by Pi.
  - Custom tools are registered with `pi.registerTool(...)`.
  - Tool `execute(...)` receives params, `AbortSignal`, progress callback, and `ExtensionContext`.
  - `ExtensionContext` exposes `ctx.cwd`, `ctx.model`, `ctx.modelRegistry`, `ctx.signal`, UI helpers, and session state.
  - Custom tools should truncate large output and throw errors to mark failures.
- Pi SDK docs: `docs/sdk.md`
  - SDK can create `AgentSession`s, but that is usually too heavy for leaf LLM calls.
- Pi examples:
  - `examples/extensions/hello.ts`: minimal `defineTool`/`registerTool` pattern.
  - `examples/extensions/qna.ts`, `handoff.ts`, `summarize.ts`: use `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!)` plus `complete(...)` from `@mariozechner/pi-ai` for direct model calls inside extensions.
  - `examples/extensions/subagent/index.ts`: spawns separate `pi --mode json -p --no-session` processes for isolated subagents; useful pattern for nested Pi, but expensive for λ-RLM leaf calls.

Local lambda-RLM source:

- `lambda-RLM/README.md`: λ-RLM uses deterministic recursive decomposition, bounded LLM leaf calls, and provider credentials such as `NVIDIA_API_KEY` or `TOGETHER_API_KEY`.
- `lambda-RLM/pyproject.toml`: Python 3.11+ package with LLM client deps (`openai`, `anthropic`, `google-genai`, `portkey-ai`, `litellm`), plus benchmark/data deps.
- `lambda-RLM/rlm/lambda_rlm.py`: implementation of `LambdaRLM.completion(prompt)`.
- `lambda-RLM/rlm/environments/local_repl.py`: local Python REPL used by current execution path.
- `lambda-RLM/rlm/core/lm_handler.py`: socket server that routes REPL `llm_query(...)` calls to a `BaseLM` client.
- `lambda-RLM/rlm/clients/*.py`: provider client adapters and usage tracking.

Web research summary for JS/TS sandbox choices:

- Node `vm`: official docs state it is **not a security mechanism** and must not be used for untrusted code.
- `vm2`: long history of escapes; public guidance continues to recommend avoiding it for attacker-controlled code.
- `isolated-vm`: V8 isolate-based, stronger than `vm`, but native addon, maintenance-mode caveats, Node-version flags, and same-process catastrophic-error concerns.
- SES/Endo: object-capability compartments and `lockdown()`, good for least-authority plugin systems, not an OS/process resource boundary.
- QuickJS/WASM (`quickjs-emscripten`, `@sebastianwessel/quickjs`, TanStack QuickJS isolate driver): portable, has memory/interrupt/stack controls, slower and more complex for modules/async/TS transpilation.
- Deno permissions / Deno sandbox: strong default permission model and useful subprocess/microVM options, but still another runtime and subprocess boundary.

## Current λ-RLM implementation facts that drive integration

`LambdaRLM.completion(prompt)` does the following:

1. Validates the prompt is a string.
2. Parses benchmark-style prompts into:
   - `context_text`: recursively split document text.
   - `effective_query`: extracted `Question: ...` text or constructor `query`.
3. Creates a provider client with `get_client(self.backend, self.backend_kwargs)`.
4. Starts `LMHandler(client)`, a local threaded socket server.
5. Creates `LocalREPL(...)` with `context_payload=context_text`.
6. Makes one direct LLM call for task detection via `_TASK_DETECTION_PROMPT`.
7. Computes a deterministic `LambdaPlan`:
   - `task_type`
   - `compose_op`
   - `k_star`
   - `tau_star`
   - `depth`
   - `cost_estimate`
8. Registers deterministic Python combinators in the REPL globals:
   - `_Split`
   - `_Peek`
   - `_Reduce`
   - `_FilterRelevant`
9. Builds deterministic Python code defining `_Phi(P)` and executes it in the REPL.
10. `_Phi` makes bounded `llm_query(...)` leaf calls and reduction/filter calls.
11. Returns `RLMChatCompletion` with `response`, `usage_summary`, and `execution_time`.

Important implications:

- λ-RLM currently uses Python `exec(...)`, but not for LLM-generated arbitrary code. The generated `_Phi` code is produced by local deterministic Python code.
- The `LocalREPL` sandbox is not a hard security boundary. Its safe builtins still include powerful functions such as `open` and `__import__`. This is acceptable only because λ-RLM is not executing model-generated code in the current path.
- The Python package has no dedicated Pi-oriented CLI/JSON contract today. Benchmarks instantiate `LambdaRLM(...)` directly.
- Leaf calls currently use Python provider clients through `BaseLM`, not Pi's selected model directly.
- The current executor is mostly sequential; leaf calls and relevance filters are not batched/concurrent in `lambda_rlm.py`.

## Pi integration facts that drive design

A Pi tool exposed from an extension should look like this:

- Registered in TypeScript with `pi.registerTool(...)` or `defineTool(...)`.
- Parameters described with TypeBox / `StringEnum` where needed.
- `execute(toolCallId, params, signal, onUpdate, ctx)` should:
  - Respect `signal` for cancellation.
  - Stream progress via `onUpdate` for long runs.
  - Throw to signal tool failure.
  - Return concise `content` for the LLM and richer `details` for UI/state.
  - Truncate or externalize large outputs.

A TypeScript extension can call Pi's current model directly with the local pattern from Pi examples:

```ts
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
const response = await complete(
  ctx.model!,
  { systemPrompt, messages },
  { apiKey: auth.apiKey, headers: auth.headers, signal },
);
```

This is the cleanest way to honor the user's current Pi model, provider auth, custom headers, and abort signal. Python cannot automatically use that machinery unless the TypeScript extension acts as a bridge or the Python provider clients are taught how to call the same API endpoint.

## Leaf LLM call supply options

| Leaf-call source | How it works | Pros | Cons | Best fit |
|---|---|---|---|---|
| External provider credentials in Python | Pass `backend`, `model_name`, `base_url`, `api_key`, and generation params to Python `LambdaRLM`; Python clients call OpenAI/Anthropic/Gemini/etc. | Minimal changes; uses existing usage accounting; easy first bridge. | Separate auth path from Pi; may not support Pi subscription/OAuth/custom providers; secrets cross process boundary. | Proof of concept and benchmark parity. |
| Pi current model from TS extension | TS extension handles every task/leaf/reducer LLM request using `complete(ctx.model!, ...)`. Python calls back over IPC, or TS port calls directly. | Best Pi UX; honors selected model, auth headers, custom providers, abort signal. | Requires bridge protocol or TS port; usage accounting must be normalized. | Production Pi tool. |
| Nested Pi / SDK | Spawn `pi --mode json -p --no-session` or create SDK sessions for subcalls. | Isolated context, can use full Pi agent/tool stack. | Huge overhead per leaf; risks recursive tool use; harder to bound; bad fit for dozens/hundreds of leaf calls. | Coarse subagents, not λ-RLM leaves. |
| Direct provider mapping from Pi model metadata | TS obtains `ctx.model`, API key/headers, base URL, then passes equivalent settings to Python clients. | Lets Python stay mostly unchanged while using some Pi credentials. | Only works when provider API matches Python clients; custom `streamSimple`, OAuth-only, or non-OpenAI transports may not map. | Interim for OpenAI-compatible providers. |

## Option 1: Keep Python package and spawn it directly from the TS extension

### Shape

The extension's tool constructs a command such as:

```bash
python - <<'PY'
import json, os, sys
from rlm import LambdaRLM
payload = json.load(sys.stdin)
rlm = LambdaRLM(**payload["constructor"])
result = rlm.completion(payload["prompt"])
print(json.dumps(result.to_dict()))
PY
```

or spawns a small ad hoc Python script located in the extension package. The TypeScript tool writes JSON to stdin and parses JSON from stdout.

### Leaf LLM calls

Usually supplied by Python's existing provider clients:

- `backend="openai"` with `base_url` and `api_key`.
- Existing env variables such as `OPENAI_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, etc.
- Possibly `anthropic`, `gemini`, `litellm`, `portkey`, `azure_openai` via existing client adapters.

Pi current model support is weak unless the TS extension maps Pi model/provider settings to Python-compatible `backend_kwargs`.

### Operational complexity

Low code complexity, medium user complexity.

Required user/runtime setup:

- Python 3.11+.
- Install package, likely `pip install -e lambda-RLM` or a packaged wheel.
- Heavy deps from `pyproject.toml`, including benchmark deps that are not necessarily needed for the tool.
- Correct provider env vars or explicit tool params.

Concerns:

- Tool call pays Python startup and import time every invocation.
- Need robust path discovery for the local `lambda-RLM` checkout/package.
- Need clean stdout/stderr separation; Python warnings/logs can corrupt JSON unless carefully redirected.

### Safety

Moderate.

- Process boundary protects the Pi extension process from Python crashes.
- No strong host isolation: Python has the same user permissions as Pi.
- Existing λ-RLM path does not execute LLM-generated code, which is the important safety property.
- Secrets passed through env/stdin are visible to that subprocess and possibly process inspection depending on method.

### Testability

Good if a stable JSON contract is imposed by TS tests, but poor if using an inline script with no Python-side tests.

Minimum tests:

- TS unit test with fake spawned process.
- Python smoke test with fake client.
- Contract test: given JSON input, output JSON result or JSON error.
- Cancellation test: abort kills child process and process tree.

### Latency

Worst of the Python-preserving options.

- Adds cold start per tool call: Python startup, imports, dotenv loading, provider client initialization.
- For very long λ-RLM runs, LLM latency dominates, so startup may be tolerable.
- For short prompts, startup overhead will be noticeable.

### Maintenance

Low for λ-RLM algorithm, because Python remains source of truth. Medium for integration glue, because ad hoc spawn scripts tend to accumulate edge cases.

### Verdict

Acceptable for a quick proof of concept, but do not stop here if this tool will be used regularly.

## Option 2: Add a small Python CLI/JSON bridge

### Shape

Add a dedicated command/module, for example:

```bash
python -m rlm.pi_bridge --input request.json
# or
python -m rlm.pi_bridge < request.json
```

Suggested request shape:

```json
{
  "prompt": "Context:\n...\n\nQuestion: ...\n\nAnswer:",
  "query": null,
  "backend": "openai",
  "backend_kwargs": {
    "model_name": "meta/llama-3.3-70b-instruct",
    "base_url": "https://integrate.api.nvidia.com/v1",
    "temperature": 0.2,
    "max_tokens": 4096
  },
  "context_window_chars": 100000,
  "accuracy_target": 0.8,
  "verbose": false
}
```

Suggested response shape:

```json
{
  "ok": true,
  "response": "...",
  "root_model": "...",
  "usage_summary": { "model_usage_summaries": {} },
  "execution_time": 12.34,
  "plan": {
    "task_type": "qa",
    "compose_op": "select_relevant",
    "k_star": 3,
    "tau_star": 100000,
    "depth": 1,
    "cost_estimate": 300500.0,
    "n": 250000
  },
  "logs": []
}
```

Errors should also be JSON:

```json
{
  "ok": false,
  "error": {
    "type": "RuntimeError",
    "message": "...",
    "traceback": "..."
  }
}
```

### Leaf LLM calls

Same as option 1 by default: Python provider credentials.

The bridge can later add a `backend="pi_bridge"` mode, but that likely requires a custom `BaseLM` or constructor injection change in `LambdaRLM`.

### Operational complexity

Medium-low.

More code than ad hoc spawn, but much cleaner:

- Stable process contract.
- Better error handling.
- Easier tests.
- Can redirect logs to stderr while stdout remains JSON.
- Can expose `--jsonl` later for worker mode.

Potential packaging improvement:

- Split Python dependencies into a minimal runtime extra. Current `pyproject.toml` includes benchmark/data/plotting/dev dependencies that a Pi tool does not need.

### Safety

Similar to option 1, with better controllability.

- Easier to validate request fields.
- Easier to enforce max prompt size, max depth, max leaf calls, timeouts, and model allowlists.
- Still same-user Python process, not a hard sandbox.

### Testability

Very good.

- Python CLI contract tests can run without Pi.
- TS extension tests can mock the CLI or run it against fake LLM backend.
- Golden tests can compare Python response shape over time.

### Latency

Same cold-start cost as option 1 per invocation, unless the CLI adds a JSONL worker mode.

### Maintenance

Good.

- Keeps λ-RLM source of truth in Python.
- Small stable seam between Pi and Python.
- Easier to upstream or keep as a narrow local patch.

### Verdict

Best immediate implementation step. It is the clean version of “spawn Python from a TS extension.”

## Option 3: Run a persistent Python worker

### Shape

The extension starts a long-lived Python process on `session_start` or lazily on first tool call:

```bash
python -m rlm.pi_worker
```

Communication options:

- NDJSON over stdin/stdout.
- Length-prefixed JSON over stdio.
- Local TCP or Unix socket.

Request types:

```json
{ "id": "1", "type": "complete", "payload": { "prompt": "...", "constructor": {} } }
{ "id": "2", "type": "cancel", "target": "1" }
{ "id": "3", "type": "shutdown" }
```

Progress events:

```json
{ "id": "1", "type": "progress", "message": "planned k*=3 depth=1" }
{ "id": "1", "type": "llm_call_start", "kind": "leaf", "chars": 50000 }
{ "id": "1", "type": "result", "ok": true, "payload": {} }
```

### Leaf LLM calls

Two viable modes:

#### 3A. Python-direct providers

Worker creates normal `LambdaRLM` instances and uses Python clients.

Pros:

- Minimal algorithm change.
- Existing `LMHandler` and usage accounting keep working.

Cons:

- Still separate from Pi current model/auth.

#### 3B. TS leaf-call callback bridge

Worker uses a custom Python `BaseLM` implementation whose `completion(prompt)` sends a JSON request to the TS parent. The TS parent calls Pi's current model with `complete(ctx.model!, ...)` and returns text plus usage.

This likely requires a small Python API change because `LambdaRLM.completion(...)` currently constructs its client internally with `get_client(...)`. Options:

- Add optional `client: BaseLM | None` to `LambdaRLM.__init__`.
- Add a new backend literal such as `"pi_bridge"` in `get_client(...)`.
- Add `client_factory` injection.

Best design is constructor injection:

```python
class LambdaRLM:
    def __init__(..., client: BaseLM | None = None):
        self.client = client

    def completion(self, prompt: str) -> RLMChatCompletion:
        client = self.client or get_client(self.backend, self.backend_kwargs)
```

### Operational complexity

Medium-high.

Needs lifecycle management:

- Start/lazy start.
- Health check.
- Restart on crash.
- Version handshake.
- Abort/cancel propagation.
- Request timeouts.
- Concurrent request policy.
- Cleanup on `session_shutdown`.

Pi extension can use `ctx.ui.setStatus`/`onUpdate` to surface progress.

### Safety

Better than per-call spawn for reliability, worse for blast radius if state leaks.

- Long-lived worker may retain secrets and state.
- Must avoid sharing prompt/results across requests accidentally.
- Should process one λ-RLM request at a time unless concurrency is explicitly designed.
- If using TS leaf bridge, avoid giving Python arbitrary tool access; only expose a narrow `complete(prompt, metadata)` RPC.

### Testability

Very good if protocol is explicit.

Tests:

- Worker protocol unit tests.
- Fake TS parent for `BaseLM` callback.
- Restart/crash recovery tests.
- Cancellation while leaf call is in flight.
- Multiple sequential completions confirm no state leakage.

### Latency

Good.

- Avoids Python/import cold start after first use.
- Still pays local IPC per λ-RLM request and possibly per leaf call if using TS leaf bridge.
- Per-leaf bridge IPC is usually tiny compared with LLM latency.
- Enables future optimization: batch leaf calls or concurrency limits coordinated by TS.

### Maintenance

Medium.

- Python algorithm remains source of truth.
- Worker protocol and custom `BaseLM` are custom code to maintain.
- Still tied to Python runtime/deps.

### Verdict

Best Python-preserving production architecture, especially with a TS leaf-call bridge for Pi current model support.

## Option 4: Hybrid Python worker with Pi-native leaf calls

This is the most attractive production shape, so it is worth calling out separately from a generic worker.

### Shape

- Python keeps:
  - Task detection prompt text and parsing.
  - Planner.
  - Split/filter/reduce semantics.
  - `LambdaPlan` data model.
  - Recursive execution behavior.
- TypeScript owns:
  - Pi tool schema and UX.
  - Model selection and auth via `ctx.model`/`ctx.modelRegistry`.
  - Actual LLM calls via `complete(...)`.
  - Abort signal and progress UI.
  - Output truncation and result rendering.

Worker protocol includes an LLM request path:

```json
{
  "id": "run-1/llm-7",
  "type": "llm_request",
  "payload": {
    "kind": "leaf",
    "prompt": "Using the following context...",
    "metadata": {
      "task_type": "qa",
      "depth": 1,
      "chunk_chars": 48123
    }
  }
}
```

TS response:

```json
{
  "id": "run-1/llm-7",
  "type": "llm_response",
  "ok": true,
  "payload": {
    "text": "...",
    "usage": {
      "input": 1234,
      "output": 321,
      "cost": 0.0012
    }
  }
}
```

### Leaf LLM calls

Use Pi current model by default.

Optional tool parameter can allow explicit external provider mode for benchmark parity:

```ts
leafProvider: "pi-current-model" | "python-backend"
```

### Operational complexity

High enough to justify doing only after CLI POC.

Hard parts:

- Bidirectional request/response multiplexing.
- Cancellation while Python waits for a TS-serviced LLM call.
- Usage normalization from Pi response to Python `UsageSummary` or final tool `details`.
- Avoiding deadlock if the Pi agent is already in a tool execution. Direct `complete(...)` is fine; spawning a nested agent is not.

### Safety

Strong for the actual model integration because Python receives only a narrow completion capability.

- Do not expose Pi tools to Python or leaf prompts.
- Do not let Python request shell/file/network operations.
- Validate max number of LLM calls and max prompt chars per run.

### Testability

Excellent with fakes.

- Python fake bridge client can return deterministic responses.
- TS fake worker can simulate llm_request bursts.
- End-to-end tests can run with a fake `complete(...)` adapter.

### Latency

Good.

- Persistent worker avoids cold start.
- Direct `complete(...)` avoids nested Pi agent overhead.
- IPC per leaf is low.
- TS can eventually enforce concurrency around leaf calls if Python exposes batched requests.

### Maintenance

Medium-high.

- Less maintenance than a full TS port.
- More integration code than Python-direct CLI.
- Requires small, deliberate Python extension point for custom `BaseLM`.

### Verdict

Best target if “λ-RLM as a Pi tool” means “uses my current Pi model and behaves like a native Pi tool.”

## Option 5: Rewrite `lambda_rlm.py` in TypeScript

### Shape

Port only the λ-RLM deterministic runtime, not the normal RLM REPL.

Recommended TS module boundaries:

- `types.ts`
  - `TaskType`, `ComposeOp`, `LambdaPlan`, `UsageSummary`.
- `task-detection.ts`
  - Prompt, digit parsing.
- `planner.ts`
  - `plan(taskType, n, options)`.
- `split.ts`
  - Word-boundary split and peek.
- `prompts.ts`
  - Leaf templates.
- `executor.ts`
  - Async recursive `phi(text)`.
- `llm.ts`
  - `LeafModel` interface implemented by Pi `complete(...)`.
- `tool.ts`
  - Pi extension tool registration.

The executor should be regular TypeScript, not a JS code string run through a sandbox:

```ts
async function phi(text: string, depth: number): Promise<string> {
  if (text.length <= plan.tauStar) {
    return leafModel.complete(formatLeafPrompt(text));
  }

  let chunks = split(text, plan.kStar);
  if (plan.pipeline.useFilter && query) {
    chunks = await filterRelevant(query, chunks, leafModel);
  }

  const parts = await mapWithConcurrencyLimit(chunks, concurrency, (chunk) => phi(chunk, depth + 1));
  return reduce(parts, plan.composeOp, leafModel, query);
}
```

### Leaf LLM calls

Native Pi model calls via `@mariozechner/pi-ai` `complete(...)`.

This is the cleanest leaf-call story:

- Current selected model.
- Current auth and custom headers.
- `AbortSignal` propagation.
- Usage is already in Pi response objects.
- No Python provider mapping.

### Operational complexity

Medium.

Removes Python runtime/deps entirely but adds a porting project.

New implementation work:

- Recreate all enums/tables/templates.
- Recreate prompt parsing.
- Recreate cost/depth math exactly.
- Recreate split/filter/reduce semantics.
- Add concurrency, cancellation, and usage accumulation.
- Decide what to do with Python `RLMChatCompletion` compatibility.

### Safety

Best among all options if implemented without `eval`/sandbox.

- No Python `exec`.
- No Node `vm`.
- No model-generated code execution.
- Narrow LLM-only capability.
- Easier to audit.

### Testability

Best long-term, but initial parity tests are required.

Test plan:

- Golden tests comparing TS planner to Python planner for representative `n`, task types, context windows, accuracy targets.
- Split tests comparing chunk boundaries to Python `_split` behavior.
- Fake LLM tests for task detection, leaves, filters, reductions.
- End-to-end tests with deterministic fake LLM.
- Optional cross-language contract runner that invokes Python and TS for the same fixtures.

### Latency

Best long-term.

- No Python process startup.
- No LMHandler local socket.
- Direct TS function calls.
- Can implement leaf concurrency and batching carefully.
- Still dominated by provider latency for nontrivial runs.

### Maintenance

Worst if upstream λ-RLM evolves quickly.

Risks:

- Divergence from Python research implementation.
- Need to port bug fixes and new operators twice.
- Subtle behavior drift in prompts/splitting/reduction can affect quality.

Mitigations:

- Treat Python as reference and run parity tests in CI.
- Keep TS port small and domain-language-aligned.
- Avoid porting benchmark/data/provider code.

### Verdict

Best final architecture if λ-RLM should become deeply integrated and stable in Pi. Too much work for the first integration unless Python packaging is unacceptable.

## Option 6: Use JS/TS sandbox or REPL equivalents

This option means re-creating the Python `LocalREPL` idea in the Node/TS extension world.

### Key finding

λ-RLM does not need a sandbox/REPL for its current algorithm. The Python implementation uses `exec(...)` to run deterministic locally generated `_Phi` code, but the same behavior can be implemented as ordinary functions in TS. A JS sandbox only becomes necessary if Pi wants to support **normal RLM-style arbitrary generated code**, user-provided combinator scripts, or plugin-defined operators.

### Candidate runtimes

| Runtime | Status / fit | Safety | Complexity | Fit for λ-RLM |
|---|---|---|---|---|
| Node `vm` | Built-in JS contexts. Officially not a security mechanism for untrusted code. | Poor for untrusted code. | Low. | Avoid. Unnecessary. |
| `vm2` | Historically popular, but repeated escapes/deprecation/security issues. | Poor for attacker-controlled code. | Low-medium. | Avoid. |
| `isolated-vm` | V8 isolates with separate heaps and memory limits; native addon; maintenance-mode caveats. | Better in-process isolation, not OS boundary. | Medium-high. | Overkill for deterministic λ-RLM. Possible for plugin code. |
| SES/Endo | Hardened JS compartments, object-capability model, least authority. | Good for capability discipline, not resource/OS isolation. | Medium. | Interesting for plugin-defined pure operators, not needed now. |
| QuickJS/WASM | Separate JS engine in WASM; memory/interrupt/stack controls; TS requires transpilation. | Good isolation from Node APIs if capabilities are not exposed. | Medium-high. | Viable for arbitrary JS snippets; slower/complex for λ-RLM. |
| Deno subprocess | Secure-by-default permissions, TS-friendly, can run with no disk/net/env unless granted. | Better than Node default; subprocess boundary. | Medium. | Possible but another runtime; unnecessary for deterministic executor. |
| Containers/microVMs | Stronger OS/hypervisor boundary. | Best for hostile arbitrary code. | High. | Not justified for λ-RLM unless running untrusted generated code. |

### TypeScript execution/transpilation notes

If TS snippets ever must be executed dynamically:

- `ts-node` provides a TypeScript execution engine and REPL for Node, but it runs in Node's process and is not a sandbox.
- `tsx` is a convenient TS runner, also not a sandbox.
- `typescript.transpileModule(...)`, SWC, or esbuild can compile TS to JS before feeding it to an isolate/QuickJS runtime; type checking is separate and should not be confused with sandboxing.

### Verdict

Do not use a JS/TS REPL/sandbox as the primary λ-RLM integration. If dynamic JS execution is later required, prefer QuickJS/WASM, Deno subprocess, isolated-vm, or a microVM depending on threat model; do not rely on Node `vm` or `vm2` for security.

## Decision matrix

Scores: 1 = poor, 5 = excellent.

| Option | Time to first tool | Pi current model support | Ops simplicity | Safety | Testability | Latency | Maintenance |
|---|---:|---:|---:|---:|---:|---:|---:|
| Direct Python subprocess | 5 | 2 | 3 | 3 | 3 | 2 | 4 |
| Python CLI/JSON bridge | 4 | 2 | 4 | 3 | 5 | 2 | 5 |
| Persistent Python worker, Python providers | 3 | 2 | 3 | 3 | 4 | 4 | 4 |
| Persistent hybrid worker, TS leaf calls | 3 | 5 | 2 | 4 | 5 | 4 | 3 |
| Full TypeScript port | 2 | 5 | 5 after built | 5 | 5 | 5 | 2 |
| JS/TS sandbox/REPL | 2 | 4 | 2 | varies | 3 | 3 | 2 |

## Recommended implementation phases

### Phase 1: CLI bridge proof of concept

Goal: expose λ-RLM as a Pi tool quickly while preserving Python behavior.

Deliverables:

- Python module `rlm.pi_bridge` with strict JSON input/output.
- TS Pi extension tool `lambda_rlm` that spawns the CLI.
- Tool params:
  - `prompt` or `{ context, question }`.
  - `contextWindowChars`.
  - `backend` / `model` / `baseUrl` / `apiKeyEnv` or explicit `apiKey` if acceptable.
  - `accuracyTarget`, `aLeaf`, `aCompose`.
- Abort handling kills the child process.
- JSON error contract.
- Fake-LLM tests.

Do this first because it creates a stable seam for every later option.

### Phase 2: Persistent worker

Goal: remove cold-start overhead and prepare for Pi-native leaf calls.

Deliverables:

- `python -m rlm.pi_worker` NDJSON or length-prefixed protocol.
- Extension-side worker manager:
  - lazy start;
  - health check;
  - restart on crash;
  - shutdown on session shutdown;
  - one active run at a time initially.
- Progress events mapped to `onUpdate`.
- Cancellation protocol.

### Phase 3: Pi-current-model leaf bridge

Goal: allow λ-RLM leaves/reducers/filters to use the currently selected Pi model.

Deliverables:

- Python `BaseLM` bridge implementation.
- Minimal `LambdaRLM` constructor injection or `get_client("pi_bridge", ...)` hook.
- TS handler for `llm_request` that calls `complete(ctx.model!, ...)`.
- Usage aggregation in final tool `details`.
- Concurrency limit around leaf calls.

### Phase 4: Decide whether to port to TypeScript

Port only if at least one is true:

- Python setup is a major adoption blocker.
- λ-RLM becomes a commonly used Pi-native tool.
- Current Python implementation stabilizes enough that parity testing is cheap.
- There is a need for lower latency and tighter cancellation/concurrency control.

Do not port provider clients, benchmark loaders, or normal RLM REPL machinery.

## Suggested Pi tool API

A Pi tool should hide most backend details for common use but expose enough for research use.

Example schema concept:

```ts
parameters: Type.Object({
  prompt: Type.Optional(Type.String({ description: "Full prompt. If omitted, context/question are used." })),
  context: Type.Optional(Type.String({ description: "Long context to recursively process." })),
  question: Type.Optional(Type.String({ description: "Question/query for QA/extraction tasks." })),
  contextWindowChars: Type.Optional(Type.Number({ default: 100000 })),
  accuracyTarget: Type.Optional(Type.Number({ default: 0.8 })),
  leafProvider: StringEnum(["pi-current-model", "python-backend"] as const),
  pythonBackend: Type.Optional(Type.Object({
    backend: Type.Optional(Type.String({ default: "openai" })),
    modelName: Type.String(),
    baseUrl: Type.Optional(Type.String()),
    apiKeyEnv: Type.Optional(Type.String()),
  })),
})
```

Return `content` should contain the answer and a concise run summary. Return `details` should include structured data:

```ts
{
  response,
  plan,
  usage,
  executionTime,
  backendMode,
  leafCallCount,
  truncated: false
}
```

## Safety recommendations

Regardless of option:

- Keep λ-RLM executing only deterministic local control code; do not expose arbitrary code execution through the Pi tool.
- Put hard limits in the tool layer:
  - max input chars;
  - max `contextWindowChars` range;
  - max estimated leaves;
  - timeout;
  - max output chars;
  - optional max spend/calls if usage supports it.
- Treat provider API keys as secrets:
  - prefer env var names or Pi auth retrieval over raw key params;
  - avoid logging request JSON with secrets;
  - avoid command-line args containing secrets.
- For Python subprocess/worker:
  - run with minimal env;
  - set cwd deliberately;
  - kill process tree on abort;
  - keep stdout machine-readable and logs on stderr.
- Do not use Node `vm` or `vm2` as a security boundary.

## Test strategy

### Python reference tests

- Unit test `_parse_task_type`.
- Unit test `_plan` across task types and context lengths.
- Unit test split behavior through `_register_library` or extracted helper.
- Fake `BaseLM` end-to-end completion for short prompt and split prompt.

### Bridge/worker contract tests

- Valid request returns `ok: true` JSON.
- Invalid prompt type returns `ok: false` JSON.
- Provider error becomes structured JSON error.
- stderr logs do not corrupt stdout JSON.
- Abort cancels process/run.

### TypeScript extension tests

- Schema validation.
- Request construction.
- Output truncation.
- Worker restart.
- Fake `complete(...)` adapter for Pi-current-model leaf calls.

### TS port parity tests, if porting

- Compare TS `plan(...)` to Python `LambdaRLM._plan(...)` fixture outputs.
- Compare split chunks for fixed texts.
- Compare generated leaf/reducer prompts.
- Fake model end-to-end outputs for all task types.

## Open questions

1. Should the Pi tool default to the current Pi model, or to the Python README's NVIDIA/OpenAI-compatible backend? For Pi UX, default should be current Pi model once the bridge exists.
2. Is exact Python parity required, or is λ-RLM-as-Pi-tool allowed to improve concurrency and remove the REPL layer? This determines when a TS port is acceptable.
3. Should the Python package split runtime dependencies from benchmark/dev dependencies? This would materially improve subprocess/worker adoption.
4. How much run telemetry should be returned to the LLM versus stored in `details` only? The answer should be concise; plan/usage can live in details.
5. Do we need streaming partial answers? Current λ-RLM returns only final response; progress events are enough initially.

## Final recommendation

Build the integration in this order:

1. **Python CLI/JSON bridge + TS spawn tool** for a fast, testable baseline.
2. **Persistent Python worker** once repeated calls or cold-start latency matter.
3. **Hybrid TS leaf-call bridge** so λ-RLM can use Pi's current model/auth without reimplementing the algorithm.
4. **TypeScript port** only after the tool proves valuable and parity requirements are understood.

Do not spend effort on a JS/TS sandbox/REPL for λ-RLM itself. The safest and simplest Pi-native design is deterministic TS or Python control flow plus a narrow LLM completion capability, not dynamic code execution.
