# lambda-RLM Python internals research

Date: 2026-04-25  
Scope: source inspection of `lambda-RLM/README.md`, `pyproject.toml`, `rlm/lambda_rlm.py`, `rlm/environments/local_repl.py`, `rlm/core/lm_handler.py`, `rlm/core/types.py`, `rlm/clients/*.py`, `rlm/core/rlm.py`, `rlm/core/comms_utils.py`, `rlm/environments/base_env.py`, `rlm/utils/parsing.py`, and `benchmarks/benchmark.py`.

## Executive summary

`lambda-RLM` contains two related systems:

1. **Normal RLM** (`rlm/core/rlm.py`): an upstream-style recursive language model loop. The root LLM sees metadata about context stored in a REPL, emits ```repl code blocks, the environment executes them, and the loop stops when `FINAL(...)` or `FINAL_VAR(...)` is found or when iteration/limit handling falls through.
2. **LambdaRLM** (`rlm/lambda_rlm.py`): a deterministic wrapper that avoids LLM-generated control code. It stores the input in `LocalREPL`, asks the LLM once to classify the task, computes a plan in Python, injects fixed combinators into the REPL, and executes a generated but deterministic recursive Python function `_Phi` over `context_0`. Neural calls happen at leaves and, for some task types, during filter/reduce combinators.

The most reusable pieces are the **`BaseLM` client abstraction**, **OpenAI-compatible client**, **usage/result dataclasses**, **`LMHandler` socket bridge**, and LambdaRLM’s **task/planning/combinator tables**. The riskiest pieces are **`LocalREPL` as a security boundary**, provider-configuration inconsistencies, LambdaRLM’s hard-coded use of `LocalREPL`, error-as-string propagation from `llm_query`, non-token-aware chunk planning, and the absence of budget/timeout/retry/progress controls in LambdaRLM.

## Public API surface

### Package exports

`rlm/__init__.py` exports:

- `RLM`
- `LambdaRLM`
- `LambdaPlan`
- `TaskType`
- `ComposeOp`
- Limit/cancellation exceptions: `BudgetExceededError`, `TimeoutExceededError`, `TokenLimitExceededError`, `ErrorThresholdExceededError`, `CancellationError`

### `LambdaRLM`

Constructor parameters in `rlm/lambda_rlm.py`:

```python
LambdaRLM(
    backend="openai",
    backend_kwargs=None,
    environment="local",
    environment_kwargs=None,
    context_window_chars=100_000,
    accuracy_target=0.80,
    a_leaf=0.95,
    a_compose=0.90,
    query=None,
    verbose=False,
    logger=None,
)
```

Primary method:

```python
completion(prompt: str) -> RLMChatCompletion
```

Important API behavior:

- `prompt` must be a `str`; non-string prompts raise `TypeError`.
- `environment` is accepted but **not actually routed through `get_environment`**; LambdaRLM always instantiates `LocalREPL` directly.
- `query` can be supplied explicitly. If absent, LambdaRLM tries to extract a benchmark-style `Question:` segment from prompts shaped as:
  ```text
  Context:
  ...

  Question: ...

  Answer:
  ```
- The returned `RLMChatCompletion` does **not** include the computed `LambdaPlan` or execution tree in metadata.

### `RLM`

`RLM` is the Normal RLM loop. It supports:

- multiple environment types via `get_environment`: `local`, `docker`, `modal`, `prime`, `daytona`, `e2b`
- max recursion depth and max iterations
- budget, timeout, token, and consecutive-error limits
- custom tools injected into the REPL
- persistent local sessions
- compaction of long root-model histories
- callbacks for subcall and iteration events
- optional logger metadata trajectory

Primary method:

```python
completion(prompt: str | dict[str, Any], root_prompt: str | None = None) -> RLMChatCompletion
```

Caveat: if `self.depth >= self.max_depth`, `RLM.completion()` returns `_fallback_answer()`, which is a raw `str` despite the method annotation. Normal top-level usage usually avoids this by using `max_depth >= 1`.

## LambdaRLM execution/data flow

High-level flow:

```text
User prompt
  │
  ▼
LambdaRLM.completion(prompt)
  │
  ├─ Parse benchmark prompt into:
  │    - context_text: document/context to split recursively
  │    - effective_query: explicit query or extracted Question
  │
  ├─ get_client(backend, backend_kwargs)
  │
  ├─ with LMHandler(client) as local socket server
  │
  ├─ LocalREPL(
  │     lm_handler_address=handler.address,
  │     context_payload=context_text,
  │     depth=1,
  │   )
  │    └─ stores context as REPL locals: context_0 and context
  │
  ├─ Phase 2 task detection
  │    └─ direct client.completion(digit-menu prompt over metadata)
  │
  ├─ Phase 3 planning
  │    └─ pure Python _plan(task_type, len(context_0))
  │
  ├─ Phase 5 register fixed library
  │    └─ inject _Split, _Peek, _Reduce, _FilterRelevant into repl.globals
  │
  ├─ Build deterministic Python code for _Phi(P)
  │
  ├─ repl.execute_code(phi_code)
  │    └─ _Phi(context_0)
  │        ├─ if len(P) <= tau*: leaf llm_query(template(P, query?))
  │        └─ else _Split → optional _FilterRelevant → map _Phi → _Reduce
  │
  └─ return RLMChatCompletion(response=repl.locals["lambda_rlm_result"])
```

Key data movement decisions:

- The full input context is initially stored in the REPL, not in the root LLM prompt.
- Task detection only sees a metadata string: total length, query preview, and a short preview of the context.
- Leaf LLM calls do receive chunks of the original text.
- LLM-backed reduce calls receive partial outputs, not original full context.
- All `llm_query` calls from `_Phi` go through the local `LMHandler` socket to the same `BaseLM` client object used for task detection.

## Task detection

Task detection is one direct LLM completion using `_TASK_DETECTION_PROMPT`. The prompt asks for a single digit mapping to:

| Digit | `TaskType` |
|---:|---|
| 1 | `summarization` |
| 2 | `qa` |
| 3 | `translation` |
| 4 | `classification` |
| 5 | `extraction` |
| 6 | `analysis` |
| 7 | `general` |

The parser scans the response for the first digit and maps it through `_TASK_DIGIT_MAP`; if no digit is found, the task falls back to `TaskType.GENERAL`.

Risks:

- The detection LLM sees only metadata/preview, so task classification can be wrong for mixed prompts.
- Any digit in an otherwise non-compliant response will be accepted.
- Detection failures from the provider propagate as exceptions; malformed detection text usually falls back to `general`.

## Planning and combinators

### Task-to-plan tables

`TaskType` determines both the composition operator and whether the pipeline uses an LLM relevance filter.

| Task type | Compose op | Filter before map? | Leaf prompt behavior |
|---|---|---:|---|
| `summarization` | `MERGE_SUMMARIES` | no | summarize chunk |
| `qa` | `SELECT_RELEVANT` | yes, if query exists | answer query from chunk |
| `translation` | `CONCATENATE` | no | translate chunk |
| `classification` | `MAJORITY_VOTE` | no | classify chunk |
| `extraction` | `MERGE_EXTRACTIONS` | yes, if query exists | extract all key information from chunk |
| `analysis` | `COMBINE_ANALYSIS` | no | analyze chunk |
| `general` | `MERGE_SUMMARIES` | no | process chunk generally |

Notable detail: extraction uses the query for relevance filtering, but the extraction leaf template is generic (`"Extract all key information from..."`) and does not include the query.

### Plan fields

`LambdaPlan` contains:

- `task_type`
- `compose_op`
- `pipeline`
- `k_star`: branching factor
- `tau_star`: leaf chunk-size threshold in characters
- `depth`: planned recursion depth
- `cost_estimate`: relative estimated cost
- `n`: input length in characters

### Planning formulas

Let `K = context_window_chars`, `n = len(context_text)`, `C_IN = 1.0`, and `c_compose = C_COMPOSE[compose_op]`.

If `n <= K`:

- `k_star = 1`
- `tau_star = n`
- `depth = 0`
- `cost_estimate = n + 500`

If `n > K`:

- for LLM-backed composition (`c_compose > 0.1`):
  ```python
  k_star = min(20, max(2, ceil(sqrt(n * C_IN / c_compose))))
  ```
- for near-free composition:
  ```python
  k_star = min(20, max(2, ceil(n / K)))
  ```
- planned depth:
  ```python
  d = max(1, ceil(log(n / K) / log(k_star)))
  ```
- an accuracy loop may increase `k_star` while:
  ```python
  (a_leaf ** d) * (a_compose ** d) < accuracy_target
  ```
- `tau_star = min(K, max(1, n // k_star))`
- cost estimate:
  ```python
  (k_star ** d) * C_IN * tau_star + d * c_compose * k_star + 500
  ```

Planning caveats:

- The planning unit is **characters**, not model tokens.
- Prompt-template overhead, query length, output length, filter calls, and reduce-prompt lengths are not fully modeled.
- For inputs only slightly larger than `K`, LLM-backed composition can still choose `k_star = 20`, creating many small leaves where two chunks may have sufficed.
- `k_star` is initially capped at 20, but the later accuracy loop can increase it beyond 20 if `max_k = n // K` is larger.
- `context_window_chars` is treated as a leaf text threshold; it is not an enforced provider context limit.

### Runtime combinators

`_register_library()` injects the fixed combinator library into `LocalREPL.globals`:

- `_Peek(text, start, length)`: slice a preview.
- `_Split(text, k)`: character-based split into up to `k` chunks, with a best-effort snap to a space near each boundary.
- `_FilterRelevant(query, items)`: for QA/extraction pipelines, sequentially asks the LLM `YES`/`NO` for each chunk preview. If no chunks pass, it falls back to keeping all chunks.
- `_Reduce(parts)`: selected by `compose_op`:
  - `CONCATENATE`: deterministic ordered join.
  - `MERGE_SUMMARIES`: one LLM call to merge partial summaries when more than one part exists.
  - `SELECT_RELEVANT`: drop obvious “not found” partial answers, then one LLM synthesis call when more than one candidate exists.
  - `MAJORITY_VOTE`: deterministic case-insensitive frequency count.
  - `MERGE_EXTRACTIONS`: deterministic line de-duplication preserving first occurrence.
  - `COMBINE_ANALYSIS`: one LLM call to combine partial analyses when more than one part exists.

`_build_phi_code()` then generates deterministic Python source equivalent to:

```python
def _Phi(P):
    if len(P) <= tau_star:
        return llm_query(leaf_template.format(text=P, query=query?))
    else:
        chunks = _Split(P, k_star)
        if use_filter and query:
            chunks = _FilterRelevant(query, [(chunk, _Peek(chunk, 0, peek_len)) ...])
        return _Reduce([_Phi(c) for c in chunks])

lambda_rlm_result = _Phi(context_0)
```

The function is executed in the REPL using `exec()`. The generated function name `_Phi` is intentionally not persisted to `repl.locals`; only `lambda_rlm_result` is saved.

## How LLM calls are made

### Client selection

`rlm/clients/__init__.py` exposes `get_client(backend, backend_kwargs)`.

Supported backend strings:

- `openai`
- `vllm` (OpenAI-compatible; requires `base_url`)
- `portkey`
- `openrouter` (OpenAI-compatible; default base URL `https://openrouter.ai/api/v1`)
- `vercel` (OpenAI-compatible; default base URL `https://ai-gateway.vercel.sh/v1`)
- `litellm`
- `anthropic`
- `gemini`
- `azure_openai`

The common client interface is `BaseLM`:

```python
completion(prompt: str | dict/list messages) -> str
acompletion(prompt: str | dict/list messages) -> str
get_usage_summary() -> UsageSummary
get_last_usage() -> ModelUsageSummary
```

### Direct calls vs REPL calls

LambdaRLM uses two call paths:

1. **Task detection**: direct `client.completion(prompt)`. This bypasses `LMHandler` but still updates the same client’s usage counters.
2. **Leaf/filter/reduce calls from `_Phi`**: `LocalREPL.llm_query()` sends an `LMRequest` to `LMHandler` over localhost TCP. `LMHandler` calls `client.completion()` and returns an `RLMChatCompletion` inside an `LMResponse`.

Socket protocol details:

- TCP server: `ThreadingTCPServer` on `127.0.0.1`, auto-assigned port by default.
- Serialization: JSON with a 4-byte big-endian length prefix.
- Single request fields: `prompt`, optional `model`, `depth`.
- Batched request fields: `prompts`, optional `model`, `depth`.
- Socket timeout default: 300 seconds.
- LM API timeout default: 300 seconds via `BaseLM.DEFAULT_TIMEOUT`.

### Provider-specific notes

| Client | SDK | Env/default key behavior | Generation kwargs behavior |
|---|---|---|---|
| `OpenAIClient` | `openai` | Uses `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `PRIME_API_KEY`, or `NVIDIA_API_KEY` depending on exact `base_url`. | Forwards `temperature`, `top_p`, `max_tokens`, `stream` to chat completions; other kwargs go to `OpenAI()` constructor. |
| `AzureOpenAIClient` | `openai.AzureOpenAI` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`. | Does not forward common generation kwargs in the current implementation. |
| `AnthropicClient` | `anthropic` | Requires `api_key` argument. | Supports `max_tokens`; does not forward arbitrary sampling kwargs. |
| `GeminiClient` | `google-genai` | Uses `GEMINI_API_KEY` or requires `api_key`. | Handles system instructions; does not forward arbitrary generation kwargs. |
| `PortkeyClient` | `portkey-ai` | Requires `api_key` argument. | Minimal chat completion call; does not forward arbitrary sampling kwargs. |
| `LiteLLMClient` | `litellm` | Uses explicit `api_key`/`api_base` if supplied; LiteLLM may also use its own env vars. | Current `pyproject.toml` does not list `litellm` as a dependency. |

OpenAI streaming behavior:

- If `stream=True`, `OpenAIClient` collects chunks and discards `reasoning_content`, returning only final `delta.content`.
- Usage tracking during streaming depends on usage data appearing in stream chunks. The client does not explicitly set OpenAI `stream_options={"include_usage": True}`.
- Streaming cost is recorded as `None` unless usage/cost details are available.

## `LocalREPL` internals

`LocalREPL` is a persistent Python namespace with helper functions and context variables.

### Context loading

- Constructor receives `context_payload` as `str`, `dict`, or `list`.
- String payloads are written to a temp file and loaded into `context_0` with `open(...).read()`.
- Dict/list payloads are written as JSON and loaded with `json.load()`.
- `context_0` is aliased to `context` for compatibility.
- Additional contexts can be added as `context_1`, `context_2`, etc.

### Namespace and helpers

`setup()` creates:

- `globals` with `_SAFE_BUILTINS`, `__name__`, and helper functions.
- `locals` for persistent variables.

Injected helpers:

- `FINAL_VAR(name_or_value)`: records and returns a final answer.
- `SHOW_VARS()`: lists non-internal locals.
- `llm_query(prompt, model=None)`: single direct LM completion via `LMHandler`.
- `llm_query_batched(prompts, model=None)`: batched direct completions via `LMHandler`.
- `rlm_query(prompt, model=None)`: recursive RLM subcall if `subcall_fn` is configured; otherwise falls back to `llm_query`.
- `rlm_query_batched(...)`: sequential recursive subcalls or fallback batched LM calls.

### Execution model

`execute_code(code)`:

1. Clears pending LLM calls.
2. Captures stdout/stderr under a thread lock.
3. Temporarily changes cwd to the REPL temp directory.
4. Builds `combined = {**globals, **locals}`.
5. Executes `exec(code, combined, combined)`.
6. Saves new non-global, non-underscore names back into `self.locals`.
7. Restores reserved scaffold names such as `llm_query`, `FINAL_VAR`, `context`, and `history`.
8. Returns a `REPLResult` containing stdout, stderr, locals copy, execution time, nested RLM/LLM calls, and optional `final_answer`.

Security caveat: `_SAFE_BUILTINS` blocks `eval`, `exec`, `compile`, `input`, `globals`, and `locals`, but it still exposes `__import__` and `open`. Code can import modules and access the filesystem from the host process. This is **not a strong sandbox**.

## `LMHandler` internals

`LMHandler` wraps one default `BaseLM` client and optionally one secondary backend client. It starts a localhost threaded TCP server.

Routing logic:

- If request specifies a registered `model`, use that client.
- Else if `depth == 1` and `other_backend_client` exists, use the secondary client.
- Else use the default client.

Single request handling:

- Calls `client.completion(request.prompt)`.
- Reads `client.get_last_usage()`.
- Returns an `RLMChatCompletion` with prompt, response, model usage, and elapsed time.

Batched request handling:

- Uses `client.acompletion()` concurrently with an asyncio semaphore.
- Default max concurrent batched calls: 16.
- A failure in one async call can fail the whole gathered batch through the outer exception path.

Usage summary:

- `LMHandler.get_usage_summary()` merges summaries from default, secondary, and registered clients by model name.
- The default client is also registered, so it is visited twice, but the same model key is overwritten rather than double-counted.

## Normal RLM execution flow

Normal `RLM` is useful for comparison because LambdaRLM is explicitly replacing this open-ended loop.

High-level flow:

```text
RLM.completion(prompt)
  │
  ├─ If depth >= max_depth: direct LM fallback
  │
  ├─ Spawn LMHandler and environment
  │    └─ environment stores prompt as context_0/context
  │
  ├─ Build system prompt with QueryMetadata
  │
  ├─ for i in range(max_iterations):
  │    ├─ root LLM completion over message history
  │    ├─ parse ```repl blocks
  │    ├─ environment.execute_code(each block)
  │    ├─ check budget/token/error/timeout limits
  │    ├─ find FINAL_VAR or FINAL
  │    ├─ if final: return RLMChatCompletion
  │    └─ append formatted code/result messages to history
  │
  └─ if no final answer: ask root model for a final answer
```

Normal RLM has richer operational controls than LambdaRLM: budget, timeout, token, max errors, compaction, persistence, logging, callbacks, and recursive child RLMs. It also lets the model generate arbitrary REPL control code, which is the main behavior LambdaRLM is designed to avoid.

## Dependencies, configuration, and environment variables

### Packaging

`pyproject.toml` declares:

- package name: `lambda-rlm`
- Python: `>=3.11`
- packages: `rlm`, `rlm.*`, `benchmarks`, `benchmarks.*`
- runtime dependencies:
  - `anthropic>=0.75.0`
  - `google-genai>=1.56.0`
  - `openai>=2.14.0`
  - `portkey-ai>=2.1.0`
  - `python-dotenv>=1.2.1`
  - `requests>=2.32.5`
  - `rich>=13.0.0`
  - `datasets>=2.21.0`
  - `numpy>=1.26.0`
  - `matplotlib>=3.8.0`
  - `pre-commit>=4.5.1`
  - `ruff>=0.14.10`

Dependency gap: the `litellm` client imports `litellm`, but `pyproject.toml` does not list `litellm`.

### Environment variables observed in code

| Variable | Used by |
|---|---|
| `OPENAI_API_KEY` | OpenAI default endpoint |
| `OPENROUTER_API_KEY` | OpenRouter OpenAI-compatible endpoint |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway endpoint |
| `PRIME_API_KEY` | Prime Intellect endpoint |
| `NVIDIA_API_KEY` | NVIDIA NIM OpenAI-compatible endpoint |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI |
| `AZURE_OPENAI_API_VERSION` | Azure OpenAI; default `2024-02-01` |
| `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI |
| `GEMINI_API_KEY` | Gemini |

README mentions `TOGETHER_API_KEY`, but the code does not automatically read it. Together-style usage would need explicit `backend_kwargs={"api_key": ..., "base_url": ...}`.

### Benchmark CLI configuration

`benchmarks/benchmark.py` defaults:

- `--backend openai`
- `--model qwen/qwen3-next-80b-a3b-thinking`
- `--base-url https://integrate.api.nvidia.com/v1`
- `--context-window 100000`
- `--max-depth 2` for Normal RLM
- `--max-iter 10` for Normal RLM
- `--methods rlm lambda_rlm`

If `--api-key` is absent:

- if base URL contains `nvidia`, uses `NVIDIA_API_KEY`
- otherwise uses `OPENAI_API_KEY`

Benchmark `backend_kwargs` include:

```python
{
    "model_name": args.model,
    "temperature": 0.6,
    "top_p": 0.7,
    "max_tokens": 4096,
    "stream": True,
    "api_key": api_key?,
    "base_url": base_url?,
}
```

## Result shape

### `RLMChatCompletion`

Both `RLM` and `LambdaRLM` intend to return `RLMChatCompletion`:

```python
@dataclass
class RLMChatCompletion:
    root_model: str
    prompt: str | dict[str, Any]
    response: str
    usage_summary: UsageSummary
    execution_time: float
    metadata: dict | None = None
```

`to_dict()` serializes root model, prompt, response, usage, execution time, and metadata if present.

### `UsageSummary`

```python
@dataclass
class UsageSummary:
    model_usage_summaries: dict[str, ModelUsageSummary]
```

Aggregates:

- `total_cost`: sum of non-`None` model costs, or `None`
- `total_input_tokens`
- `total_output_tokens`

`ModelUsageSummary` contains:

- `total_calls`
- `total_input_tokens`
- `total_output_tokens`
- optional `total_cost`

### `REPLResult`

`LocalREPL.execute_code()` returns:

- `stdout`
- `stderr`
- `locals`
- `execution_time`
- `rlm_calls`: nested `RLMChatCompletion` records from helper calls
- `final_answer`: set by `FINAL_VAR`

### Benchmark outputs

`benchmark.py` wraps each run as:

```python
@dataclass
class Result:
    dataset: str
    idx: int
    bin_label: str
    method: str
    prediction: str
    gold: str
    f1: float
    contains: float
    exact: float
    latency: float
    error: str | None = None
```

It writes:

- `results.json`: per-sample records
- `stats.json`: per dataset/method/bin aggregate records
- `averages.json`: macro averages across non-empty buckets
- optional plots under `plots/` if `matplotlib`/`numpy` are available

## Failure modes and edge cases

### LambdaRLM-specific

- **Non-string prompt**: raises `TypeError`.
- **Provider/API configuration**: missing model name or API key can raise from the client SDK.
- **Task misclassification**: detection sees only metadata and accepts the first digit.
- **Environment argument ignored**: `environment="docker"` or similar has no effect in LambdaRLM.
- **`environment_kwargs` can override core values**: kwargs are applied after `lm_handler_address`, `context_payload`, and `depth`; accidental overrides can break execution.
- **No LambdaRLM budget/timeout/token controls**: unlike Normal RLM, LambdaRLM does not expose max budget, max timeout, max token, max errors, retries, cancellation, or progress callbacks.
- **No batching in `_Phi`**: even though `llm_query_batched` exists, leaves and filters run serially through list comprehensions/loops.
- **Error strings as data**: `LocalREPL._llm_query()` catches socket/handler failures and returns strings like `"Error: ..."`; LambdaRLM may then merge or return those strings unless the Python execution itself writes stderr.
- **Context window is approximate**: chunk size is character-based and ignores tokenization, template overhead, query text, and reduce prompt size.
- **Reduce calls may exceed context**: merging many large partial outputs is not bounded by the same `tau_star` leaf threshold.
- **Filter calls may dominate cost**: QA/extraction filter one preview per child at every non-leaf node.
- **Extraction query is not in leaf template**: only relevance filtering sees the query.
- **Planning can over-fan-out**: for LLM-backed composition, a slightly-over-window input can produce `k_star=20` due the square-root formula plus cap.
- **No plan in result**: callers cannot inspect chosen task, `k_star`, depth, or estimated cost without modifying/wrapping internals.
- **Recursion depth**: module sets `sys.setrecursionlimit(5000)`, but very deep or pathological recursion can still fail.

### LocalREPL/security

- **Not a secure sandbox**: `__import__` and `open` are available; code runs in-process with access to host Python modules and filesystem.
- **`input`, `eval`, `exec`, `compile` are set to `None`**, but this is not enough to isolate untrusted code.
- **Thread-safety is limited**: stdout/stderr capture uses a lock, but the REPL namespace itself is mutable shared state.
- **Cleanup is best-effort**: temp directory cleanup exceptions are swallowed.

### LMHandler/client

- **No retry layer** around provider calls.
- **Socket timeout and provider timeout default to 300s**, but long recursive runs can exceed user expectations.
- **Batched failure behavior** can fail the whole batch if one async call raises.
- **Usage assumptions**: several clients assume usage metadata exists; if a provider omits usage, token tracking can raise or record zeros.
- **Provider kwargs are inconsistent** across clients; OpenAI forwards common generation kwargs, while most others do not.
- **`litellm` dependency missing** from packaging.

### Normal RLM

- **Model-generated arbitrary code** is the core risk. It can import modules, open files, and run host-process Python unless a stronger environment is used.
- **Final-answer detection can miss malformed final markers** and then continue until `max_iterations`.
- **Timeout checks occur before iterations**, not as an interrupt around provider calls or code execution.
- **Budget/token checks occur after iterations**, so a single expensive iteration can overshoot.
- **Fallback return type at max depth** is a raw string, not `RLMChatCompletion`.

### Benchmarking

- **Errors are swallowed into result records**: `run_sample()` catches exceptions, stores `error=str(e)`, and scores an empty prediction.
- **Metrics are simple lexical checks**: F1 uses set overlap after normalization, so repeated-token counts and semantic equivalence are ignored.
- **Dataset availability is external**: LongBench-v2 requires `datasets`; S-NIAH fetch requires `requests` unless local path is supplied.
- **Benchmark defaults are NVIDIA/OpenAI-centric**: automatic key lookup only chooses `NVIDIA_API_KEY` or `OPENAI_API_KEY`.

## Reusable pieces for a Pi extension

Good candidates to reuse directly or adapt:

1. **`RLMChatCompletion`, `UsageSummary`, `ModelUsageSummary`**  
   Clean result/usage shapes that can be adapted into Pi-side run metadata.

2. **`BaseLM` interface and `OpenAIClient`**  
   Useful if the extension needs a simple provider abstraction. For deeper Pi integration, consider implementing a `BaseLM` adapter that calls Pi’s existing model/provider layer instead of directly using SDK clients.

3. **`LMHandler` socket bridge**  
   Useful pattern for allowing REPL/tool code to call back into an LLM client without embedding client objects into the executed code. Keep it localhost-only; it has no authentication.

4. **Lambda task/planning/composition tables**  
   The enums and maps are compact and easy to port. They provide clear domain language for task type, compose operator, pipeline flags, and leaf templates.

5. **Deterministic combinator executor design**  
   The `Split → Filter? → Map(Φ) → Reduce` shape is the core reusable idea. It could be reimplemented without `exec()` and without `LocalREPL` if a Pi extension wants safer execution and better observability.

6. **Benchmark loaders and result aggregation**  
   Useful for repeatable comparisons, though the loaders depend on external datasets/network access.

## Risky pieces for a Pi extension

Use caution or replace these:

1. **`LocalREPL` as sandbox**  
   It is suitable for trusted deterministic code, not untrusted model-generated or user-provided code. A Pi extension should prefer process/container isolation for arbitrary code.

2. **Hard-coded LocalREPL in LambdaRLM**  
   The `environment` argument is misleading. If Pi needs remote/container execution, LambdaRLM will need refactoring.

3. **Generated Python via `exec()`**  
   LambdaRLM’s generated `_Phi` is deterministic, but a direct Python implementation would be easier to trace, test, and secure.

4. **No execution trace**  
   Pi UI likely needs progress, selected task, plan, node counts, leaf prompts, and errors. Current LambdaRLM only returns final text and usage.

5. **No budget/time/retry policy in LambdaRLM**  
   Long recursive runs can make many provider calls. Pi integration should add per-run budgets, cancellation, retries/backoff, and progress events.

6. **Token/context mismatch**  
   Planning in characters will be fragile across models and languages. A Pi extension should use token-aware splitting where possible.

7. **Serial leaf/filter execution**  
   The fixed executor leaves performance on the table. Batched or bounded-concurrency execution would matter for large contexts.

8. **Provider configuration drift**  
   README mentions Together, code recognizes NVIDIA/OpenAI-compatible endpoints only through explicit kwargs, and non-OpenAI clients ignore many sampling kwargs. A Pi extension should normalize provider config centrally.

## Practical integration notes

If using this code as-is:

```python
from rlm import LambdaRLM

rlm = LambdaRLM(
    backend="openai",
    backend_kwargs={
        "model_name": "meta/llama-3.3-70b-instruct",
        "api_key": "...",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "temperature": 0.6,
        "top_p": 0.7,
        "max_tokens": 4096,
        "stream": True,
    },
    context_window_chars=100_000,
)
result = rlm.completion("Context:\n...\n\nQuestion: ...\n\nAnswer:")
print(result.response)
```

For a robust Pi extension, prefer wrapping or refactoring to expose:

- task detection result
- computed `LambdaPlan`
- node/leaf/reduce/filter call counts
- streamed progress events
- cancellation hooks
- provider retries and budget checks
- token-aware chunking
- final response plus provenance/trace metadata

## Bottom line

LambdaRLM’s core architectural value is the **deterministic typed recursive executor**: detect task, compute a bounded plan, and apply fixed combinators instead of letting the LLM generate arbitrary recursive control code. The current implementation proves that idea in a compact Python package, but it is research-grade: integration code should harden sandboxing, provider configuration, observability, cancellation, token accounting, batching, and error handling before exposing it as a dependable Pi extension feature.
