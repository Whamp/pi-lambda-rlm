import { Type } from "typebox";
import { executeLambdaRlmTool, LambdaRlmValidationError } from "./lambdaRlmTool.js";
import { runLambdaRlmDoctor } from "./doctor.js";
import type { ProcessRunner } from "./leafRunner.js";
import type { ModelCallConcurrencyQueue } from "./modelCallQueue.js";

export const LambdaRlmToolParameters = Type.Object(
  {
    contextPath: Type.Optional(Type.String({
      minLength: 1,
      description: "Path to one UTF-8 text file. Pass exactly one of contextPath or contextPaths. The lambda_rlm tool reads this file internally; do not inline file contents.",
    })),
    contextPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Ordered UTF-8 text file paths for one consolidated Lambda-RLM run. Pass exactly one of contextPath or contextPaths; do not inline file contents.",
    })),
    question: Type.String({
      minLength: 1,
      description: "Question or instruction to answer using the referenced context file(s).",
    }),
    maxInputBytes: Type.Optional(Type.Number({
      minimum: 1,
      description: "Optional per-run tightening for max input bytes; must be less than or equal to the resolved config limit.",
    })),
    outputMaxBytes: Type.Optional(Type.Number({
      minimum: 1,
      description: "Optional per-run tightening for visible output bytes; must be less than or equal to the resolved config limit.",
    })),
    outputMaxLines: Type.Optional(Type.Number({
      minimum: 1,
      description: "Optional per-run tightening for visible output lines; must be less than or equal to the resolved config limit.",
    })),
    maxModelCalls: Type.Optional(Type.Number({
      minimum: 1,
      description: "Optional per-run tightening for maximum Formal Leaf model callbacks in this run; must be less than or equal to the resolved config limit.",
    })),
    wholeRunTimeoutMs: Type.Optional(Type.Number({
      minimum: 1,
      description: "Optional per-run tightening for the whole λ-RLM run timeout in milliseconds; must be less than or equal to the resolved config limit.",
    })),
    modelCallTimeoutMs: Type.Optional(Type.Number({
      minimum: 1,
      description: "Optional per-run tightening for each Formal Leaf model callback timeout in milliseconds; must be less than or equal to the resolved config limit.",
    })),
  },
  {
    additionalProperties: false,
    oneOf: [
      { required: ["contextPath", "question"], not: { required: ["contextPaths"] } },
      { required: ["contextPaths", "question"], not: { required: ["contextPath"] } },
    ],
  },
);

type ToolUpdate = { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> };
type MinimalPiApi = { registerTool(tool: Record<string, unknown>): void; registerCommand?: (command: Record<string, unknown>) => void };
type MinimalExtensionContext = {
  cwd: string;
  leafProcessRunner?: ProcessRunner;
};

export default function registerLambdaRlmExtension(pi: MinimalPiApi) {
  const modelCallQueueState: { current?: ModelCallConcurrencyQueue } = {};

  pi.registerCommand?.({
    name: "/lambda-rlm-doctor",
    description: "Runs non-mutating Lambda-RLM MVP setup diagnostics for Python, config, prompts, fork seams, Pi leaf command shape, and mock bridge readiness.",
    async execute(_commandId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: MinimalExtensionContext) {
      const report = await runLambdaRlmDoctor({
        cwd: ctx.cwd,
        ...(ctx.leafProcessRunner ? { processRunner: ctx.leafProcessRunner } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `lambda_rlm doctor ${report.ok ? "passed" : "found errors"}: ${report.checks.filter((entry) => entry.status === "error").length} error(s), ${report.checks.filter((entry) => entry.status === "warn").length} warning(s).`,
          },
        ],
        details: report,
      };
    },
  });

  pi.registerTool({
    name: "lambda_rlm",
    label: "λ-RLM",
    description:
      "Runs real vendored Lambda-RLM over one or more path-based context files through the Python NDJSON bridge, using extension-owned Formal Leaf model callbacks and returning a bounded answer.",
    promptSnippet: "Ask a question over referenced context file(s) without inlining file contents",
    promptGuidelines: [
      "Use lambda_rlm when a user asks a question over one or more large files by path and ordinary reading would waste parent-agent context.",
      "Call lambda_rlm with exactly one of contextPath or contextPaths plus question, plus optional per-run tightening limits maxInputBytes/outputMaxBytes/outputMaxLines/maxModelCalls/wholeRunTimeoutMs/modelCallTimeoutMs when needed; do not pass inline context or raw prompts.",
      "lambda_rlm reads path-based source input internally, assembles contextPaths into a source manifest plus source-delimited context for one consolidated run, runs vendored real Lambda-RLM planning and execution through the Python NDJSON bridge, and services model callbacks with extension-owned Formal Leaf child Pi calls.",
      "Use maxModelCalls, wholeRunTimeoutMs, and modelCallTimeoutMs only to tighten budgets/deadlines for a single run; they cannot loosen configured defaults.",
      "Expect a bounded result; the tool should not expose the full source file contents by default.",
    ],
    parameters: LambdaRlmToolParameters,
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
            content: [{ type: "text", text: `lambda_rlm validation failed before execution: ${error.details.error.message}` }],
            details: error.details,
          };
        }
        throw error;
      }
    },
  });
}
