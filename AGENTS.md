# pi-lambda-rlm agent notes

## Local development extension loading

This repo uses Pi's local-path package install flow for dogfooding and development:

```bash
pi install /home/will/projects/pi-lambda-rlm/
```

The package manifest points at this extension entrypoint:

```text
extensions/lambda-rlm/index.ts
```

Runtime assets such as `bridge.py`, `prompts/`, `prompt-templates/`, and `rlm/` live under `extensions/lambda-rlm/` and are tracked repo files.

Consequences for agents:

- Treat `lambda_rlm` as active only when this package is installed in Pi settings or explicitly loaded with `-e`.
- This checkout intentionally does **not** provide a `.pi/extensions/lambda-rlm/` project-local auto-discovery entrypoint. Starting Pi in this repo should not auto-load the extension merely because of cwd.
- After editing extension code or runtime assets, run `/reload` in Pi or restart the Pi session to pick up changes from the local-path install.
- A schema or load error in `lambda_rlm` can still break prompts in sessions where the package is installed, because tool schemas are sent to the provider as part of the request.
- To bypass the installed extension while debugging unrelated work, remove or disable the local package install in Pi settings, start Pi with extensions disabled, or use a session where the package is not installed.

Provider compatibility rule: keep public tool parameter schemas as a top-level object without top-level `oneOf`, `anyOf`, `allOf`, `enum`, or `not`. Enforce conditional rules such as “exactly one of `contextPath` or `contextPaths`” in runtime validation instead.
