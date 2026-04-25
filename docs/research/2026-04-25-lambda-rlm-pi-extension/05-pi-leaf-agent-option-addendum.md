# Addendum: Pi Leaf-Agent Option and Pi Auth Integration

Date: 2026-04-25

## Why this addendum exists

The initial synthesis correctly warned that replacing Lambda-RLM leaf model calls with full Pi agent invocations can weaken Lambda-RLM's formal story. However, it understated Pi's CLI controls. `pi --help` shows Pi can run non-interactive leaf invocations with tightly controlled model, prompt, tools, extensions, skills, context files, sessions, and output mode.

That means a Pi leaf-agent option is more viable and more nuanced than “spawn a full default coding agent for every leaf.” It can be configured as a narrow, mostly model-like leaf executor while still benefiting from selected Pi skills or other Pi prompt machinery.

## Relevant Pi CLI controls verified

From `pi --help`:

- `--model <pattern>` and `--provider <name>` select the leaf model.
- `--thinking <level>` controls reasoning effort.
- `--system-prompt <text>` replaces the default coding assistant prompt.
- `--append-system-prompt <text>` can add extra leaf instructions.
- `--print` / `-p` runs non-interactively and exits.
- `--mode text|json|rpc` controls output protocol.
- `--no-session` makes the invocation ephemeral.
- `--no-tools` disables all tools.
- `--no-builtin-tools` disables built-ins while keeping extension/custom tools.
- `--tools <tools>` allowlists specific tools.
- `--no-extensions` disables discovered extensions; explicit `-e` paths still load.
- `--extension <path>` can load chosen extensions.
- `--no-skills` disables skill discovery; docs confirm explicit `--skill <path>` still loads.
- `--skill <path>` can pass selected skill files/directories.
- `--no-context-files` disables AGENTS.md / CLAUDE.md discovery.
- `--no-prompt-templates` disables prompt template discovery.

This is enough to build isolated, purpose-specific Pi leaf nodes.

## Better framing: three leaf-call modes

### Mode A: direct Pi AI completion

The TypeScript extension calls Pi's model layer directly via `@mariozechner/pi-ai complete(...)` using `ctx.modelRegistry.getApiKeyAndHeaders(...)`.

Properties:

- Closest replacement for `BaseLM.completion(prompt)`.
- Uses Pi's model registry and `auth.json` credentials.
- Preserves Lambda-RLM formalism best because each neural step remains a single bounded completion.
- No Pi tools, skills, context files, or agent loop.
- Best default for a formal Lambda-RLM implementation.

### Mode B: constrained Pi leaf agent

The Lambda-RLM tool spawns Pi in print/json/rpc mode for each leaf/filter/reduce call, but with strict CLI controls.

Example shape:

```bash
pi \
  --print \
  --mode json \
  --no-session \
  --model "$LEAF_MODEL" \
  --thinking low \
  --system-prompt "$LEAF_SYSTEM_PROMPT" \
  --no-tools \
  --no-extensions \
  --no-context-files \
  --no-prompt-templates \
  --no-skills \
  "$(cat leaf-prompt.txt)"
```

If selected skills are desired:

```bash
pi \
  --print \
  --mode json \
  --no-session \
  --model "$LEAF_MODEL" \
  --system-prompt "$LEAF_SYSTEM_PROMPT" \
  --no-tools \
  --no-extensions \
  --no-context-files \
  --no-prompt-templates \
  --no-skills \
  --skill /path/to/skill/SKILL.md \
  "$(cat leaf-prompt.txt)"
```

Pi docs state explicit `--skill` paths are additive even with `--no-skills`.

Properties:

- Uses Pi `auth.json` and model selection.
- Can give small leaf models extra capability via curated skills.
- Can use a custom, non-coding, Lambda-RLM leaf system prompt.
- Can run with no tools or a carefully allowlisted set of tools.
- Can run with no extensions or only explicitly chosen extensions.
- More expensive than direct completion because it starts/runs an agent session per call unless kept persistent via RPC.
- Weakens the strict Lambda-RLM model if the leaf agent has tools, extra context, multi-turn behavior, or broad skills.

### Mode C: persistent Pi RPC leaf worker

Instead of spawning `pi -p` per leaf, start one or more persistent Pi RPC-mode workers with a controlled configuration.

Example shape:

```bash
pi \
  --mode rpc \
  --no-session \
  --model "$LEAF_MODEL" \
  --system-prompt "$LEAF_SYSTEM_PROMPT" \
  --no-tools \
  --no-extensions \
  --no-context-files \
  --no-prompt-templates \
  --no-skills \
  --skill /path/to/selected-skill/SKILL.md
```

The TypeScript extension then sends leaf prompts over RPC.

Properties:

- Avoids process startup per leaf.
- Keeps Pi auth/model/skills benefits.
- Requires worker lifecycle management.
- Must ensure one leaf request cannot leak context into the next unless intended.
- Need to verify RPC prompt/session reset behavior; `--no-session` prevents persistence to disk but does not automatically mean in-memory context is cleared between prompts. A robust design may need one worker per run, explicit new session/reset, or direct SDK use.

## How this affects Lambda-RLM formalism

The more Pi features a leaf has, the further it drifts from Lambda-RLM's formal assumption that a leaf is a bounded model call `sub_M(template(P))`.

Risk gradient:

1. **Direct Pi AI completion** — closest to formal Lambda-RLM.
2. **Pi leaf agent with no tools, no discovered context, fixed system prompt, selected skill text** — modest drift; still mostly a prompt-transformed completion.
3. **Pi leaf agent with tools/extensions/context files** — significant drift; leaf can become agentic and environment-dependent.
4. **Nested Pi coding agent with normal defaults** — largest drift; not recommended for formal Lambda-RLM runs.

A useful design is to make this explicit in the tool API:

```ts
leafMode: "direct_completion" | "pi_print" | "pi_rpc"
```

and mark modes as:

- `formal`: direct completion only.
- `skill_augmented`: Pi leaf with curated skills and no tools.
- `agentic`: Pi leaf with tools/extensions, opt-in only.

## Pi auth.json integration

Using Pi's model registry/auth is desirable and should be a near-term goal.

Two approaches:

### Direct in-process auth

The extension uses:

```ts
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
```

Then calls:

```ts
complete(model, payload, { apiKey: auth.apiKey, headers: auth.headers, signal })
```

This avoids separate API key env vars and uses Pi's existing auth storage and model registry.

### Subprocess Pi auth

A spawned `pi -p` or `pi --mode rpc` worker automatically uses Pi's normal auth resolution, including `auth.json`, environment variables, custom models, and provider settings.

This is attractive for leaf-agent modes because the Lambda-RLM extension does not need to handle provider credentials at all.

## Revised recommendation

Keep the first implementation narrow, but distinguish two future paths:

1. **Formal Lambda-RLM path:** use direct Pi AI completion as the replacement for Python `BaseLM.completion()`. This gives Pi auth/model integration while preserving bounded leaf-call semantics.
2. **Pi-augmented Lambda-RLM path:** optionally support constrained Pi leaf agents using `pi -p` or persistent `pi --mode rpc`, with explicit controls for system prompt, tools, extensions, context files, and selected skills.

The first path should be the default. The second path is worth preserving as an opt-in research/quality mode, especially for small leaf models that may benefit from curated skills.
