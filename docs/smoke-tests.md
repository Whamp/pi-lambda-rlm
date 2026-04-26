# Smoke Tests

Real smoke tests are explicit because they require local Pi CLI authentication and model access.

Configure the same TOML path used by installed users:

```toml
# ~/.pi/lambda-rlm/config.toml
[leaf]
model = "<provider>/<model-id>"
```

For a repo-local smoke-test override, create `.pi/lambda-rlm/config.toml` with the same shape. This file is ignored in this repository so machine-specific model choices do not get committed.

Run:

```bash
npm run test:pi-leaf-smoke
```

Coverage:

1. Tiny child `pi -p` Formal Leaf call.
2. Tiny end-to-end QA run through `lambda_rlm`, the Python bridge, and child `pi -p`.
