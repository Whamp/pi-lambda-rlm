# Pi Lambda-RLM Integration

This context describes an agent-invoked Pi tool that gives the Pi coding agent a bounded long-context reasoning capability backed by Lambda-RLM.

## Language

**Pi Agent**:
The coding agent that interprets the user's intent, chooses tools, and returns the final answer to the user.
_Avoid_: User, leaf agent

**User**:
The human who gives goals to the **Pi Agent** but does not directly operate the Lambda-RLM capability during a run.
_Avoid_: Tool caller, leaf caller

**Tool Operator**:
The human or project owner who configures the **Lambda-RLM Tool**'s run-control defaults and limits.
_Avoid_: Pi Agent, leaf caller

**Agent-Invoked Tool**:
A Pi tool selected and called by the **Pi Agent** as part of completing a user goal.
_Avoid_: User command, provider, benchmark harness

**Lambda-RLM Tool**:
An **Agent-Invoked Tool** that performs bounded long-context reasoning by running Lambda-RLM's deterministic recursive planner and executor.
_Avoid_: Chat model, provider, general agent

**Long-Context Reasoning Task**:
A task where the **Pi Agent** needs an answer, summary, extraction, or analysis from context too large or structurally awkward for ordinary context loading or a single direct model call.
_Avoid_: Benchmark run, arbitrary prompt

**Long-Context File QA**:
The primary MVP proving scenario where the **Pi Agent** asks a specific question over one or more large files or context paths.
_Avoid_: Generic benchmark only

**Path-Based Context Ingestion**:
The public MVP input style where the **Pi Agent** passes one `contextPath` or many `contextPaths` plus a question, not large file contents, so the **Lambda-RLM Tool** reads source context outside the parent agent context.
_Avoid_: Large inline context, parent-agent context stuffing

**Agent Context Avoidance**:
The core product invariant that large source context must not be inserted into the parent **Pi Agent** context merely to call Lambda-RLM.
_Avoid_: Read-then-inline-large-context workflow, large inline context mode

**Raw Prompt Fixture**:
An internal bridge or test-only Lambda-RLM prompt used for development and parity tests, not part of the public Pi Agent tool schema.
_Avoid_: Public prompt parameter, agent-facing inline prompt

**Source Manifest**:
The internal header listing source numbers, paths, and sizes before concatenated multi-file context content.
_Avoid_: Unlabeled concatenation

**Source-Delimited Context**:
The internal context assembly format where each source's content is wrapped with explicit begin/end markers keyed to the **Source Manifest**.
_Avoid_: Plain concatenation, parent-agent file merging

**Bounded Tool Result**:
The Lambda-RLM tool response shape where visible content contains the answer and a compact run summary, while structured details contain observability metadata without dumping full sources or prompts into the **Parent Agent Context**.
_Avoid_: Full trace in chat, hidden unstructured output

**Failed Run Result**:
A failed Lambda-RLM tool response that marks the tool call as failed and includes structured error information plus partial run details when execution had already started.
_Avoid_: Partial answer presented as authoritative, silent failure

**Parent Agent Context**:
The limited conversation/context window used by the **Pi Agent** to reason, choose tools, and answer the **User**.
_Avoid_: Lambda-RLM working context, source corpus

**Context Budget Protection**:
The design principle that tools should avoid dumping large source content into the **Parent Agent Context**, as reflected by Pi's normal read behavior that truncates large files and reports truncation.
_Avoid_: Full-file read into chat, convenience inlining

**Long-Context Synthesis**:
A secondary MVP scenario where the **Pi Agent** summarizes or synthesizes a large context such as research notes.
_Avoid_: Simple short-context summarization

**Pi Session Analysis**:
A future scenario where the **Lambda-RLM Tool** helps read, answer questions over, or summarize long Pi session `.jsonl` files, potentially complementing or competing with compaction workflows.
_Avoid_: MVP acceptance dependency

**Agent-Discretion Invocation**:
The policy that the **Pi Agent** may choose the **Lambda-RLM Tool** when it detects a **Long-Context Reasoning Task**.
_Avoid_: User-operated command, mandatory confirmation flow

**Run Control Policy**:
The configured limits that bound a **Lambda-RLM Tool** run, including maximum input size, maximum model calls, whole-run timeout, per-model-call timeout, cancellation behavior, output truncation, and model process concurrency.
_Avoid_: Ad hoc guardrails, hidden implementation defaults

**Tool Configuration File**:
A durable TOML configuration source for the **Run Control Policy** and default leaf execution settings.
_Avoid_: Prompt-only policy, hard-coded-only policy, JSON config

**Global Tool Configuration**:
The user-level **Tool Configuration File** that defines fallback behavior when no project-level default exists.
_Avoid_: Machine-level hard ceiling

**Project Tool Configuration**:
The project-level **Tool Configuration File** whose defaults freely override the **Global Tool Configuration** for that project.
_Avoid_: Per-run agent override

**Project Trust Boundary**:
The rule that project-level Lambda-RLM configuration is trusted to define higher or lower defaults than global configuration for that project.
_Avoid_: Global hard ceiling

**Sparse Config Overlay**:
A partial tool configuration file where missing keys inherit from fallback layers.
_Avoid_: Complete copied default config, stale generated config

**Resolved Tool Configuration**:
The effective configuration after applying built-in defaults, **Global Tool Configuration**, and **Project Tool Configuration** as sparse overlays.
_Avoid_: Raw config file, Pi Agent preference

**Per-Run Tightening**:
A stricter run-control value requested by the **Pi Agent** for one **Lambda-RLM Tool** invocation relative to the **Resolved Tool Configuration**.
_Avoid_: Agent policy override, hidden limit increase

**Model Call**:
Any Lambda-RLM request for model inference serviced by a constrained Pi subprocess, including task detection, relevance filtering, base-case leaf answering, and LLM-backed reduction.
_Avoid_: Leaf-only call, provider API call

**Model Process Concurrency Limit**:
The maximum number of child Pi processes that may run at the same time across **Lambda-RLM Tool** runs within one **Pi Extension Instance**.
_Avoid_: Model call count, recursion depth

**Pi Extension Instance**:
One loaded instance of the Lambda-RLM Pi extension inside a Pi parent session.
_Avoid_: Project, machine, child Pi process

**Model Call Queue**:
The in-memory waiting area in a **Pi Extension Instance** for **Model Calls** whose **Constrained Pi Leaf Calls** are ready to run but cannot start because the **Model Process Concurrency Limit** is already reached.
_Avoid_: Recursive plan, task backlog

**Extension-Owned Leaf Runner**:
The MVP architecture where the Pi extension, not the Python bridge, starts child Pi subprocesses and records model-call observability.
_Avoid_: Python-owned Pi subprocess spawning, opaque model execution

**Bridge Protocol**:
The strict newline-delimited JSON message protocol over stdio between the Pi extension and the Python bridge.
_Avoid_: Ad hoc stdout parsing, mixed logs and protocol

**Model Callback Request**:
A request-identified **Bridge Protocol** message from the Python bridge asking the Pi extension to run a **Constrained Pi Leaf Call** for one **Model Call**.
_Avoid_: Provider API request, direct Python subprocess spawn

**Model Call Metadata**:
Out-of-band metadata attached to a **Model Callback Request**, including phase, combinator, prompt key, task type, compose operator, and size/count fields where available.
_Avoid_: Prompt-text inference, model-visible metadata sentinels

**Single-In-Flight Bridge Mode**:
The MVP **Bridge Protocol** rule that each Python bridge may have at most one unresolved **Model Callback Request** at a time, even though every request still carries an ID.
_Avoid_: Multiplexed model execution, unordered responses

**Run Result Message**:
The final **Bridge Protocol** message from the Python bridge containing the Lambda-RLM result or structured failure.
_Avoid_: Plain stdout answer, stderr-only result

**Sequential Lambda-RLM Execution**:
The MVP behavior where Lambda-RLM's recursive executor issues one model call at a time within a single run.
_Avoid_: Parallel model execution, batched model execution

**Consolidated Long-Context Run**:
A single **Lambda-RLM Tool** invocation that combines all relevant context for one **Long-Context Reasoning Task** instead of splitting the task across parallel Lambda-RLM invocations.
_Avoid_: Parallel Lambda-RLM calls, fragmented context runs

**Constrained Pi Leaf Call**:
A Pi-backed subprocess call used to service a **Model Call** through Pi's model and auth system under an explicit **Leaf Capability Profile**.
_Avoid_: Normal Pi session, provider credential path

**Leaf Capability Profile**:
A named constraint set that determines which Pi capabilities a **Constrained Pi Leaf Call** may use.
_Avoid_: Implicit defaults, inherited session behavior

**Formal Leaf Profile**:
The MVP **Leaf Capability Profile** where a **Constrained Pi Leaf Call** behaves like a bounded model-like subroutine with no tools, extensions, skills, context files, prompt templates, or persistent session.
_Avoid_: Leaf agent, normal Pi coding-agent run

**Prompt Surface**:
The configurable set of prompts that shape Lambda-RLM behavior, including Lambda-RLM's task templates, task detection prompt, filter prompts, reducer prompts, and the Formal Leaf Profile system prompt.
_Avoid_: Hard-coded-only prompt behavior, hidden prompt strings

**Prompt Tuning Workflow**:
A future first-class workflow for evaluating and improving the **Prompt Surface**, potentially using systematic prompt optimization tools such as DSPy or GEPA.
_Avoid_: One-off prompt tweaks, untracked prompt drift

**Prompt Overlay Directory**:
A sparse global or project directory of Markdown prompt files that override individual built-in prompt defaults file by file.
_Avoid_: Complete prompt pack requirement, hidden prompt mutation, JSON prompt maps

**Prompt Template Directory**:
An examples/templates directory containing copyable Markdown prompt files that mirror built-in defaults but do not affect runtime unless manually copied into a **Prompt Overlay Directory**.
_Avoid_: Auto-seeded overrides, init-generated prompt files

**Formal Leaf System Prompt File**:
The prompt overlay file named `FORMAL-LEAF-SYSTEM-PROMPT.md` that configures the system prompt for the MVP **Formal Leaf Profile**.
_Avoid_: RLM-SYSTEM-PROMPT.md, parent-agent system prompt

**Prompt File Tree**:
The conventional Markdown prompt layout containing `FORMAL-LEAF-SYSTEM-PROMPT.md`, `TASK-DETECTION-PROMPT.md`, task prompts under `tasks/`, filter prompts under `filters/`, and reducer prompts under `reducers/`.
_Avoid_: Prompt maps, unnamed prompt blobs

**Prompt Placeholder**:
A strict custom placeholder in a Markdown prompt file using `<<name>>` syntax, such as `<<text>>`, `<<query>>`, `<<metadata>>`, `<<preview>>`, or `<<parts>>`.
_Avoid_: Python `.format` placeholders, Mustache, shell-style variables

**Prompt Placeholder Validation**:
The rule that each prompt file may use only the placeholders allowed for that prompt role and must include that role's required placeholders.
_Avoid_: Silent missing variables, unknown placeholder tolerance

**Resolved Prompt Bundle**:
The fully overlaid and validated set of prompt templates plus source metadata that the Pi extension sends to the Python bridge for one run.
_Avoid_: Python-side prompt discovery, raw overlay directories

**Agentic Leaf Profile**:
A future **Leaf Capability Profile** that may selectively enable Pi capabilities for **Model Calls** after the formal baseline is proven.
_Avoid_: MVP behavior, unconstrained agent

## Relationships

- A **User** gives goals to the **Pi Agent**.
- A **Tool Operator** configures the **Global Tool Configuration** and/or **Project Tool Configuration**.
- Under **Agent-Discretion Invocation**, the **Pi Agent** may invoke the **Lambda-RLM Tool** when it detects a **Long-Context Reasoning Task**.
- The MVP primarily proves **Long-Context File QA** through **Path-Based Context Ingestion** and secondarily supports **Long-Context Synthesis**.
- **Pi Session Analysis** is important future work but not an MVP acceptance dependency.
- The expected usage pattern is a **Consolidated Long-Context Run**, because Lambda-RLM/RLM exists to reason over context that would otherwise need fragmentation.
- The public MVP tool schema must preserve **Agent Context Avoidance** by accepting `contextPath` or `contextPaths` plus `question`, rather than exposing large inline context or raw prompt as normal agent-facing input.
- A **Raw Prompt Fixture** may exist for internal Python bridge tests and Lambda-RLM parity checks only.
- Multi-file `contextPaths` are assembled internally with a **Source Manifest** and **Source-Delimited Context**.
- The tool returns a **Bounded Tool Result** on success: answer plus compact visible run summary, with structured details for sources, run controls, Lambda-RLM plan, model-call counts, prompt source hashes, and truncation/full-output path when needed.
- On validation errors before execution, the tool returns a **Failed Run Result** with structured error information and no partial execution details.
- On runtime errors after execution starts, the tool returns a **Failed Run Result** with structured error information and partial run details when available.
- Partial answers must not be presented as authoritative final answers.
- **Context Budget Protection** is part of the reason RLMs exist in this product: the parent agent should pass references to large context, and Lambda-RLM should consume that context outside the **Parent Agent Context**.
- The **Lambda-RLM Tool** decomposes one **Long-Context Reasoning Task** into zero or more **Model Calls**.
- Each **Model Call** is answered by exactly one **Constrained Pi Leaf Call**.
- Under the **Extension-Owned Leaf Runner**, the **Pi Extension Instance** starts each **Constrained Pi Leaf Call** and records its observability data.
- The Python bridge sends each **Model Callback Request** to the Pi extension through the **Bridge Protocol** instead of starting child Pi processes itself.
- Each **Model Callback Request** includes **Model Call Metadata** supplied explicitly by the local/forked Lambda-RLM integration rather than inferred from rendered prompt text.
- The MVP uses **Single-In-Flight Bridge Mode** with request IDs for observability and future compatibility.
- A **Constrained Pi Leaf Call** always runs under an explicit **Leaf Capability Profile**.
- The MVP uses the **Formal Leaf Profile**.
- The MVP starts with Lambda-RLM's existing prompt defaults and a minimal Formal Leaf Profile system prompt.
- The full **Prompt Surface** is configurable/overrideable in MVP so future **Prompt Tuning Workflow** experiments can improve quality without redesigning the tool.
- Prompt overrides use one Markdown file per prompt and file-by-file overlay from global and project **Prompt Overlay Directories** rather than requiring a complete prompt pack.
- Prompt overlays and templates use the **Prompt File Tree** convention.
- Markdown prompt files use **Prompt Placeholder** syntax with strict **Prompt Placeholder Validation**.
- The Pi extension owns prompt discovery, overlay resolution, source reporting, and validation.
- The Python bridge receives a **Resolved Prompt Bundle** and renders prompt templates at runtime when Lambda-RLM supplies values such as chunk text, query, preview, metadata, or reducer parts.
- Python rendering must still fail safely on missing or unknown placeholders even after TypeScript validation.
- Built-in prompt defaults are private extension defaults; prompt files in global/project overlay directories exist only when a **Tool Operator** intentionally creates an override.
- A **Prompt Template Directory** may provide copyable examples/templates, but normal tool loading must not auto-seed prompt overlays.
- The MVP formal leaf system prompt override file is named **Formal Leaf System Prompt File**: `FORMAL-LEAF-SYSTEM-PROMPT.md`.
- The MVP exposes and enforces a **Run Control Policy** as first-class product behavior.
- The **Resolved Tool Configuration** defines the default **Run Control Policy**, starting from Lambda-RLM's existing defaults where applicable.
- **Global Tool Configuration** and **Project Tool Configuration** are TOML **Sparse Config Overlays**.
- Under the **Project Trust Boundary**, **Project Tool Configuration** freely overrides **Global Tool Configuration** for project-specific defaults, matching Pi's project-over-global convention.
- The **Pi Agent** may use **Per-Run Tightening** but must not loosen limits from the **Resolved Tool Configuration**.
- A **Model Call Queue** starts ready **Constrained Pi Leaf Calls** only when doing so would not exceed the **Model Process Concurrency Limit** for the current **Pi Extension Instance**.
- The MVP keeps **Sequential Lambda-RLM Execution** within each single **Lambda-RLM Tool** run.
- The MVP **Model Call Queue** is defensive infrastructure for unusual simultaneous **Lambda-RLM Tool** runs in one **Pi Extension Instance**, not the expected path.
- The MVP uses the **Extension-Owned Leaf Runner** so model subprocess ownership, queueing, cancellation, and observability remain in the Pi extension.
- The MVP **Bridge Protocol** uses stdout for newline-delimited JSON protocol messages only; human/debug logs must go to stderr.
- The Python bridge emits exactly one **Run Result Message** before normal completion.
- Future batched or parallel Lambda-RLM execution may relax **Single-In-Flight Bridge Mode** without changing the request-ID shape.
- **Model Call Metadata** must not be injected into model-visible prompts.
- Cross-session, cross-project, machine-wide coordination, parallel leaf execution, and parallel Lambda-RLM invocation strategies are future work or anti-patterns unless a specific use case proves otherwise.
- An **Agentic Leaf Profile** is intentionally future work and must not leak into the MVP acceptance criteria.

## MVP non-goals

- **Agentic Leaf Profile**
- Tool-enabled child Pi leaves
- Skill-augmented leaves
- Persistent `pi --mode rpc` worker
- Parallel or batched Lambda-RLM model calls
- TypeScript port of Lambda-RLM
- Direct Pi SDK/model completion path
- Pi provider integration
- Session `.jsonl`-specific parsing or compaction replacement
- Automatic Python dependency installation
- Upstream PR acceptance as a dependency
- Prompt optimization automation with DSPy/GEPA
- Cross-session or machine-wide model process concurrency coordination

## Example dialogue

> **Dev:** "Will the user type a Lambda-RLM command directly?"
> **Domain expert:** "No. The **Pi Agent** decides when to call the **Lambda-RLM Tool**, similar to how it chooses read or edit."
>
> **Dev:** "Can the leaf call behave like a normal Pi coding agent?"
> **Domain expert:** "Not in the MVP. The **Formal Leaf Profile** should behave like a bounded model-like subroutine, but the architecture should preserve a path to a future **Agentic Leaf Profile**."

## Flagged ambiguities

- "Tool" was initially ambiguous between a user-facing command and an agent-selected capability — resolved: this product is an **Agent-Invoked Tool**.
- "Leaf agent" suggests agentic MVP behavior — resolved: use **Constrained Pi Leaf Call** as the umbrella term, **Formal Leaf Profile** for the MVP, and **Agentic Leaf Profile** only for future work.
- Runtime limits were debated as premature guardrails — resolved: max input size, max model calls, whole-run timeout, per-model-call timeout, cancellation, output truncation, and per-**Pi Extension Instance** model process concurrency are part of the MVP **Run Control Policy**.
- Model-call concurrency scope was ambiguous — resolved: current Lambda-RLM internals stay sequential for MVP; the queue bounds unusual simultaneous runs within one **Pi Extension Instance**.
- Parallel Lambda-RLM tool calls were considered theoretically possible but undesirable — resolved: the **Pi Agent** should prefer a **Consolidated Long-Context Run** over parallel Lambda-RLM calls for one reasoning task.
- Leaf process ownership was debated — resolved: the MVP uses an **Extension-Owned Leaf Runner** because the Pi extension owns observability and should avoid requiring upstream Lambda-RLM modifications when possible.
- Adapter seam was unresolved after prototypes — resolved: MVP may carry a local or forked Lambda-RLM patch for explicit `BaseLM` client injection; the project must not depend on upstream accepting a PR.
- Prompt ownership was ambiguous — resolved: MVP reuses Lambda-RLM's existing prompt defaults where possible, and the full **Prompt Surface** is configurable/overrideable in MVP for future tuning workflows.
- Prompt override granularity was ambiguous — resolved: global and project prompt files overlay built-in defaults file by file; missing files inherit from the next fallback layer.
- Prompt default seeding was ambiguous — resolved: no init command and no automatic seeding; operators manually copy examples/templates into `prompts/` to take ownership of overrides.
- The name `RLM-SYSTEM-PROMPT.md` was ambiguous — resolved: use `FORMAL-LEAF-SYSTEM-PROMPT.md` for the MVP leaf system prompt file.
- Run-control override ownership was ambiguous — resolved: **Global Tool Configuration** provides fallback defaults, **Project Tool Configuration** freely overrides those defaults inside the **Project Trust Boundary**, and the **Pi Agent** may only tighten values relative to the **Resolved Tool Configuration**.
- Config completeness was ambiguous — resolved: global and project tool configuration files are TOML **Sparse Config Overlays**, not complete generated config copies.
- Config file format was ambiguous — resolved: use `config.toml`, not JSON.
- Prompt file format was ambiguous — resolved: use one Markdown file per prompt, not JSON prompt maps.
- Prompt placeholder syntax was ambiguous — resolved: use custom `<<name>>` placeholders for Markdown prompt files because they preserve JSON, code blocks, and shell snippets better than `{name}`, `{{name}}`, or `$name` syntaxes.
- Prompt loading/rendering ownership was ambiguous — resolved: TypeScript loads, overlays, reports, and validates prompt templates; Python receives a **Resolved Prompt Bundle** and renders it during Lambda-RLM execution.
- Model-call phase metadata propagation was ambiguous — resolved: MVP includes a local/forked Lambda-RLM request-path patch, such as `LMRequest.metadata`, so explicit out-of-band **Model Call Metadata** reaches the **Model Callback Request**; do not rely on Python context-local state or prompt-text inference.
- MVP proving scenario was ambiguous — resolved: primary scenario is **Long-Context File QA**, secondary scenario is **Long-Context Synthesis**, and **Pi Session Analysis** is future work.
- Context ingestion was ambiguous — resolved: public MVP input is path/reference-only with `contextPath` or `contextPaths` plus `question`, because RLM exists to handle context too large for the **Parent Agent Context**.
- Raw prompt exposure was ambiguous — resolved: raw Lambda-RLM prompts may be used as **Raw Prompt Fixtures** in internal bridge/dev tests, but are not part of the public Pi Agent tool schema.
- Multi-file assembly was ambiguous — resolved: use a **Source Manifest** plus **Source-Delimited Context**, not plain concatenation.
- Tool result shape was ambiguous — resolved: return a **Bounded Tool Result** with compact visible content and structured details; do not dump full sources, full prompts, or huge traces into the **Parent Agent Context**.
- Failure semantics were ambiguous — resolved: validation failures fail with structured error only; runtime failures fail with structured error plus partial details when available; partial answers are never authoritative.

- The role of RLM was underemphasized — resolved: the Lambda-RLM Tool is a context-budget protection mechanism, not a way for the Pi Agent to read huge files and then pass them inline.
