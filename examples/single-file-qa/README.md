# Single-file QA example

Use this when the Pi Agent needs to answer a specific question over one referenced file without reading the full file into the parent context.

Example tool call shape:

```json
{
  "contextPath": "examples/single-file-qa/context.md",
  "question": "Which invariant protects the parent agent context budget?"
}
```

Expected behavior: `lambda_rlm` reads `contextPath` internally and returns a bounded answer plus compact run summary. Do not paste the fixture contents into an inline prompt.
