# pi-lambda-rlm agent notes

## Project-local extension auto-load

This repo intentionally dogfoods `lambda_rlm` through a project-local Pi extension entrypoint:

```text
.pi/extensions/lambda-rlm/index.ts
```

When a Pi coding agent starts with its working directory in this repo, Pi auto-discovers `.pi/extensions/*/index.ts` and registers `lambda_rlm` before the first model/provider request. This happens even when the extension is not installed globally.

Consequences for agents:

- Treat `lambda_rlm` as active in this repo after startup, `/reload`, or restart.
- A schema or load error in `lambda_rlm` can break unrelated agent prompts before the tool is ever called, because tool schemas are sent to the provider as part of the request.
- The entrypoint is not a symlink. It re-exports `src/extension.ts`; runtime assets such as `bridge.py`, `prompts/`, `prompt-templates/`, and `rlm/` live under `.pi/extensions/lambda-rlm/` and are tracked repo files.
- After editing extension code, run `/reload` in Pi or restart the Pi session to pick up changes.
- To bypass the dogfooded extension while debugging unrelated work, start Pi with extensions disabled or temporarily rename `.pi/extensions/lambda-rlm/`.

Provider compatibility rule: keep public tool parameter schemas as a top-level object without top-level `oneOf`, `anyOf`, `allOf`, `enum`, or `not`. Enforce conditional rules such as “exactly one of `contextPath` or `contextPaths`” in runtime validation instead.
