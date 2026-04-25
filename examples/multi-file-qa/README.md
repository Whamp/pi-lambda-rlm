# Multi-file QA example

Use this when one question needs evidence from multiple files. The tool creates a source manifest and source-delimited context internally.

Example tool call shape:

```json
{
  "contextPaths": [
    "examples/multi-file-qa/design.md",
    "examples/multi-file-qa/ops.md"
  ],
  "question": "What should an operator remember about configuration and prompt ownership?"
}
```

Expected multi-file QA behavior: the answer can cite or describe facts from both files while the parent Pi Agent receives only bounded output and metadata, not the full source corpus.
