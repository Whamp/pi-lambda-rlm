import { Type } from "typebox";
import { executeLambdaRlmTool, LambdaRlmValidationError } from "./lambdaRlmTool.js";
import type { ProcessRunner } from "./leafRunner.js";

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
  pi.registerTool({
    name: "lambda_rlm",
    label: "λ-RLM",
    description:
      "Synthetic Lambda-RLM NDJSON bridge tracer bullet. Accepts only contextPath plus question, reads the file internally, and services one bridge model callback through a constrained child Pi leaf runner.",
    promptSnippet: "Ask a question over one referenced context file without inlining file contents",
    promptGuidelines: [
      "Use lambda_rlm when a user asks a question over a large file by path and ordinary reading would waste parent-agent context.",
      "Call lambda_rlm with contextPath and question only; do not pass inline context, raw prompts, or multiple paths in this bootstrap slice.",
      "lambda_rlm currently runs a synthetic Python NDJSON bridge and a Formal Leaf Profile child Pi call; it does not run real Lambda-RLM yet.",
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
        content: [{ type: "text", text: "λ-RLM synthetic bridge: validating path input and preparing a constrained child Pi leaf call." }],
        details: { phase: "validate" },
      });
      try {
        return await executeLambdaRlmTool(params, {
          cwd: ctx.cwd,
          ...(ctx.leafProcessRunner ? { leafProcessRunner: ctx.leafProcessRunner } : {}),
          ...(_signal ? { signal: _signal } : {}),
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
