# Adapter Prototype Comparison: Python Lambda-RLM to TypeScript-Owned Leaf Runner

Date: 2026-04-25

## Purpose

Compare four adapter strategies for letting the Pi extension own child `pi -p` leaf starts while the Python Lambda-RLM executor requests completions through a `BaseLM`-compatible callback.

Prototype outputs live under:

```text
/tmp/pi-lambda-rlm-adapter-spikes/
  A-monkeypatch/
  B-subclass/
  C-client-injection/
  D-fake-backend/
```

## Current upstream seam

`lambda-RLM/rlm/lambda_rlm.py` imports and calls `get_client` directly:

```python
from rlm.clients import BaseLM, get_client
...
client: BaseLM = get_client(self.backend, self.backend_kwargs)
```

That `client` is then used both for direct task detection and for REPL-originated `llm_query()` calls via `LMHandler(client)`.

Therefore, any strategy that supplies a custom `BaseLM` before `LMHandler(client)` can route task detection, leaves, filters, and LLM-backed reducers to a TypeScript-owned callback.

## Options compared

| Option | Prototype result | Upstream modification | Coupling risk | Key surprise | Score |
|---|---|---:|---:|---|---:|
| A. Monkeypatch `rlm.lambda_rlm.get_client` | Works; all task/leaf/filter/reduce calls routed to fake callback client | None | Medium | Must patch `rlm.lambda_rlm.get_client`, not `rlm.clients.get_client` after import | 3/5 |
| B. Subclass `LambdaRLM` and override `completion()` | Works | None | High | Requires copying most of upstream `completion()` just to change client construction | 3/5 |
| C. Add optional `client: BaseLM` injection | Patch applies cleanly; demo works | Small local/upstream patch | Low | Existing `BaseLM` abstraction is already enough | 4/5 |
| D. Fake backend registration/get_client hook | Unknown fake backend fails; patching `rlm.clients.get_client` after import fails; patching `rlm.lambda_rlm.get_client` works | None if monkeypatching; otherwise registry patch needed | Medium-high | Fake backend degenerates into option A unless upstream adds a registry | 3/5 |

## Evidence by option

### A. Bridge-local monkeypatch

Prototype:

```bash
PYTHONPATH=lambda-RLM python /tmp/pi-lambda-rlm-adapter-spikes/A-monkeypatch/prototype_monkeypatch.py
```

Observed:

- Summarization route used fake callback for task detection, many leaf calls, and reduce calls.
- QA route used fake callback for task detection, filter calls, leaf calls, and reduce calls.
- No real provider calls were made.

Implications:

- Viable no-upstream-change MVP seam.
- Process-global monkeypatch needs process isolation or careful lifecycle control.
- If the bridge runs one Lambda-RLM run per Python process, the global patch risk is much lower.
- Import/bootstrap dependency issues still exist; Lambda-RLM deps must be installed or diagnosed.

### B. Subclass override

Prototype:

```bash
PYTHONPATH=lambda-RLM python /tmp/pi-lambda-rlm-adapter-spikes/B-subclass/prototype.py
```

Observed:

- Injected fake callback sees task detection and leaf calls.
- Works without modifying upstream.

Implications:

- Avoids monkeypatching but duplicates most of `LambdaRLM.completion()`.
- High drift risk if upstream changes prompt parsing, planning orchestration, result extraction, or metadata behavior.
- Poor fit for a maintainable Pi extension unless upstream exposes a tiny factory method.

### C. Optional client injection

Patch:

```text
/tmp/pi-lambda-rlm-adapter-spikes/C-client-injection/lambda_rlm_client_injection.patch
```

Patch check:

```bash
cd /home/will/projects/pi-lambda-rlm/lambda-RLM \
  && git apply --check /tmp/pi-lambda-rlm-adapter-spikes/C-client-injection/lambda_rlm_client_injection.patch
```

Observed demo:

- Fake injected `BaseLM` handles task detection and leaf call.
- Existing behavior remains unchanged when no client is provided.

Implications:

- Cleanest strategic seam.
- Smallest change: constructor param, stored attribute, one client-selection expression.
- Keeps Pi/TypeScript details out of Lambda-RLM by depending only on existing `BaseLM` abstraction.
- Requires carrying a local patch or upstreaming it.

### D. Fake backend registration

Prototype:

```bash
python /tmp/pi-lambda-rlm-adapter-spikes/D-fake-backend/fake_backend_spike.py
```

Observed:

- `backend="typescript_callback"` reaches runtime but upstream `get_client` rejects it.
- Patching `rlm.clients.get_client` after `rlm.lambda_rlm` import does not work.
- Patching `rlm.lambda_rlm.get_client` works, which is option A.

Implications:

- Fake backend is not a distinct no-modification path today.
- A real backend registry would be an upstream feature.
- Static `ClientBackend` Literal adds type/documentation friction for fake backend names.

## Cross-cutting findings

### Existing `BaseLM` abstraction is the right semantic seam

All successful prototypes route through a custom `BaseLM`. Once Lambda-RLM has a `BaseLM`, `LMHandler` and `LocalREPL` already route REPL-originated calls through it.

### TypeScript-owned leaf starts remain compatible

The custom Python `BaseLM` does not need to start child `pi -p` itself. Its `completion(prompt)` can synchronously call back to the TypeScript extension, and the extension can own queueing, subprocess starts, cancellation, and observability.

### Cancellation is not solved by any option

`LMHandler` calls `client.completion(...)` synchronously. Deadlines, cancellation, and unblocking Python on abort must be implemented in the callback bridge regardless of adapter choice.

### Observability belongs in the callback client and TypeScript extension

The custom `BaseLM` sees task detection, filter, leaf, and reduce prompts. It can attach call IDs, timing, char counts, usage estimates, and model metadata. The TypeScript extension can observe actual child Pi process lifecycle.

### Process model changes risk calculus

If the MVP bridge starts one Python process per Lambda-RLM tool run, option A's process-global monkeypatch is much less risky because the process handles only one adapter/run. If the bridge becomes persistent and handles multiple concurrent runs, option A becomes much riskier and option C becomes much more important.

## Recommended interpretation

The MVP should use explicit `BaseLM` client injection via a local or forked Lambda-RLM patch:

1. **Strategic seam:** Lambda-RLM model requests cross a `BaseLM` callback adapter, with the Pi extension owning leaf execution.
2. **Accepted MVP implementation:** optional `client: BaseLM` injection in the local/forked Lambda-RLM checkout.
3. **Fallback only:** bridge-local monkeypatch of `rlm.lambda_rlm.get_client`, acceptable only if the project later decides the local/fork patch is too costly.
4. **Avoid:** subclassing `completion()` due drift, and fake backend registration unless Lambda-RLM grows an official backend registry.

The project may maintain its own Lambda-RLM fork/patch and must not depend on upstream accepting a PR.
