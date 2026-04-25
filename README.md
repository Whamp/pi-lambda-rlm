# pi-lambda-rlm

Bootstrap project for a Pi custom tool named `lambda_rlm`.

## Current slice

Issue #2 implements a fake single-file end-to-end path:

- public tool input is only `contextPath` + `question`;
- the tool reads the referenced file internally;
- inline context, raw prompts, multiple paths, ambiguous path aliases, and extra keys are rejected;
- successful runs return a bounded fake answer and compact structured details;
- missing or unreadable files fail before execution with structured validation details.

No Python bridge, real Lambda-RLM execution, child Pi leaf calls, or TOML overlays are included in this slice.

## Scripts

```bash
npm test          # run Vitest behavior tests
npm run typecheck # run TypeScript type checking without emitting files
```

## Pi extension entrypoint

The project-local Pi extension entrypoint is:

```text
.pi/extensions/lambda-rlm/index.ts
```
