# Pi Extension Custom Tools for Lambda-RLM Integration

Date: 2026-04-25

## Scope and sources read

Local Pi docs/examples reviewed:

- `docs/extensions.md`
- `docs/sdk.md`
- `docs/packages.md`
- Relevant supporting docs/examples: `docs/settings.md`, `docs/custom-provider.md`, `examples/extensions/README.md`, `reload-runtime.ts`, `tic-tac-toe.ts`, `custom-compaction.ts`, `antigravity-image-gen.ts`
- Required examples: `hello.ts`, `truncated-tool.ts`, `with-deps/`, `structured-output.ts`, `dynamic-tools.ts`

This report focuses on a TypeScript extension tool that Pi can call to invoke Lambda-RLM or a Lambda-RLM-adjacent service.

## Recommendation

Implement Lambda-RLM as a Pi **extension tool** when it is a task-specific helper, evaluator, reranker, summarizer, or external workflow step. Implement it as a **custom provider** instead only if Lambda-RLM should become a selectable chat model in `/model`, participate in Pi's normal provider streaming/tool-calling loop, or be used as the main agent model.

For the extension-tool path, prefer:

```text
.pi/extensions/lambda-rlm/
├── index.ts
├── package.json        # only if the tool needs npm deps
└── package-lock.json   # if dependencies are used
```

Project-local placement keeps the integration versioned with this repo and hot-reloadable with `/reload`.

## Minimal custom tool shape

Pi extensions are TypeScript modules loaded via `jiti`; no precompile step is required for normal extension use. An extension exports a default factory that receives `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function lambdaRlmExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "lambda_rlm_query",
    label: "Lambda-RLM Query",
    description: "Send a prompt to Lambda-RLM and return the concise result. Output is truncated if large.",
    promptSnippet: "Call Lambda-RLM for external model evaluation or generation",
    promptGuidelines: [
      "Use lambda_rlm_query only when the user asks to consult Lambda-RLM or when Lambda-RLM-specific evaluation is required.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Prompt or payload to send to Lambda-RLM" }),
      model: Type.Optional(Type.String({ description: "Lambda-RLM model/deployment name" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Submitting request to Lambda-RLM..." }],
        details: { stage: "requesting", toolCallId },
      });

      const response = await fetch(process.env.LAMBDA_RLM_ENDPOINT!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LAMBDA_RLM_API_KEY}`,
        },
        body: JSON.stringify({ prompt: params.prompt, model: params.model }),
        signal,
      });

      if (!response.ok) {
        throw new Error(`Lambda-RLM request failed (${response.status}): ${await response.text()}`);
      }

      const data = await response.json() as { text?: string };
      const text = data.text ?? "";
      return {
        content: [{ type: "text", text }],
        details: { model: params.model, bytes: text.length },
      };
    },
  });
}
```

Key API contract:

- `name`: tool-call name used by the LLM. Use stable lowercase snake_case.
- `label`: human-readable UI label.
- `description`: primary model-facing description. Include important constraints such as truncation limits.
- `promptSnippet`: optional one-line entry in Pi's `Available tools` system-prompt section. Without it, custom tools are omitted from that section.
- `promptGuidelines`: optional bullets appended to the default `Guidelines` section while the tool is active. Each bullet must name the tool explicitly because Pi appends them flat with no tool-name grouping.
- `parameters`: TypeBox schema for arguments.
- `execute(toolCallId, params, signal, onUpdate, ctx)`: implementation.
- Return `{ content, details }`; `content` is sent to the LLM, `details` is for logs/UI/state.
- Throw to signal a tool error. Returning an error-looking object does **not** set Pi's `isError` flag.

Use `defineTool()` when defining the tool as a standalone constant or passing it through arrays; it preserves TypeBox parameter inference. Inline `pi.registerTool({ ... })` already infers parameter types.

## Static vs dynamic registration

Register the core Lambda-RLM tool during extension load for the simplest behavior. Pi also supports dynamic tool registration after startup:

- `pi.registerTool()` works in the extension factory, `session_start`, slash-command handlers, and other event handlers.
- Newly registered tools are refreshed immediately in the same session; they appear in `pi.getAllTools()` and are callable without `/reload`.
- Use `pi.setActiveTools([...])` if the extension needs to enable/disable tools at runtime.
- The `dynamic-tools.ts` example keeps a `Set` of registered names, validates names as lowercase letters/numbers/underscores, registers one tool on `session_start`, and adds more via `/add-echo-tool <name>`.
- If generating tools dynamically, interpolate the actual tool name in `promptSnippet`/`promptGuidelines`; guideline bullets are appended flat and should not say "this tool" or name the wrong tool.

For Lambda-RLM, dynamic registration is useful if the extension discovers deployments/models and exposes one tool per deployment. Prefer a single tool with a `model` parameter if the deployment list is large or changes frequently, because each tool adds schema/prompt overhead.

## Placement, packaging, and dependencies

### Auto-discovered extension locations

Pi auto-discovers extensions from:

| Scope | Paths |
|---|---|
| Global | `~/.pi/agent/extensions/*.ts`, `~/.pi/agent/extensions/*/index.ts` |
| Project | `.pi/extensions/*.ts`, `.pi/extensions/*/index.ts` |

Additional local paths can be listed in settings:

```json
{
  "extensions": ["/path/to/local/extension.ts", "/path/to/local/extension/dir"]
}
```

For quick manual testing only, launch Pi with:

```bash
pi -e ./path/to/lambda-rlm.ts
```

Important hot-reload rule: extensions in auto-discovered locations can be reloaded with `/reload`; `pi -e ./path.ts` is best for one-off tests.

### Directory package with dependencies

If the Lambda-RLM tool needs npm packages, put `package.json` next to the extension and run `npm install` there. Pi's `jiti` resolution finds that local `node_modules/`.

The `with-deps/` example uses:

```json
{
  "name": "pi-extension-with-deps",
  "private": true,
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {
    "ms": "^2.1.3"
  },
  "devDependencies": {
    "@types/ms": "^2.1.0"
  }
}
```

For a Lambda-RLM package, use the same pattern:

```json
{
  "name": "lambda-rlm-pi-extension",
  "private": true,
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {},
  "devDependencies": {}
}
```

Node 25 has global `fetch`, so a simple HTTP integration may need no runtime dependency.

### Distributed Pi packages

Pi packages can bundle extensions, skills, prompt templates, and themes via npm, git, or local paths:

```bash
pi install npm:@org/lambda-rlm-pi@1.0.0
pi install git:github.com/org/lambda-rlm-pi@v1
pi install ./relative/path/to/package
```

By default installs are global (`~/.pi/agent/settings.json`); use `-l` for project settings (`.pi/settings.json`). Project package settings can be shared and Pi installs missing packages on startup.

For published packages:

- Put third-party runtime modules in `dependencies`.
- Do not rely on `devDependencies` at runtime. Package installs commonly omit dev deps.
- List Pi core packages as `peerDependencies` with `"*"` if imported: `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `typebox`.
- Include `keywords: ["pi-package"]` for package-gallery discoverability.
- Use the `pi` manifest or conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

Security note: extensions and Pi packages run with full system permissions.

## Schemas and argument compatibility

Use TypeBox schemas for tool parameters:

```ts
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const LambdaRlmParams = Type.Object({
  action: StringEnum(["generate", "score", "classify"] as const),
  prompt: Type.String({ description: "Input prompt" }),
  maxTokens: Type.Optional(Type.Number({ minimum: 1, maximum: 8192 })),
});
```

Schema pitfalls:

- Use `StringEnum()` from `@mariozechner/pi-ai` for string enums. `Type.Union([Type.Literal(...)])` is not compatible with Google's API.
- Add descriptions to parameters; Pi forwards schemas to models.
- Keep the public schema strict.
- If old sessions may contain old argument shapes, add `prepareArguments(args)` to map legacy raw arguments to the current schema before validation.
- If the tool accepts file paths, normalize a leading `@`; built-in tools do this because some models include `@` prefixes in path arguments.

For typed `tool_call` event interception of a custom tool, export the schema-derived input type and use `isToolCallEventType<"tool_name", InputType>()`.

## Execution model

Pi executes sibling tool calls in parallel by default:

- `tool_call` preflight handlers run sequentially.
- Actual sibling tool executions run concurrently unless constrained.
- `tool_execution_update`, `tool_result`, and `tool_execution_end` may interleave by completion order.
- Final tool-result messages are emitted later in assistant source order.

For Lambda-RLM, choose intentionally:

- Keep default parallel execution if independent calls are safe and the external service can handle concurrency.
- Set `executionMode: "sequential"` if calls share mutable state, use a cursor/session, or must respect strict rate limits. The `tic-tac-toe.ts` example demonstrates this for a stateful tool where parallel sibling calls race.
- For file mutations, wrap the entire read-modify-write window in `withFileMutationQueue(absolutePath, async () => ...)` so the tool participates in Pi's per-file mutation queue alongside built-in `edit`/`write`.

## Cancellation, progress, and long-running Lambda-RLM calls

### Cancellation

Tool `execute()` receives `signal: AbortSignal | undefined`. Pass it into every abort-aware operation:

- `fetch(url, { signal })`
- `pi.exec(command, args, { signal, timeout })`
- Pi AI calls such as `complete(..., { signal })`
- SSE/stream readers and child-process wrappers via explicit abort listeners

Pattern:

```ts
async execute(_id, params, signal, onUpdate, ctx) {
  if (signal?.aborted) {
    return { content: [{ type: "text", text: "Cancelled" }], details: { cancelled: true } };
  }

  const response = await fetch(endpoint, { method: "POST", body, signal });
  // For manual stream parsing, check signal.aborted inside the loop and cancel/release the reader in finally.
}
```

In extension event handlers, use `ctx.signal` for nested async work during active agent turns. It is often undefined in idle contexts such as commands or session startup.

### Progress updates

Use `onUpdate?.({ content, details })` to stream partial tool results. Pi emits these as `tool_execution_update` events and custom renderers receive `isPartial: true`.

Good Lambda-RLM progress milestones:

- request queued/submitted
- remote job id received
- polling/streaming status
- token/chunk count received
- truncation/full-output path written

Do not include secrets, bearer tokens, or private headers in progress `details`; they may be logged or rendered.

### Timeouts and retries

Pi provider settings include provider retry/timeout controls, but a custom tool that directly calls Lambda-RLM owns its own timeout/retry behavior. Recommended approach:

- Add a conservative per-call timeout parameter or constant.
- Combine timeout with Pi's `signal` so user abort still works.
- Fail fast on very long provider-directed retry delays instead of waiting silently.
- Use explicit backoff only for known transient statuses (`429`, `500`, `502`, `503`, `504`).
- Surface retry state via `onUpdate`.

Avoid long blocking initialization in the extension factory. Use an async factory only for startup-critical discovery, such as registering a provider/model list before `pi --list-models` or normal startup continues. For a tool, defer Lambda-RLM health checks until the first tool call or a slash command.

## Output truncation

Custom tools **must truncate output** before returning it to the LLM. Pi's built-in limits are:

- 50 KB (`DEFAULT_MAX_BYTES`)
- 2000 lines (`DEFAULT_MAX_LINES`)
- whichever is hit first

Use Pi's truncation utilities:

```ts
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
} from "@mariozechner/pi-coding-agent";

const truncation = truncateTail(output, {
  maxLines: DEFAULT_MAX_LINES,
  maxBytes: DEFAULT_MAX_BYTES,
});
```

Guidelines:

- Use `truncateHead` when the beginning matters, e.g. search results or file-like reads.
- Use `truncateTail` when the end matters, e.g. logs, traces, iterative model output.
- Use `truncateLine` for single huge lines.
- If truncated, save the full output to a temp file and tell the LLM exactly where it is.
- Mention truncation limits in the tool description.

The `truncated-tool.ts` example wraps `rg`, saves full output under `tmpdir()`, records truncation metadata in `details`, and appends a notice to returned `content`.

For Lambda-RLM, consider truncating both:

1. the model-facing `content`, and
2. any huge raw response kept in `details` or saved artifacts.

## Structured/final outputs

If Lambda-RLM returns a final machine-readable answer and no follow-up assistant turn is needed, return `terminate: true`:

```ts
return {
  content: [{ type: "text", text: "Saved Lambda-RLM structured result." }],
  details: structuredResult,
  terminate: true,
};
```

Caveat: Pi only skips the automatic follow-up LLM call when **every finalized tool result in the current batch** has `terminate: true`. The `structured-output.ts` example is the minimal pattern.

## State and persistence

For stateful tools, store reconstructed state in tool-result `details` and rebuild it on `session_start` from `ctx.sessionManager.getBranch()`. This preserves correct behavior across reloads, resumes, forks, and tree navigation.

Examples of useful Lambda-RLM state in `details`:

- request id / job id
- model/deployment name
- token counts or billing metadata
- truncated/full-output path
- deterministic input hash

Avoid storing secrets or bulky raw responses in session details.

## Testing and hot reload

### Manual smoke testing

1. Start with a one-off extension:

   ```bash
   pi -e ./.pi/extensions/lambda-rlm/index.ts
   ```

2. For normal iterative development, put the extension in `.pi/extensions/lambda-rlm/index.ts` and use `/reload` after edits.

3. Optionally isolate extension tools from built-ins:

   ```bash
   pi --no-builtin-tools -e ./.pi/extensions/lambda-rlm/index.ts
   ```

4. Ask Pi to call the tool with a small prompt and verify:
   - the tool appears/can be called,
   - progress updates render,
   - cancellation works with Escape/abort,
   - errors are reported as tool errors,
   - large outputs are truncated and full output is recoverable.

Tools cannot call `ctx.reload()` directly because they receive `ExtensionContext`, not `ExtensionCommandContext`. The `reload-runtime.ts` example registers a command that calls `ctx.reload()`, then exposes a tool that queues that command with `pi.sendUserMessage(..., { deliverAs: "followUp" })`. Treat `await ctx.reload(); return;` as terminal; code after reload runs in the old extension frame.

### Programmatic tests with the SDK

Use the SDK for deterministic tests:

- `createAgentSession({ sessionManager: SessionManager.inMemory(), ... })`
- `DefaultResourceLoader({ additionalExtensionPaths: [...] })` to load the real extension
- or `customTools: [defineTool(...)]` for isolated tool behavior
- subscribe to `tool_execution_start/update/end` events
- test abort with `session.abort()`
- test prompt behavior with a mock Lambda-RLM HTTP server
- test settings with in-memory `SettingsManager`

This avoids requiring persistent sessions or a real Lambda-RLM endpoint in unit tests.

## Pitfalls for Lambda-RLM tools

- **Parallel calls by default:** external LLM endpoints may be rate-limited or stateful. Use `executionMode: "sequential"` or an internal queue when needed.
- **Abort must be wired through:** a long `fetch`, SSE reader, polling loop, or subprocess must receive `signal`; otherwise Escape/abort leaves work running.
- **Synchronous work blocks cancellation/UI:** avoid long `execSync`-style calls for external LLM work. Prefer `fetch`, async clients, or `pi.exec(..., { signal, timeout })`.
- **Do not over-return:** tool `content` enters the LLM context. Truncate aggressively and save full artifacts outside context.
- **Throw on failure:** thrown errors become `isError: true`; returned values do not.
- **Do not leak credentials:** use environment variables, Pi auth/model registry helpers, or settings. Never place tokens in `content`, progress updates, details, or temp-file paths.
- **Hot reload invalidates old runtime state:** clean up connections/watchers in `session_shutdown`; do not use stale `ctx`/`pi` objects after session replacement/reload.
- **Runtime deps must be real deps:** published packages cannot rely on `devDependencies`; local extension directories need `npm install` before imports work.
- **Enum schemas:** use `StringEnum` for string enums to keep Google-compatible schema generation.
- **Non-interactive modes:** UI methods are no-ops/defaults in print/JSON modes. Check `ctx.hasUI` before relying on prompts/dialogs.
- **Consider provider integration instead:** if Lambda-RLM should be selectable as a model, register a provider with `pi.registerProvider()` rather than hiding it behind a tool.

## Practical Lambda-RLM skeleton with truncation and timeout

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const Params = Type.Object({
  prompt: Type.String({ description: "Prompt to send to Lambda-RLM" }),
  model: Type.Optional(Type.String({ description: "Optional Lambda-RLM model/deployment" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds", default: 120000 })),
});

export default function lambdaRlm(pi: ExtensionAPI) {
  pi.registerTool({
    name: "lambda_rlm_query",
    label: "Lambda-RLM Query",
    description: `Call Lambda-RLM. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file when truncated.`,
    promptSnippet: "Consult Lambda-RLM for external model generation/evaluation",
    promptGuidelines: ["Use lambda_rlm_query when the user explicitly asks for Lambda-RLM or external RLM evaluation."],
    parameters: Params,
    executionMode: "sequential", // remove if concurrent Lambda-RLM calls are safe

    async execute(_toolCallId, params, signal, onUpdate) {
      const endpoint = process.env.LAMBDA_RLM_ENDPOINT;
      const apiKey = process.env.LAMBDA_RLM_API_KEY;
      if (!endpoint) throw new Error("Missing LAMBDA_RLM_ENDPOINT");
      if (!apiKey) throw new Error("Missing LAMBDA_RLM_API_KEY");

      const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? 120_000);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      onUpdate?.({ content: [{ type: "text", text: "Calling Lambda-RLM..." }], details: { stage: "request" } });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ prompt: params.prompt, model: params.model }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new Error(`Lambda-RLM failed (${response.status}): ${await response.text()}`);
      }

      const payload = await response.json() as { text?: string; output?: string; requestId?: string };
      const raw = payload.text ?? payload.output ?? JSON.stringify(payload, null, 2);
      const truncation = truncateTail(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

      let text = truncation.content;
      const details: Record<string, unknown> = {
        requestId: payload.requestId,
        model: params.model,
        truncated: truncation.truncated,
      };

      if (truncation.truncated) {
        const dir = await mkdtemp(join(tmpdir(), "pi-lambda-rlm-"));
        const fullOutputPath = join(dir, "output.txt");
        await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, raw, "utf8"));
        details.fullOutputPath = fullOutputPath;
        details.truncation = truncation;
        text += `\n\n[Lambda-RLM output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
      }

      return { content: [{ type: "text", text }], details };
    },
  });
}
```
