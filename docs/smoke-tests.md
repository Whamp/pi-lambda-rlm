# Smoke Tests

Real smoke tests are gated because they require local Pi CLI authentication and model access.

Default verification:

```bash
npm run test:pi-leaf-smoke
```

This skips the real tests unless explicitly enabled.

Enabled verification:

```bash
PI_LAMBDA_RLM_LEAF_SMOKE=1 \
LAMBDA_RLM_LEAF_MODEL=google/gemini-3-flash-preview \
npm run test:pi-leaf-smoke
```

Coverage:

1. Tiny child `pi -p` Formal Leaf call.
2. Tiny end-to-end QA run through `lambda_rlm`, the Python bridge, and child `pi -p`.
