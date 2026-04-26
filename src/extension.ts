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
import type { ProcessRunner } from "./leaf-runner.js";
import type { ModelCallConcurrencyQueue } from "./model-call-queue.js";

export const LambdaRlmToolParameters = Type.Object(
  {
    contextPath: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Path to one UTF-8 text file. Pass exactly one of contextPath or contextPaths. The lambda_rlm tool reads this file internally; do not inline file contents.",
      }),
    ),
    contextPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Ordered UTF-8 text file paths for one consolidated Lambda-RLM run. Pass exactly one of contextPath or contextPaths; do not inline file contents.",
      }),
    ),
    maxInputBytes: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Optional per-run tightening for max input bytes; must be less than or equal to the resolved config limit.",
      }),
    ),
    maxModelCalls: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Optional per-run tightening for maximum Formal Leaf model callbacks in this run; must be less than or equal to the resolved config limit.",
      }),
    ),
    modelCallTimeoutMs: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Optional per-run tightening for each Formal Leaf model callback timeout in milliseconds; must be less than or equal to the resolved config limit.",
      }),
    ),
    outputMaxBytes: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Optional per-run tightening for visible output bytes; must be less than or equal to the resolved config limit.",
      }),
    ),
    outputMaxLines: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Optional per-run tightening for visible output lines; must be less than or equal to the resolved config limit.",
      }),
    ),
    question: Type.String({
      minLength: 1,
      description: "Question or instruction to answer using the referenced context file(s).",
    }),
    wholeRunTimeoutMs: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Optional per-run tightening for the whole λ-RLM run timeout in milliseconds; must be less than or equal to the resolved config limit.",
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
    notify?: (message: string) => void | Promise<void>;
    promptText?: (prompt: string) => string | Promise<string>;
    select?: (
      prompt: string,
      choices: { id: string; label: string; description?: string; recommended?: boolean }[],
      defaultChoiceId?: string,
    ) => string | Promise<string>;
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
  return args.ctx.ui?.select?.(
    `Choose the Configuration Write Target for ${args.selectionLabel}.`,
    [
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
    highlightedTarget,
  ) as Promise<ConfigWriteTarget>;
}

function modelChoice(candidate: CandidateLeafModel) {
  return {
    id: candidate.id,
    label: candidate.label,
    ...(candidate.warning ? { description: candidate.warning } : {}),
  };
}

function promptManualFormalLeafModel(ctx: MinimalCommandContext) {
  return ctx.ui?.promptText?.(
    "Enter a manual Formal Leaf model pattern for Formal Leaf Model Selection (for example provider/model-id).",
  );
}

async function selectExpandedCandidate(args: {
  ctx: MinimalCommandContext;
  candidates: CandidateLeafModel[];
}) {
  const expandedChoice = await args.ctx.ui?.select?.(
    "Choose from all registered models for Formal Leaf Model Selection. Missing-auth models are labeled and may still fail doctor until credentials are configured.",
    args.candidates.map(modelChoice),
    args.candidates[0]?.id ?? MANUAL_MODEL_ENTRY_ID,
  );
  return args.candidates.find((candidate) => candidate.id === expandedChoice);
}

function thinkingChoice(thinking: LeafThinking) {
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
  const selected = await ctx.ui?.select?.(
    "Choose a supported value for Formal Leaf Thinking Selection.",
    LEAF_THINKING_VALUES.map(thinkingChoice),
    "off",
  );
  return LEAF_THINKING_VALUES.find((value) => value === selected);
}

async function chooseFormalLeafModel(ctx: MinimalCommandContext) {
  if (!ctx.modelRegistry) {
    return promptManualFormalLeafModel(ctx);
  }

  const registryInput = candidateLeafModelInputFromRegistry(ctx.modelRegistry);
  const candidateSet = resolveCandidateLeafModelSet(registryInput);
  if (candidateSet.noReadyModelsMessage) {
    await ctx.ui?.notify?.(candidateSet.noReadyModelsMessage);
  }
  const selectedDefault = await ctx.ui?.select?.(
    "Choose a Candidate Leaf Model Set entry for Formal Leaf Model Selection.",
    [
      ...candidateSet.defaultCandidates.map(modelChoice),
      {
        description: "Secondary action: show all registered models, including missing-auth models.",
        id: SHOW_ALL_REGISTERED_MODELS_ID,
        label: "Show all registered models",
      },
    ],
    candidateSet.defaultCandidates[0]?.id ?? MANUAL_MODEL_ENTRY_ID,
  );
  const selectedModel =
    selectedDefault === SHOW_ALL_REGISTERED_MODELS_ID
      ? await selectExpandedCandidate({ candidates: candidateSet.expandedCandidates, ctx })
      : candidateSet.defaultCandidates.find((candidate) => candidate.id === selectedDefault);
  if (selectedModel?.id === MANUAL_MODEL_ENTRY_ID) {
    return promptManualFormalLeafModel(ctx);
  }
  if (selectedModel?.warning) {
    await ctx.ui?.notify?.(
      `${selectedModel.warning} Selected missing-auth model: ${selectedModel.id}.`,
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
  await args.ctx.ui?.notify?.(combinedText.split("\n", 1)[0] ?? combinedText);
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
  const confirmation = await args.ctx.ui?.promptText?.(
    `Type REWRITE to confirm normalized rewrite of invalid config at ${rewriteTarget}${detailsText ? ` (${detailsText})` : ""}. A backup will be created before replacement.`,
  );
  const rewrite = await normalizeRewriteInvalidConfig({
    configPath: rewriteTarget,
    confirmed: confirmation === "REWRITE",
  });
  const combinedText = rewrite.rewritten
    ? `${args.initialText}\n\nUser confirmed normalized rewrite. A backup was created at ${rewrite.backupPath} before replacing the Tool Configuration File with a normalized rewrite.`
    : `${args.initialText}\n\nNo normalized rewrite occurred because explicit user confirmation was not provided.`;
  await args.ctx.ui?.notify?.(combinedText.split("\n", 1)[0] ?? combinedText);
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
  await args.ctx.ui?.notify?.(combinedText.split("\n", 1)[0] ?? combinedText);
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
  await args.ctx.ui?.notify?.(combinedText.split("\n", 1)[0] ?? combinedText);
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
  await args.ctx.ui?.notify?.(combinedText.split("\n", 1)[0] ?? combinedText);
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      thinkingWrite: { ...thinkingWrite, target: selectedTarget },
    },
  };
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
  await args.ctx.ui?.notify?.(combinedText.split("\n", 1)[0] ?? combinedText);
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
  const selectedAction = await args.ctx.ui.select(
    initialConfigError
      ? `Choose explicit repair choices for invalid config before any Doctor Repair Flow mutation${invalidConfigDetailsSummary ? ` (${invalidConfigDetailsSummary})` : ""}.`
      : "Choose a Lambda-RLM Doctor Repair Flow action after diagnostics.",
    args.menu.actions,
    args.menu.defaultActionId,
  );
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
        "Lambda-RLM User Workspace created. Add [leaf].model manually, then run /lambda-rlm-doctor to validate setup.",
      );
    }
  }

  pi.registerCommand?.("lambda-rlm-doctor", {
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

      await ctx.ui?.notify?.(text.split("\n", 1)[0] ?? text);
      return {
        content: [{ text, type: "text" }],
        details: {
          ...report,
          ...(interactive ? { actions: menu } : { mode: "diagnostic-only" }),
        },
      };
    },
  });

  pi.registerTool({
    description:
      "Runs real vendored Lambda-RLM over one or more path-based context files through the Python NDJSON bridge, using extension-owned Formal Leaf model callbacks and returning a bounded answer.",
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
      "Use lambda_rlm when a user asks a question over one or more large files by path and ordinary reading would waste parent-agent context.",
      "Call lambda_rlm with exactly one of contextPath or contextPaths plus question, plus optional per-run tightening limits maxInputBytes/outputMaxBytes/outputMaxLines/maxModelCalls/wholeRunTimeoutMs/modelCallTimeoutMs when needed; do not pass inline context or raw prompts.",
      "lambda_rlm reads path-based source input internally, assembles contextPaths into a source manifest plus source-delimited context for one consolidated run, runs vendored real Lambda-RLM planning and execution through the Python NDJSON bridge, and services model callbacks with extension-owned Formal Leaf child Pi calls.",
      "Use maxModelCalls, wholeRunTimeoutMs, and modelCallTimeoutMs only to tighten budgets/deadlines for a single run; they cannot loosen configured defaults.",
      "Expect a bounded result; the tool should not expose the full source file contents by default.",
    ],
    promptSnippet: "Ask a question over referenced context file(s) without inlining file contents",
  });
}
