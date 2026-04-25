import { Type } from "typebox";
import { executeLambdaRlmTool, LambdaRlmValidationError } from "./lambdaRlmTool.js";
import type { ProcessRunner } from "./leafRunner.js";
import type { ModelCallConcurrencyQueue } from "./modelCallQueue.js";

export const LambdaRlmToolParameters = Type.Object(
  {
    contextPath: Type.String({
      minLength: 1,
      description: "Path to a single UTF-8 text file. The lambda_rlm tool reads this file internally; do not inline file contents.",
    }),
    question: Type.String({
      minLength: 1,
      description: "Question or instruction to answer using the referenced context file.",
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
  { additionalProperties: false },
);

type ToolUpdate = { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> };
type MinimalPiApi = { registerTool(tool: Record<string, unknown>): void };
type MinimalExtensionContext = {
  cwd: string;
  leafProcessRunner?: ProcessRunner;
};

export default function registerLambdaRlmExtension(pi: MinimalPiApi) {
  const modelCallQueueState: { current?: ModelCallConcurrencyQueue } = {};

  pi.registerTool({
    name: "lambda_rlm",
    label: "λ-RLM",
    description:
      "Runs real vendored Lambda-RLM over one path-based context file through the Python NDJSON bridge, using extension-owned Formal Leaf model callbacks and returning a bounded answer.",
    promptSnippet: "Ask a question over one referenced context file without inlining file contents",
    promptGuidelines: [
      "Use lambda_rlm when a user asks a question over a large file by path and ordinary reading would waste parent-agent context.",
      "Call lambda_rlm with contextPath and question, plus optional per-run tightening limits maxInputBytes/outputMaxBytes/outputMaxLines/maxModelCalls/wholeRunTimeoutMs/modelCallTimeoutMs when needed; do not pass inline context, raw prompts, or multiple paths.",
      "lambda_rlm reads the path-based single-file input internally, runs vendored real Lambda-RLM planning and execution through the Python NDJSON bridge, and services model callbacks with extension-owned Formal Leaf child Pi calls.",
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
            text: "λ-RLM real path-based run: validating contextPath before starting the Python NDJSON bridge, vendored Lambda-RLM, and Formal Leaf callbacks.",
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
