# Lambda-RLM source reference

Date: 2026-04-25

The research notes in this directory inspected the upstream Lambda-RLM repository at:

- Repository: <https://github.com/lambda-calculus-LLM/lambda-RLM>
- Commit: `3874d393483dc4299101918cf8e9af670194bd88`

This project does not keep Lambda-RLM as a git submodule. The local `lambda-RLM/` checkout used during planning was only for early-stage research convenience.

If future implementation work needs to reproduce that checkout, use:

```bash
git clone https://github.com/lambda-calculus-LLM/lambda-RLM /tmp/lambda-RLM
cd /tmp/lambda-RLM
git checkout 3874d393483dc4299101918cf8e9af670194bd88
```

When the implementation reaches the Lambda-RLM integration slice, choose the dependency shape deliberately. Options include a Python package dependency, a `Whamp` fork, patch files, or a submodule to a maintained fork.
