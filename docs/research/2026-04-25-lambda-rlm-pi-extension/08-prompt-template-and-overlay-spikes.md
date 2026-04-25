# Prompt Template and Overlay Spike Comparison

Date: 2026-04-25

## Purpose

Evaluate how user-authored Lambda-RLM prompt override files should be represented, validated, loaded, and injected into the local/forked Lambda-RLM implementation.

Prototype outputs live under:

```text
/tmp/pi-lambda-rlm-prompt-spikes/
  A-python-format/
  B-mustache-or-template/
  C-overlay-loader/
  D-lambda-rlm-prompt-registry/
```

## Decisions already accepted before spikes

- Config uses sparse `config.toml` overlays.
- Prompts use one Markdown file per prompt.
- Built-in defaults are private extension defaults.
- Global/project `prompts/` directories are sparse overlays.
- Missing prompt files inherit from fallback layers.
- Prompt examples/templates are copyable only and do not affect runtime unless manually copied into `prompts/`.
- No init command and no automatic seeding.
- Full Lambda-RLM Prompt Surface is overrideable in MVP.

Accepted prompt tree:

```text
prompts/
  FORMAL-LEAF-SYSTEM-PROMPT.md
  TASK-DETECTION-PROMPT.md

  tasks/
    summarization.md
    qa.md
    translation.md
    classification.md
    extraction.md
    analysis.md
    general.md

  filters/
    relevance.md

  reducers/
    merge-summaries.md
    select-relevant.md
    combine-analysis.md
```

## Template syntax findings

| Syntax | Example | Dependency | JSON/code ergonomics | Shell ergonomics | Validation | Existing default compatibility | Score |
|---|---|---|---|---|---|---|---:|
| Python `.format` | `{text}` | none | Poor; literal braces must be doubled | Good | Good with restrictions | Excellent | 2–3/5 |
| Mustache-style subset | `{{text}}` | optional / custom | Good for JSON; collides with template examples | Good | Good only with strict custom subset | Moderate | 3/5 |
| Python `string.Template` | `$text` | none | Good | Mixed; shell `$HOME` must be escaped | Good | Moderate | 4/5 |
| Minimal custom replacer | `<<text>>` | none | Excellent | Excellent | Excellent | Moderate | 5/5 |

### Important correction

The initial instinct to use Python `.format` because Lambda-RLM already does was implementation-convenient but user-hostile for Markdown prompt overrides. Prompt files may contain JSON examples, code blocks, dictionaries, and braces. With `.format`, those braces must be escaped as `{{` and `}}`, even inside fenced code blocks.

Since prompts are user-authored Markdown files, authoring ergonomics should matter more than preserving internal Python syntax.

## Recommended template syntax

Use a tiny custom, variable-only placeholder syntax:

```text
<<text>>
<<query>>
<<metadata>>
<<parts>>
<<preview>>
```

Proposed grammar:

```text
placeholder := << name >>
name        := [A-Za-z_][A-Za-z0-9_]*
```

Rendering rules:

- Only exact allowlisted placeholders are substituted.
- Unknown placeholders fail validation.
- Missing required placeholders fail validation.
- No loops, sections, attribute traversal, filters, code execution, partials, or conditionals.
- Literal delimiter escaping should be documented and tested before exposing to users.

This avoids the two major collision classes:

- `{}` in JSON/code/f-strings
- `$` in shell snippets/environment variables

If custom syntax is rejected, the best standard-library fallback is Python `string.Template` with `$name` placeholders.

## Prompt overlay loader findings

The overlay loader shape scored 5/5.

Recommended ownership:

- TypeScript/Pi extension owns prompt loading.
- Python bridge receives a resolved prompt bundle in the run request.
- Python does not discover prompt files from global/project paths during execution.

Resolution order:

```text
built-in private defaults
→ ~/.pi/lambda-rlm/prompts/ sparse overlays
→ <project>/.pi/lambda-rlm/prompts/ sparse overlays
```

Merge semantics:

- Whole-file replacement only.
- No line-level or frontmatter-level merge.
- Unknown Markdown files in runtime overlay directories are fatal by default.
- Missing overlay files are valid and inherit.
- Missing built-in defaults are fatal.

Recommended source reporting per prompt:

```json
{
  "name": "tasks/qa.md",
  "source": { "layer": "project", "path": "/repo/.pi/lambda-rlm/prompts/tasks/qa.md" },
  "shadowed_sources": [
    { "layer": "built_in", "path": null },
    { "layer": "global", "path": "/home/me/.pi/lambda-rlm/prompts/tasks/qa.md" }
  ],
  "bytes": 1234,
  "sha256": "..."
}
```

Do not log full prompt content by default.

## Lambda-RLM prompt registry patch findings

A one-file local/fork patch can expose the full prompt surface while preserving defaults.

Hard-coded prompt sites in `lambda_rlm.py`:

- `_TASK_DETECTION_PROMPT`
- `TASK_TEMPLATES`
- QA fallback template
- relevance filter prompt
- reducer prompts for:
  - `MERGE_SUMMARIES`
  - `SELECT_RELEVANT`
  - `COMBINE_ANALYSIS`

Recommended patch shape:

```python
@dataclass(frozen=True)
class LambdaPromptRegistry:
    task_detection_prompt: str
    leaf_templates: Mapping[TaskType, str]
    qa_fallback_template: str
    reduce_prompts: Mapping[ComposeOp, str]
    filter_relevance_prompt: str

    @classmethod
    def from_overrides(...): ...
    def validate(self) -> None: ...
```

`LambdaRLM.__init__` accepts:

```python
client: BaseLM | None = None
prompt_registry: LambdaPromptRegistry | None = None
```

The bridge constructs the registry from the resolved prompt bundle and passes it into Lambda-RLM.

## Placeholder validation by prompt role

Recommended allowed/required placeholders if using `<<name>>`:

| Prompt file | Required | Allowed |
|---|---|---|
| `TASK-DETECTION-PROMPT.md` | `metadata` | `metadata` |
| `tasks/summarization.md` | `text` | `text`, `query` |
| `tasks/qa.md` | `text`, `query` | `text`, `query` |
| `tasks/translation.md` | `text` | `text`, `query` |
| `tasks/classification.md` | `text` | `text`, `query` |
| `tasks/extraction.md` | `text` | `text`, `query` |
| `tasks/analysis.md` | `text` | `text`, `query` |
| `tasks/general.md` | `text` | `text`, `query` |
| `filters/relevance.md` | `query`, `preview` | `query`, `preview` |
| `reducers/merge-summaries.md` | `parts` | `parts`, `query` |
| `reducers/select-relevant.md` | `parts`, `query` | `parts`, `query` |
| `reducers/combine-analysis.md` | `parts` | `parts`, `query` |
| `FORMAL-LEAF-SYSTEM-PROMPT.md` | none | none initially |

## Recommended MVP architecture

1. Store built-in private defaults as Markdown prompt files using the same user-facing placeholder syntax.
2. TypeScript extension loads and overlays prompt files.
3. TypeScript extension validates known file names and placeholder use before starting Python.
4. TypeScript extension sends resolved prompt bundle and source metadata to Python bridge.
5. Python bridge converts the resolved bundle into `LambdaPromptRegistry`.
6. Local/forked Lambda-RLM uses `client` injection and `prompt_registry` injection.
7. Run details include prompt source metadata and hashes, not full prompt contents.

## Decision still needed

Should the project use the custom `<<name>>` placeholder syntax for Markdown prompt files, or prefer a standard-library syntax such as `$name` despite shell-snippet collisions?
