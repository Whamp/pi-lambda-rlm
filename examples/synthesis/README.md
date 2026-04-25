# Long-context synthesis example

Use this for secondary MVP long-context synthesis: summarize or consolidate related notes without loading them into the parent agent context.

Example tool call shape:

```json
{
  "contextPaths": [
    "examples/synthesis/research-a.md",
    "examples/synthesis/research-b.md"
  ],
  "question": "Synthesize the operational guidance from these notes."
}
```

Expected behavior: `lambda_rlm` reads the paths internally, produces a concise synthesis, and keeps the visible output bounded. Avoid committing generated model output; reviewers should run the mock and gated smoke tests instead.
