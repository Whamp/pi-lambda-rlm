# Local Lambda-RLM fork boundary

This directory vendors the upstream `rlm` package from
`https://github.com/lambda-calculus-LLM/lambda-RLM` at commit
`3874d393483dc4299101918cf8e9af670194bd88`.

The vendored upstream package is MIT licensed. Keep the upstream license notice
at `LICENSE` in this directory when updating, pruning, or replacing the vendored
boundary.

Intentional local patches:

## Issue #5: injected BaseLM client seam

1. `rlm.lambda_rlm.LambdaRLM.__init__(..., client: BaseLM | None = None)` stores
   an optional injected client.
2. `LambdaRLM.completion()` selects `self.client or get_client(self.backend,
   self.backend_kwargs)`, so injected offline tests avoid provider credentials
   while omitted-client behavior still delegates to the upstream client factory.
3. `rlm.clients.__init__` tolerates missing `python-dotenv` at import time. Provider
   clients remain lazily imported by `get_client`, preserving default behavior when
   provider dependencies and credentials are installed.

## Issue #12: explicit model-call metadata seam

1. `LMRequest` serialization/deserialization carries optional `metadata` across
   the LocalREPL -> LMHandler socket boundary.
2. `LocalREPL._llm_query(..., metadata=...)` forwards out-of-band model-call
   metadata without altering prompt text.
3. `LMHandler` calls `client.completion_with_metadata(prompt, metadata)` when a
   client opts in, and falls back to `client.completion(prompt)` for default clients.
4. `LambdaRLM` task detection, filter, leaf, and LLM-backed reducer call sites
   attach primitive metadata fields such as `source`, `phase`, `combinator`,
   `promptKey`, `taskType`, and `composeOp`.
5. `LambdaRLM.completion()` includes metadata documenting this patch boundary.

## Issue #13: compact progress telemetry seam

1. `LambdaRLM.__init__(..., progress_callback=...)` accepts an optional callback
   for source-free run telemetry.
2. `LambdaRLM.completion()` emits a deterministic `planned` progress payload after
   task detection and pure planning, before Φ execution starts.
3. The bridge converts progress callbacks into protocol `run_progress` messages;
   payloads contain compact plan numbers and enum values, not source text or
   prompt bodies.

Do not replace the real `LocalREPL`/`LMHandler` Lambda-RLM execution path with a
simplified direct recursive executor. Tests under `tests/python/` assert that
filter, leaf, and reducer calls flow through `LocalREPL`/`LMHandler`.
