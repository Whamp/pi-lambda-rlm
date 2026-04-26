import { dirname, join } from "node:path";
import { Type } from "typebox";
import { executeLambdaRlmTool, LambdaRlmValidationError } from "./lambda-rlm-tool.js";
import { buildDoctorActionMenu, renderDoctorCommandOutput, runLambdaRlmDoctor } from "./doctor.js";
import { LEAF_THINKING_VALUES, resolveLambdaRlmConfigWithSources } from "./config-resolver.js";
import type { DoctorOptions } from "./doctor.js";
import type { LeafThinking } from "./config-resolver.js";
import {
  MANUAL_MODEL_ENTRY_ID,
  SHOW_ALL_REGISTERED_MODELS_ID,
  candidateLeafModelInputFromRegistry,
  resolveCandidateLeafModelSet,
} from "./model-candidates.js";
import type { CandidateLeafModel } from "./model-candidates.js";
import {
  normalizeRewriteInvalidConfig,
  writeFormalLeafModelSelection,
  writeFormalLeafThinkingSelection,
} from "./targeted-config-edit.js";
import { ensureLambdaRlmUserWorkspace } from "./workspace-scaffolding.js";
import { LeafProcessFailureError, runFormalPiLeafModelCall } from "./leaf-runner.js";
import type { ProcessRunner } from "./leaf-runner.js";
import type { ModelCallConcurrencyQueue } from "./model-call-queue.js";

export const LambdaRlmToolParameters = Type.Object(
  {
    contextPath: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Path to one readable UTF-8 text file. Pass exactly one of contextPath or contextPaths. lambda_rlm reads this file internally to preserve parent-agent context; do not inline file contents.",
      }),
    ),
    contextPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Ordered paths to readable UTF-8 text files for one consolidated Lambda-RLM run. Pass exactly one of contextPath or contextPaths; do not inline, paste, or concatenate file contents yourself.",
      }),
    ),
    debug: Type.Optional(
      Type.Boolean({
        description:
          "Advanced diagnostics mode. When true, writes a compact source-free run timeline and telemetry artifact to disk for debugging successes, failures, and timeouts. Omit during normal use.",
      }),
    ),
    maxInputBytes: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Caps the total UTF-8 bytes read from all referenced context files for this run. Advanced tightening only; cannot exceed the resolved config limit. Omit unless debugging or retrying after an input-limit failure.",
      }),
    ),
    maxModelCalls: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Caps Lambda-RLM model callbacks for this run, including task detection, filters, leaf answers, and reducers. Advanced tightening only; cannot exceed the resolved config limit. Omit unless debugging or retrying after a model-call-limit failure.",
      }),
    ),
    modelCallTimeoutMs: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Caps the duration of each individual Formal Leaf model callback in milliseconds. Advanced tightening only; cannot exceed the resolved config limit. Omit unless debugging or retrying after a model-call timeout.",
      }),
    ),
    outputMaxBytes: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Caps chat-visible answer bytes for this run; does not cap or return source file contents. Advanced tightening only; cannot exceed the resolved config limit. Omit unless the user asks for a compact answer or you are debugging output limits.",
      }),
    ),
    outputMaxLines: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Caps chat-visible answer lines for this run; does not cap or return source file contents. Advanced tightening only; cannot exceed the resolved config limit. Omit unless the user asks for a compact answer or you are debugging output limits.",
      }),
    ),
    question: Type.String({
      minLength: 1,
      description:
        "Question or task instruction to answer from the referenced text file(s), such as QA, summary, extraction, synthesis, analysis, or diagnosis.",
    }),
    wholeRunTimeoutMs: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Caps total wall-clock time for the whole Lambda-RLM run in milliseconds. Advanced tightening only; cannot exceed the resolved config limit. Omit unless debugging or retrying after a whole-run timeout.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

interface ToolUpdate {
  content: { type: "text"; text: string }[];
  details?: Record<string, unknown>;
}
interface MinimalCommandContext {
  cwd?: string;
  leafProcessRunner?: ProcessRunner;
  modelRegistry?: Parameters<typeof candidateLeafModelInputFromRegistry>[0] & {
    find?: (provider: string, modelId: string) => unknown;
    hasConfiguredAuth?: (model: unknown) => boolean;
  };
  ui?: {
    input?: (
      prompt: string,
      placeholder?: string,
    ) => string | undefined | Promise<string | undefined>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void | Promise<void>;
    /** Legacy test/development shim kept for older harnesses; Pi's real API is input(). */
    promptText?: (prompt: string) => string | undefined | Promise<string | undefined>;
    select?: (
      prompt: string,
      choices: string[],
    ) => string | undefined | Promise<string | undefined>;
  };
}
interface MinimalPiApi {
  lambdaRlmWorkspacePath?: string;
  registerTool(tool: Record<string, unknown>): void;
  registerCommand?: (
    name: string,
    options: { description: string; handler: (...args: unknown[]) => Promise<unknown> },
  ) => void;
  ui?: { notify?: (message: string) => void | Promise<void> };
}
interface MinimalExtensionContext {
  cwd: string;
  leafProcessRunner?: ProcessRunner;
}

function commandContextFromArgs(args: unknown[]): MinimalCommandContext {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (
      typeof arg === "object" &&
      arg !== null &&
      ("cwd" in arg || "leafProcessRunner" in arg || "ui" in arg)
    ) {
      return arg as MinimalCommandContext;
    }
  }
  return {};
}

function globalConfigPathForWorkspace(workspacePath: string | undefined) {
  return workspacePath ? join(workspacePath, "config.toml") : undefined;
}

function defaultGlobalConfigPath() {
  return join(process.env.HOME ?? ".", ".pi", "lambda-rlm", "config.toml");
}

function defaultProjectConfigPath(cwd: string) {
  return join(cwd, ".pi", "lambda-rlm", "config.toml");
}

type ConfigWriteTarget = "global" | "project";

interface UiChoice {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  safeDefault?: boolean;
}

function displayChoice(choice: UiChoice) {
  const badges = [
    choice.recommended ? "recommended" : undefined,
    choice.safeDefault ? "safe default" : undefined,
  ].filter(Boolean);
  return [
    `${choice.label} [${choice.id}]${badges.length > 0 ? ` (${badges.join(", ")})` : ""}`,
    choice.description,
  ]
    .filter(Boolean)
    .join(" — ");
}

function orderedChoices(choices: UiChoice[], defaultChoiceId?: string) {
  if (!defaultChoiceId) {
    return choices;
  }
  const defaultChoice = choices.find((choice) => choice.id === defaultChoiceId);
  if (!defaultChoice) {
    return choices;
  }
  return [defaultChoice, ...choices.filter((choice) => choice.id !== defaultChoiceId)];
}

async function selectChoiceId(args: {
  ctx: MinimalCommandContext;
  prompt: string;
  choices: UiChoice[];
  defaultChoiceId?: string;
}) {
  const { ui } = args.ctx;
  if (!ui?.select) {
    return;
  }
  const choices = orderedChoices(args.choices, args.defaultChoiceId);
  const defaultChoice = choices.find((choice) => choice.id === args.defaultChoiceId);
  const prompt = defaultChoice
    ? `${args.prompt}\nDefault: ${defaultChoice.label} [${defaultChoice.id}]`
    : args.prompt;
  const renderedChoices = choices.map(displayChoice);
  const renderedToId = new Map<string, string>();
  for (let index = 0; index < renderedChoices.length; index += 1) {
    const rendered = renderedChoices[index];
    const id = choices[index]?.id;
    if (rendered && id) {
      renderedToId.set(rendered, id);
    }
  }
  const selected = await ui.select(prompt, renderedChoices);
  if (!selected) {
    return;
  }
  if (choices.some((choice) => choice.id === selected)) {
    return selected;
  }
  return renderedToId.get(selected);
}

function diagnosticPromptSummary(initialText: string) {
  const lines = initialText.split(/\r?\n/);
  const summary = lines[0] ?? "lambda_rlm doctor completed.";
  const diagnosticsStart = lines.indexOf("Diagnostics:");
  const menuStart = lines.indexOf("Post-diagnostics action menu (Doctor Repair Flow):");
  let diagnosticLines: string[] = [];
  if (diagnosticsStart === -1) {
    diagnosticLines = [];
  } else if (menuStart === -1) {
    diagnosticLines = lines.slice(diagnosticsStart + 1);
  } else {
    diagnosticLines = lines.slice(diagnosticsStart + 1, menuStart);
  }
  const problemLines = diagnosticLines.filter(
    (line) => line.startsWith("- [error]") || line.startsWith("- [warn]"),
  );
  if (problemLines.length === 0) {
    return `${summary}\nDiagnostics passed.`;
  }
  return [summary, "Problems:", ...problemLines].join("\n");
}

function doctorRepairPrompt(initialText: string, actionPrompt: string) {
  return `${diagnosticPromptSummary(initialText)}\n\n${actionPrompt}`;
}

function promptUserText(ctx: MinimalCommandContext, prompt: string, placeholder?: string) {
  if (ctx.ui?.promptText) {
    return ctx.ui.promptText(prompt);
  }
  return ctx.ui?.input?.(prompt, placeholder);
}

async function notifyUser(
  ctx: MinimalCommandContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
) {
  await ctx.ui?.notify?.(message, type);
}

async function selectConfigWriteTarget(args: {
  ctx: MinimalCommandContext;
  doctorOptions: DoctorOptions;
  effectiveSource: "model" | "thinking";
  globalConfigPath: string;
  projectConfigPath: string;
  selectionLabel: "Formal Leaf Model Selection" | "Formal Leaf Thinking Selection";
}): Promise<ConfigWriteTarget | undefined> {
  const targetState = await resolveLambdaRlmConfigWithSources(args);
  if (!targetState.ok) {
    return;
  }
  const projectConfigExists =
    targetState.config.sources.exists.project && args.projectConfigPath !== args.globalConfigPath;
  if (!projectConfigExists) {
    return "global";
  }
  const highlightedTarget =
    targetState.config.sources.leaf[args.effectiveSource] === "project" ? "project" : "global";
  return selectChoiceId({
    choices: [
      {
        id: "global",
        label: "Global Tool Configuration",
        description: "Write ~/.pi/lambda-rlm/config.toml; project-local config remains unchanged.",
      },
      {
        id: "project",
        label: "Project Tool Configuration",
        description:
          "Write this project's .pi/lambda-rlm/config.toml inside the Project Trust Boundary; global config remains unchanged.",
      },
    ],
    ctx: args.ctx,
    defaultChoiceId: highlightedTarget,
    prompt: `Choose the Configuration Write Target for ${args.selectionLabel}.`,
  }) as Promise<ConfigWriteTarget | undefined>;
}

function modelChoice(candidate: CandidateLeafModel): UiChoice {
  return {
    id: candidate.id,
    label: candidate.label,
    ...(candidate.warning ? { description: candidate.warning } : {}),
  };
}

function promptManualFormalLeafModel(ctx: MinimalCommandContext) {
  return promptUserText(
    ctx,
    "Enter a manual Formal Leaf model pattern for Formal Leaf Model Selection (for example provider/model-id).",
    "provider/model-id",
  );
}

async function selectExpandedCandidate(args: {
  ctx: MinimalCommandContext;
  candidates: CandidateLeafModel[];
}) {
  const expandedChoice = await selectChoiceId({
    choices: args.candidates.map(modelChoice),
    ctx: args.ctx,
    defaultChoiceId: args.candidates[0]?.id ?? MANUAL_MODEL_ENTRY_ID,
    prompt:
      "Choose from all registered models for Formal Leaf Model Selection. Missing-auth models are labeled and may still fail doctor until credentials are configured.",
  });
  return args.candidates.find((candidate) => candidate.id === expandedChoice);
}

function thinkingChoice(thinking: LeafThinking): UiChoice {
  return {
    id: thinking,
    label: thinking,
    description:
      thinking === "off"
        ? "Default Formal Leaf Thinking Selection baseline; no additional thinking requested."
        : `Set [leaf].thinking to ${thinking}.`,
  };
}

async function chooseFormalLeafThinking(ctx: MinimalCommandContext) {
  const selected = await selectChoiceId({
    choices: LEAF_THINKING_VALUES.map(thinkingChoice),
    ctx,
    defaultChoiceId: "off",
    prompt: "Choose a supported value for Formal Leaf Thinking Selection.",
  });
  return LEAF_THINKING_VALUES.find((value) => value === selected);
}

async function chooseFormalLeafModel(ctx: MinimalCommandContext) {
  if (!ctx.modelRegistry) {
    return promptManualFormalLeafModel(ctx);
  }

  const registryInput = candidateLeafModelInputFromRegistry(ctx.modelRegistry);
  const candidateSet = resolveCandidateLeafModelSet(registryInput);
  if (candidateSet.noReadyModelsMessage) {
    await notifyUser(ctx, candidateSet.noReadyModelsMessage, "warning");
  }
  const selectedDefault = await selectChoiceId({
    choices: [
      ...candidateSet.defaultCandidates.map(modelChoice),
      {
        description: "Secondary action: show all registered models, including missing-auth models.",
        id: SHOW_ALL_REGISTERED_MODELS_ID,
        label: "Show all registered models",
      },
    ],
    ctx,
    defaultChoiceId: candidateSet.defaultCandidates[0]?.id ?? MANUAL_MODEL_ENTRY_ID,
    prompt: "Choose a Candidate Leaf Model Set entry for Formal Leaf Model Selection.",
  });
  const selectedModel =
    selectedDefault === SHOW_ALL_REGISTERED_MODELS_ID
      ? await selectExpandedCandidate({ candidates: candidateSet.expandedCandidates, ctx })
      : candidateSet.defaultCandidates.find((candidate) => candidate.id === selectedDefault);
  if (selectedModel?.id === MANUAL_MODEL_ENTRY_ID) {
    return promptManualFormalLeafModel(ctx);
  }
  if (selectedModel?.warning) {
    await notifyUser(
      ctx,
      `${selectedModel.warning} Selected missing-auth model: ${selectedModel.id}.`,
      "warning",
    );
  }
  return selectedModel?.id;
}

interface InteractiveRepairArgs {
  ctx: MinimalCommandContext;
  doctorOptions: DoctorOptions;
  initialText: string;
  menu: ReturnType<typeof buildDoctorActionMenu>;
  piWorkspacePath?: string;
  report: Awaited<ReturnType<typeof runLambdaRlmDoctor>>;
}

async function cancelInvalidConfigRepair(args: InteractiveRepairArgs) {
  const combinedText = `${args.initialText}\n\nInvalid config repair was cancelled. No normalized rewrite occurred and the Tool Configuration File was left untouched.`;
  await notifyUser(args.ctx, combinedText, "warning");
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      invalidConfigRepair: { action: "cancel_invalid_config_repair", rewritten: false },
    },
  };
}

function invalidConfigDetails(report: InteractiveRepairArgs["report"]) {
  const invalidConfig = report.checks.find(
    (entry) => entry.name === "config" && entry.status === "error",
  );
  const details = invalidConfig?.details ?? {};
  return {
    code: typeof details.code === "string" ? details.code : undefined,
    field: typeof details.field === "string" ? details.field : undefined,
    path: typeof details.path === "string" ? details.path : undefined,
    source: typeof details.source === "string" ? details.source : undefined,
  };
}

function invalidConfigDetailsText(report: InteractiveRepairArgs["report"]) {
  const details = invalidConfigDetails(report);
  return [
    details.code ? `code=${details.code}` : undefined,
    details.field ? `field=${details.field}` : undefined,
    details.source ? `source=${details.source}` : undefined,
    details.path ? `path=${details.path}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

async function rewriteInvalidConfig(args: InteractiveRepairArgs) {
  const globalConfigPath =
    globalConfigPathForWorkspace(args.piWorkspacePath) ?? defaultGlobalConfigPath();
  const details = invalidConfigDetails(args.report);
  const rewriteTarget = details.path ?? globalConfigPath;
  const detailsText = invalidConfigDetailsText(args.report);
  const confirmation = await promptUserText(
    args.ctx,
    `Type REWRITE to confirm normalized rewrite of invalid config at ${rewriteTarget}${detailsText ? ` (${detailsText})` : ""}. A backup will be created before replacement.`,
    "REWRITE",
  );
  const rewrite = await normalizeRewriteInvalidConfig({
    configPath: rewriteTarget,
    confirmed: confirmation === "REWRITE",
  });
  const combinedText = rewrite.rewritten
    ? `${args.initialText}\n\nUser confirmed normalized rewrite. A backup was created at ${rewrite.backupPath} before replacing the Tool Configuration File with a normalized rewrite.`
    : `${args.initialText}\n\nNo normalized rewrite occurred because explicit user confirmation was not provided.`;
  await notifyUser(args.ctx, combinedText, rewrite.rewritten ? "info" : "warning");
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      invalidConfigRepair: { action: "rewrite_invalid_config_normalized", ...rewrite },
    },
  };
}

async function blockUnsafeThinkingSelection(args: InteractiveRepairArgs) {
  const combinedText = `${args.initialText}\n\nFormal Leaf Thinking Selection was not started because initial diagnostics reported invalid Lambda-RLM configuration. Fix the TOML/config error first, then rerun /lambda-rlm-doctor.`;
  await notifyUser(args.ctx, combinedText, "warning");
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      blockedAction: {
        id: "change_formal_leaf_thinking",
        reason: "initial_config_error",
      },
    },
  };
}

async function blockUnsafeModelSelection(args: InteractiveRepairArgs) {
  const combinedText = `${args.initialText}\n\nFormal Leaf Model Selection was not started because initial diagnostics reported invalid Lambda-RLM configuration. Fix the TOML/config error first, then rerun /lambda-rlm-doctor.`;
  await notifyUser(args.ctx, combinedText, "warning");
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      blockedAction: {
        id: "select_formal_leaf_model",
        reason: "initial_config_error",
      },
    },
  };
}

async function blockUnsafeRealFormalLeafSmokeTest(args: InteractiveRepairArgs) {
  const combinedText = `${args.initialText}\n\nThe real Formal Leaf smoke test was not started because initial diagnostics reported invalid Lambda-RLM configuration. Fix the TOML/config error first, then rerun /lambda-rlm-doctor.`;
  await notifyUser(args.ctx, combinedText, "warning");
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      blockedAction: {
        id: "run_real_formal_leaf_smoke_test",
        reason: "initial_config_error",
      },
    },
  };
}

async function runInteractiveThinkingSelection(args: InteractiveRepairArgs) {
  const thinking = await chooseFormalLeafThinking(args.ctx);
  if (!thinking) {
    return;
  }
  const globalConfigPath =
    globalConfigPathForWorkspace(args.piWorkspacePath) ?? defaultGlobalConfigPath();
  const projectConfigPath = defaultProjectConfigPath(args.ctx.cwd ?? process.cwd());
  const selectedTarget = await selectConfigWriteTarget({
    ctx: args.ctx,
    doctorOptions: args.doctorOptions,
    effectiveSource: "thinking",
    globalConfigPath,
    projectConfigPath,
    selectionLabel: "Formal Leaf Thinking Selection",
  });
  if (!selectedTarget) {
    return;
  }
  const writeTarget = selectedTarget === "project" ? projectConfigPath : globalConfigPath;
  const thinkingWrite = await writeFormalLeafThinkingSelection({
    configPath: writeTarget,
    thinking,
  });
  const targetLabel =
    selectedTarget === "project" ? "Project Tool Configuration" : "Global Tool Configuration";
  const combinedText = `${args.initialText}\n\nFormal Leaf Thinking Selection wrote ${thinkingWrite.thinking} to ${targetLabel} (${thinkingWrite.configPath}) using a Targeted Config Edit (${thinkingWrite.kind}); no automatic full diagnostic rerun was required for this thinking-only change.`;
  await notifyUser(args.ctx, combinedText);
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      thinkingWrite: { ...thinkingWrite, target: selectedTarget },
    },
  };
}

async function runInteractiveRealFormalLeafSmokeTest(args: InteractiveRepairArgs) {
  const confirmation = await promptUserText(
    args.ctx,
    "Run real Formal Leaf smoke test? This explicit action will start one Constrained Pi Leaf Call using the configured Formal Leaf model and current leaf command constraints. It may spend model credits or rate limits. Type RUN to continue, or anything else to cancel.",
    "RUN",
  );
  if (confirmation !== "RUN") {
    const combinedText = `${args.initialText}\n\nThe real Formal Leaf smoke test was cancelled. No child Pi model call was started and Normal Doctor Command readiness semantics are unchanged.`;
    await notifyUser(args.ctx, combinedText, "warning");
    return {
      content: [{ text: combinedText, type: "text" }],
      details: {
        ...args.report,
        actions: args.menu,
        realFormalLeafSmokeTest: { ok: false, status: "cancelled" },
      },
    };
  }

  const cwd = args.ctx.cwd ?? process.cwd();
  const configResult = await resolveLambdaRlmConfigWithSources({
    ...args.doctorOptions,
    cwd,
  });
  if (!configResult.ok) {
    const combinedText = `${args.initialText}\n\nThe real Formal Leaf smoke test failed before starting because Lambda-RLM configuration could not be resolved. Fix config and rerun /lambda-rlm-doctor. Normal Doctor Command readiness semantics are unchanged.`;
    await notifyUser(args.ctx, combinedText, "error");
    return {
      content: [{ text: combinedText, type: "text" }],
      details: {
        ...args.report,
        actions: args.menu,
        realFormalLeafSmokeTest: {
          error: configResult.error,
          ok: false,
          status: "failed_before_start",
        },
      },
    };
  }
  const { leaf, run } = configResult.config.config;
  if (!leaf.model) {
    const combinedText = `${args.initialText}\n\nThe real Formal Leaf smoke test failed before starting because no Formal Leaf model is configured. Choose a Formal Leaf model first. Normal Doctor Command readiness semantics are unchanged.`;
    await notifyUser(args.ctx, combinedText, "error");
    return {
      content: [{ text: combinedText, type: "text" }],
      details: {
        ...args.report,
        actions: args.menu,
        realFormalLeafSmokeTest: { ok: false, status: "failed_before_start" },
      },
    };
  }

  try {
    const smoke = await runFormalPiLeafModelCall(
      {
        prompt:
          "real Formal Leaf smoke test: reply exactly with SMOKE_OK. This verifies the configured Formal Leaf model through the current Formal Leaf Profile constraints.",
        requestId: "real-formal-leaf-smoke-test",
      },
      {
        leafModel: leaf.model,
        leafThinking: leaf.thinking,
        piExecutable: leaf.piExecutable,
        ...(args.doctorOptions.processRunner
          ? { processRunner: args.doctorOptions.processRunner }
          : {}),
        timeoutMs: run.modelCallTimeoutMs,
      },
    );
    const combinedText = `${args.initialText}\n\nThe real Formal Leaf smoke test succeeded using Formal Leaf model ${leaf.model}. Child Pi stdout: ${smoke.content || "<empty>"}. Normal Doctor Command readiness semantics are unchanged; this opt-in smoke test does not replace default doctor diagnostics.`;
    await notifyUser(args.ctx, combinedText);
    return {
      content: [{ text: combinedText, type: "text" }],
      details: {
        ...args.report,
        actions: args.menu,
        realFormalLeafSmokeTest: {
          diagnostics: smoke.diagnostics,
          leafModel: leaf.model,
          ok: true,
          status: "succeeded",
        },
      },
    };
  } catch (error) {
    const failure =
      error instanceof LeafProcessFailureError
        ? error.details
        : { error: { code: "unknown", message: String(error), type: "child_process" } };
    const combinedText = `${args.initialText}\n\nThe real Formal Leaf smoke test failed using Formal Leaf model ${leaf.model}. Normal Doctor Command readiness semantics are unchanged; default diagnostics remain based on the non-spending mock bridge check.`;
    await notifyUser(args.ctx, combinedText, "error");
    return {
      content: [{ text: combinedText, type: "text" }],
      details: {
        ...args.report,
        actions: args.menu,
        realFormalLeafSmokeTest: {
          ...failure,
          leafModel: leaf.model,
          ok: false,
          status: "failed",
        },
      },
    };
  }
}

async function runInteractiveModelSelection(args: InteractiveRepairArgs) {
  const model = await chooseFormalLeafModel(args.ctx);
  if (!model?.trim()) {
    return;
  }

  const globalConfigPath =
    globalConfigPathForWorkspace(args.piWorkspacePath) ?? defaultGlobalConfigPath();
  const projectConfigPath = defaultProjectConfigPath(args.ctx.cwd ?? process.cwd());
  const selectedTarget = await selectConfigWriteTarget({
    ctx: args.ctx,
    doctorOptions: args.doctorOptions,
    effectiveSource: "model",
    globalConfigPath,
    projectConfigPath,
    selectionLabel: "Formal Leaf Model Selection",
  });
  if (!selectedTarget) {
    return;
  }
  const writeTarget = selectedTarget === "project" ? projectConfigPath : globalConfigPath;
  const modelWrite = await writeFormalLeafModelSelection({ configPath: writeTarget, model });
  const targetLabel =
    selectedTarget === "project" ? "Project Tool Configuration" : "Global Tool Configuration";
  const rerun = await runLambdaRlmDoctor({
    ...args.doctorOptions,
    globalConfigPath,
    projectConfigPath,
    workspacePath: args.piWorkspacePath ?? dirname(globalConfigPath),
  });
  const rerunText = renderDoctorCommandOutput(rerun, { interactive: true });
  const combinedText = `${args.initialText}\n\nFormal Leaf Model Selection wrote ${modelWrite.model} to ${targetLabel} (${modelWrite.configPath}) using a Targeted Config Edit (${modelWrite.kind}).\n\nDiagnostics after Formal Leaf Model Selection write:\n${rerunText}`;
  await notifyUser(args.ctx, combinedText, rerun.ok ? "info" : "error");
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      modelWrite: { ...modelWrite, target: selectedTarget },
      rerun,
    },
  };
}

async function maybeRunInteractiveModelSelection(args: {
  ctx: MinimalCommandContext;
  doctorOptions: DoctorOptions;
  initialText: string;
  menu: ReturnType<typeof buildDoctorActionMenu> | undefined;
  piWorkspacePath?: string;
  report: Awaited<ReturnType<typeof runLambdaRlmDoctor>>;
}) {
  if (!args.menu || !args.ctx.ui?.select) {
    return;
  }
  const repairArgs = { ...args, menu: args.menu };
  const initialConfigError = args.report.checks.find(
    (check) => check.name === "config" && check.status === "error",
  );
  const invalidConfigDetailsSummary = invalidConfigDetailsText(repairArgs.report);
  const selectedAction = await selectChoiceId({
    choices: args.menu.actions,
    ctx: args.ctx,
    defaultChoiceId: args.menu.defaultActionId,
    prompt: doctorRepairPrompt(
      args.initialText,
      initialConfigError
        ? `Choose explicit repair choices for invalid config before any Doctor Repair Flow mutation${invalidConfigDetailsSummary ? ` (${invalidConfigDetailsSummary})` : ""}.`
        : "Choose a Lambda-RLM Doctor Repair Flow action after diagnostics.",
    ),
  });
  if (selectedAction === "cancel_invalid_config_repair") {
    return cancelInvalidConfigRepair(repairArgs);
  }
  if (selectedAction === "rewrite_invalid_config_normalized") {
    return rewriteInvalidConfig(repairArgs);
  }
  if (selectedAction === "change_formal_leaf_thinking") {
    return initialConfigError
      ? blockUnsafeThinkingSelection(repairArgs)
      : runInteractiveThinkingSelection(repairArgs);
  }
  if (selectedAction === "run_real_formal_leaf_smoke_test") {
    return initialConfigError
      ? blockUnsafeRealFormalLeafSmokeTest(repairArgs)
      : runInteractiveRealFormalLeafSmokeTest(repairArgs);
  }
  if (selectedAction !== "select_formal_leaf_model") {
    return;
  }
  return initialConfigError
    ? blockUnsafeModelSelection(repairArgs)
    : runInteractiveModelSelection(repairArgs);
}

export default function registerLambdaRlmExtension(pi: MinimalPiApi) {
  const modelCallQueueState: { current?: ModelCallConcurrencyQueue } = {};
  if (process.env.NODE_ENV !== "test" || pi.lambdaRlmWorkspacePath) {
    const scaffold = ensureLambdaRlmUserWorkspace(
      pi.lambdaRlmWorkspacePath ? { workspacePath: pi.lambdaRlmWorkspacePath } : {},
    );
    if (scaffold.createdWorkspace) {
      void pi.ui?.notify?.(
        "Lambda-RLM User Workspace created. Run /lambda-rlm-doctor for setup diagnostics and Formal Leaf Model Selection.",
      );
    }
  }

  const doctorCommand = {
    description:
      "Runs non-destructive, workspace-ensuring Lambda-RLM MVP setup diagnostics for Python, config, prompts, fork seams, Pi leaf command shape, and mock bridge readiness.",
    async handler(...args: unknown[]) {
      const ctx = commandContextFromArgs(args);
      const cwd = ctx.cwd ?? process.cwd();
      const globalConfigPath = globalConfigPathForWorkspace(pi.lambdaRlmWorkspacePath);
      const doctorOptions = {
        cwd,
        ...(ctx.leafProcessRunner ? { processRunner: ctx.leafProcessRunner } : {}),
        ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
        ...(pi.lambdaRlmWorkspacePath ? { workspacePath: pi.lambdaRlmWorkspacePath } : {}),
        ...(globalConfigPath ? { globalConfigPath } : {}),
      };
      const report = await runLambdaRlmDoctor(doctorOptions);
      const interactive = Boolean(ctx.ui);
      const text = renderDoctorCommandOutput(report, { interactive });
      const menu = interactive ? buildDoctorActionMenu(report) : undefined;

      const modelSelectionResult = await maybeRunInteractiveModelSelection({
        ctx,
        doctorOptions,
        initialText: text,
        menu,
        ...(pi.lambdaRlmWorkspacePath ? { piWorkspacePath: pi.lambdaRlmWorkspacePath } : {}),
        report,
      });
      if (modelSelectionResult) {
        return modelSelectionResult;
      }

      await notifyUser(ctx, text, report.ok ? "info" : "error");
      return {
        content: [{ text, type: "text" }],
        details: {
          ...report,
          ...(interactive ? { actions: menu } : { mode: "diagnostic-only" }),
        },
      };
    },
  };

  pi.registerCommand?.("lambda-rlm-doctor", doctorCommand);

  pi.registerTool({
    description:
      "Use lambda_rlm for long-context reasoning over one or more readable text files by path when reading them directly would waste or overflow the parent agent context. Good fits include long-file QA, summarization, extraction, synthesis, and diagnosis over large logs, docs, notes, CSV/JSONL exports, session files, or multi-file code/research context. It returns a bounded answer, not source dumps or citation packs.",
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      onUpdate: ((update: ToolUpdate) => void) | undefined,
      ctx: MinimalExtensionContext,
    ) {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: "λ-RLM real path-based run: validating contextPath/contextPaths before starting the Python NDJSON bridge, vendored Lambda-RLM, and Formal Leaf callbacks.",
          },
        ],
        details: { phase: "validate" },
      });
      try {
        return await executeLambdaRlmTool(params, {
          cwd: ctx.cwd,
          ...(ctx.leafProcessRunner ? { leafProcessRunner: ctx.leafProcessRunner } : {}),
          ...(_signal ? { signal: _signal } : {}),
          modelCallQueueState,
        });
      } catch (error) {
        if (error instanceof LambdaRlmValidationError) {
          return {
            content: [
              {
                type: "text",
                text: `lambda_rlm validation failed before execution: ${error.details.error.message}`,
              },
            ],
            details: error.details,
          };
        }
        throw error;
      }
    },
    label: "λ-RLM",
    name: "lambda_rlm",
    parameters: LambdaRlmToolParameters,
    promptGuidelines: [
      "Use lambda_rlm when the task requires long-context reasoning over one or more readable text files by path, especially for answering questions, summarizing, extracting facts, synthesizing across files, analyzing, or diagnosing from context that would waste or overflow parent-agent context if read directly.",
      "Call lambda_rlm with exactly one of contextPath or contextPaths plus question. Pass paths to readable text files only; do not pass inline source text, raw prompts, pasted file contents, URLs, or directories directly. Convert or pack other sources into readable text files first.",
      "Set debug only when explicitly investigating a Lambda-RLM success, failure, or timeout; debug mode writes compact source-free run telemetry to disk and should be omitted during normal use.",
      "Treat lambda_rlm as an Agent Context Avoidance boundary: it reads source files internally and returns a bounded answer rather than the source corpus.",
      "Expect a bounded answer plus compact run metadata. Do not ask lambda_rlm to return full source contents, large evidence packs, full execution traces, or citation dumps by default.",
      "If exact source verification is needed after lambda_rlm answers, use normal narrow follow-up tools such as read or rg on specific files or terms. Do not ask lambda_rlm to dump broad supporting context.",
      "Advanced run-control parameters are for explicit debugging, diagnostics, or retrying after a limit-related failure. Omit them during normal calls.",
    ],
    promptSnippet:
      "Reason over large readable text files by path without loading them into parent-agent context",
  });
}
