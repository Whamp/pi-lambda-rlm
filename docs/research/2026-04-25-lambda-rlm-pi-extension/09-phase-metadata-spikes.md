# Phase Metadata Propagation Spikes

Date: 2026-04-25

## Purpose

Evaluate how Lambda-RLM model-call phase metadata should reach the TypeScript-owned leaf runner so callback requests can report whether a model call is task detection, filter, leaf, or reducer.

Prototype outputs live under:

```text
/tmp/pi-lambda-rlm-phase-spikes/
  A-contextvars/
  B-extend-lmrequest/
  C-wrapper-llm-functions/
  D-prompt-inference/
```

## Options compared

| Option | Result | Main issue | Score |
|---|---|---|---:|
| A. `contextvars` / thread-local metadata | Works for direct same-thread task detection; fails for REPL-originated calls | Metadata does not cross LocalREPL → LMHandler socket/thread boundary | 2/5 |
| B. Extend `LMRequest` / `LMHandler` metadata | Best explicit transport for REPL-originated calls | Task detection currently bypasses LMHandler; batch metadata left for later | 4/5 |
| C. Wrapper model-call functions | Good for semantic call-site organization | Cannot transport metadata without B or an envelope | 3/5 standalone |
| D. Prompt inference/envelope/template identity | Text inference poor; template identity good; envelopes risk leakage if string-based | Best as fallback/augment, not primary transport | 4/5 for template identity, 2/5 for regex inference |

## Key finding: context-local metadata is insufficient

`LambdaRLM.completion()` calls task detection directly in the main thread, so `contextvars` or thread-local phase state is visible there.

But leaf/filter/reducer calls go through:

```text
LocalREPL._llm_query()
  → send_lm_request(...)
  → TCP socket
  → LMHandler ThreadingTCPServer request thread
  → client.completion(request.prompt)
```

The callback client runs in a different request-handler thread and receives only the serialized `LMRequest`. Ambient Python metadata does not cross that boundary.

## Recommended design

Use explicit request metadata in the existing LocalREPL → LMHandler protocol, plus Lambda-RLM wrapper/helper call sites to populate semantic phase metadata.

### Protocol patch

Add optional metadata to `LMRequest`:

```python
@dataclass
class LMRequest:
    prompt: str | dict[str, Any] | None = None
    prompts: list[str | dict[str, Any]] | None = None
    model: str | None = None
    metadata: dict[str, Any] | None = None
    depth: int = 0
```

Add optional metadata to `LocalREPL._llm_query`:

```python
def _llm_query(
    self,
    prompt: str,
    model: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    request = LMRequest(prompt=prompt, model=model, metadata=metadata, depth=self.depth)
```

Preserve existing calls:

```python
llm_query(prompt)
llm_query(prompt, model)
```

### Client forwarding patch

Avoid changing the required `BaseLM.completion(prompt)` signature for all clients. Instead, let metadata-aware clients opt in:

```python
def _completion_with_optional_metadata(client: BaseLM, prompt, metadata):
    if metadata is not None and hasattr(client, "completion_with_metadata"):
        return client.completion_with_metadata(prompt, metadata)
    return client.completion(prompt)
```

The TypeScript callback adapter implements:

```python
class TypeScriptCallbackLM(BaseLM):
    def completion_with_metadata(self, prompt, metadata):
        # send Model Callback Request to TypeScript with prompt + metadata
```

### Lambda-RLM semantic wrappers

Use wrapper/helper functions in `lambda_rlm.py` to populate metadata at stable semantic call sites:

- task detection
- leaf prompt calls
- filter relevance calls
- reducer calls

Wrapper functions are not a standalone transport, but they keep generated Φ code and reducer/filter closures clean.

## Recommended metadata shape

Keep metadata primitive, additive, and non-secret:

```json
{
  "source": "lambda_rlm",
  "phase": "task_detection" | "execute_phi",
  "combinator": "classifier" | "leaf" | "filter" | "reduce",
  "promptKey": "tasks/qa.md",
  "taskType": "qa",
  "composeOp": "select_relevant",
  "chunkChars": 12345,
  "previewChars": 500,
  "partCount": 4,
  "depth": 1
}
```

Guidelines:

- Do not put raw context text, prompt text, or secrets in metadata.
- Add fields additively.
- Treat `source`, `phase`, and `combinator` as the most stable fields.
- Include `promptKey` so observability aligns with the Prompt File Tree.

## Task detection coverage

Task detection currently calls `client.completion(...)` directly. If every TypeScript Model Callback Request must include explicit metadata, route task detection through the same metadata-aware model-call helper rather than leaving it as a direct untagged call.

Options:

1. Add `completion_with_metadata` call directly for injected metadata-aware clients.
2. Route task detection through `repl._llm_query(..., metadata=...)` after LocalREPL exists.
3. Add a Lambda-RLM `_model_call(...)` helper that uses the best available metadata path.

The PRD should require task detection metadata, but implementation can choose the least invasive route in the local/forked patch.

## Avoided approaches

### Regex/text inference

Do not use rendered prompt text as the primary phase source. It breaks when prompts are overridden, localized, or rewritten.

Text inference may be a last-resort fallback only and must be labeled low confidence.

### String sentinel envelopes

String prefix sentinels can carry metadata without protocol changes, but they risk leaking metadata into the model if stripping fails.

Structured/dict envelopes are better than string sentinels, but adding `LMRequest.metadata` is cleaner and more explicit.

### Ambient contextvars/thread-local only

Works for direct same-thread calls, but silently fails for REPL-originated calls and would produce misleading partial observability.

## Recommended MVP acceptance

- Every Model Callback Request includes a request ID and metadata.
- Metadata includes at least `source`, `phase`, `combinator`, and `promptKey` where applicable.
- Leaf/filter/reducer metadata crosses the LocalREPL → LMHandler socket boundary through explicit `LMRequest.metadata`.
- Task detection is tagged explicitly, either through the same metadata path or an equivalent metadata-aware direct callback.
- Text inference is not required for normal operation.
- No phase metadata is injected into model-visible prompts.
