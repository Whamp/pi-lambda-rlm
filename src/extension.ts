import { dirname, join } from "node:path";
import { Type } from "typebox";
import { executeLambdaRlmTool, LambdaRlmValidationError } from "./lambda-rlm-tool.js";
import { buildDoctorActionMenu, renderDoctorCommandOutput, runLambdaRlmDoctor } from "./doctor.js";
import type { DoctorOptions } from "./doctor.js";
import { writeFormalLeafModelSelection } from "./targeted-config-edit.js";
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
  modelRegistry?: {
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

async function maybeRunInteractiveModelSelection(args: {
  ctx: MinimalCommandContext;
  doctorOptions: DoctorOptions;
  initialText: string;
  menu: ReturnType<typeof buildDoctorActionMenu> | undefined;
  piWorkspacePath?: string;
  report: Awaited<ReturnType<typeof runLambdaRlmDoctor>>;
}) {
  if (!args.menu || !args.ctx.ui?.select || !args.ctx.ui.promptText) {
    return;
  }
  const selectedAction = await args.ctx.ui.select(
    "Choose a Lambda-RLM Doctor Repair Flow action after diagnostics.",
    args.menu.actions,
    args.menu.defaultActionId,
  );
  if (selectedAction !== "select_formal_leaf_model") {
    return;
  }
  const initialConfigError = args.report.checks.find(
    (check) => check.name === "config" && check.status === "error",
  );
  if (initialConfigError) {
    const combinedText = `${args.initialText}\n\nFormal Leaf Model Selection was not started because initial diagnostics reported invalid Lambda-RLM configuration. Fix the TOML/config error first, then rerun /lambda-rlm-doctor.`;
    await args.ctx.ui.notify?.(combinedText.split("\n", 1)[0] ?? combinedText);
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
  const model = await args.ctx.ui.promptText(
    "Enter a manual Formal Leaf model pattern for Formal Leaf Model Selection (for example provider/model-id).",
  );
  if (!model.trim()) {
    return;
  }

  const writeTarget =
    globalConfigPathForWorkspace(args.piWorkspacePath) ?? defaultGlobalConfigPath();
  const modelWrite = await writeFormalLeafModelSelection({ configPath: writeTarget, model });
  const rerun = await runLambdaRlmDoctor({
    ...args.doctorOptions,
    globalConfigPath: writeTarget,
    workspacePath: args.piWorkspacePath ?? dirname(writeTarget),
  });
  const rerunText = renderDoctorCommandOutput(rerun, { interactive: true });
  const combinedText = `${args.initialText}\n\nFormal Leaf Model Selection wrote ${modelWrite.model} to Global Tool Configuration (${modelWrite.configPath}) using a Targeted Config Edit (${modelWrite.kind}).\n\nDiagnostics after Formal Leaf Model Selection write:\n${rerunText}`;
  await args.ctx.ui.notify?.(combinedText.split("\n", 1)[0] ?? combinedText);
  return {
    content: [{ text: combinedText, type: "text" }],
    details: {
      ...args.report,
      actions: args.menu,
      modelWrite: { ...modelWrite, target: "global" },
      rerun,
    },
  };
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
