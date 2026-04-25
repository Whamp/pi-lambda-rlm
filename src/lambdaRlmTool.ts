import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeRunFailedError, runSyntheticBridge } from "./bridgeRunner.js";
import { runFormalPiLeafModelCall, type LeafThinking, type ProcessRunner } from "./leafRunner.js";

const ALLOWED_KEYS = new Set(["contextPath", "question"]);
const VISIBLE_OUTPUT_LIMIT = 4096;

export type LambdaRlmParams = {
  contextPath: string;
  question: string;
};

type TextContent = { type: "text"; text: string };

export type LambdaRlmToolResult = {
  content: TextContent[];
  details: Record<string, unknown>;
};

export class LambdaRlmRuntimeError extends Error {
  readonly details: {
    ok: false;
    error: { type: "runtime"; code: string; message: string };
    bridgeRun: Record<string, unknown>;
  };

  constructor(details: LambdaRlmRuntimeError["details"]) {
    super(details.error.message);
    this.name = "LambdaRlmRuntimeError";
    this.details = details;
  }
}

export class LambdaRlmValidationError extends Error {
  readonly details: {
    ok: false;
    error: {
      type: "validation";
      code: string;
      message: string;
      field?: string;
    };
    fakeRun: { executionStarted: false };
  };

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "LambdaRlmValidationError";
    this.details = {
      ok: false,
      error: { type: "validation", code, message, ...(field ? { field } : {}) },
      fakeRun: { executionStarted: false },
    };
  }
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LambdaRlmValidationError("invalid_params", "lambda_rlm parameters must be an object.");
  }
}

export function validateLambdaRlmParams(value: unknown): LambdaRlmParams {
  assertPlainObject(value);

  const extraKeys = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (extraKeys.length > 0) {
    const ambiguous = extraKeys.some((key) => ["context", "prompt", "rawPrompt", "contextPaths", "path", "paths"].includes(key));
    throw new LambdaRlmValidationError(
      ambiguous ? "unsupported_input" : "unknown_keys",
      `lambda_rlm only accepts contextPath and question. Rejected key(s): ${extraKeys.join(", ")}.`,
    );
  }

  const contextPath = typeof value.contextPath === "string" ? value.contextPath.trim() : "";
  if (!contextPath) {
    throw new LambdaRlmValidationError("missing_context_path", "contextPath is required and must be a non-empty string.", "contextPath");
  }

  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question) {
    throw new LambdaRlmValidationError("missing_question", "question is required and must be a non-empty string.", "question");
  }

  return { contextPath, question };
}

async function loadContextFile(contextPath: string, cwd: string) {
  const normalizedPath = contextPath.startsWith("@") ? contextPath.slice(1) : contextPath;
  const resolvedPath = resolve(cwd, normalizedPath);

  try {
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      throw new LambdaRlmValidationError("unreadable_context_path", `contextPath is not a readable file: ${contextPath}`, "contextPath");
    }

    const content = await readFile(resolvedPath, "utf8");
    return { resolvedPath, content, bytes: fileStat.size };
  } catch (error) {
    if (error instanceof LambdaRlmValidationError) throw error;
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_context_path_file" : "unreadable_context_path";
    throw new LambdaRlmValidationError(code, `Unable to read contextPath before execution: ${contextPath}`, "contextPath");
  }
}

function boundedText(text: string) {
  if (text.length <= VISIBLE_OUTPUT_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, VISIBLE_OUTPUT_LIMIT - 80) + "\n[Fake λ-RLM output truncated to stay within tool bounds.]", truncated: true };
}

function countLines(text: string) {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

export async function executeLambdaRlmTool(
  params: unknown,
  options: {
    cwd?: string;
    bridgePath?: string;
    signal?: AbortSignal;
    piExecutable?: string;
    leafModel?: string;
    leafThinking?: LeafThinking;
    leafProcessRunner?: ProcessRunner;
    leafTimeoutMs?: number;
  } = {},
): Promise<LambdaRlmToolResult> {
  const validated = validateLambdaRlmParams(params);
  const cwd = options.cwd ?? process.cwd();
  const loaded = await loadContextFile(validated.contextPath, cwd);
  const bridgePath = options.bridgePath ?? fileURLToPath(new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url));
  const runId = `lambda-rlm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const leafModel = options.leafModel ?? process.env.LAMBDA_RLM_LEAF_MODEL ?? "google/gemini-3-flash-preview";
  const leafThinking = options.leafThinking ?? "off";

  let bridge;
  try {
    bridge = await runSyntheticBridge({
      bridgePath,
      runId,
      contextPath: loaded.resolvedPath,
      question: validated.question,
      modelCallRunner: (call) =>
        runFormalPiLeafModelCall(call, {
          ...(options.piExecutable ? { piExecutable: options.piExecutable } : {}),
          leafModel,
          leafThinking,
          ...(options.leafTimeoutMs !== undefined ? { timeoutMs: options.leafTimeoutMs } : {}),
          ...(options.leafProcessRunner ? { processRunner: options.leafProcessRunner } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof BridgeRunFailedError) {
      throw new LambdaRlmRuntimeError({
        ok: false,
        error: error.details.error,
        bridgeRun: {
          executionStarted: true,
          pythonBridge: true,
          protocol: "strict-stdout-stdin-ndjson",
          runId,
          stdoutProtocolLines: error.details.diagnostics.stdoutLines.length,
          stderrDiagnosticsChars: error.details.diagnostics.stderr.length,
          modelCallResponses: error.details.modelCallResponses.map((response) => ({
            ok: response.ok,
            requestId: response.requestId,
            ...(response.ok
              ? { stdoutChars: response.diagnostics.stdoutChars }
              : { error: response.error, diagnostics: response.diagnostics }),
          })),
          failedRunResult: error.details.failedRunResult,
          finalResults: 1,
          realLambdaRlm: false,
          childPiLeafCalls: error.details.modelCallResponses.length,
          leafProfile: "formal_pi_print",
          leafModel,
          leafThinking,
        },
      });
    }
    throw error;
  }

  const rawAnswer = [
    "Synthetic λ-RLM bridge answer",
    "",
    bridge.content,
    "",
    `The extension read the referenced file internally (${loaded.content.length} characters, ${countLines(loaded.content)} lines), started the Python NDJSON bridge, serviced one synthetic model callback with a constrained child Pi leaf runner, and received one final run result.`,
    "This tracer bullet does not run real Lambda-RLM yet; it proves the bridge-to-leaf-runner path and Formal Leaf command shape.",
  ].join("\n");
  const answer = boundedText(rawAnswer);

  return {
    content: [{ type: "text", text: answer.text }],
    details: {
      ok: true,
      input: {
        source: "file",
        contextPath: validated.contextPath,
        resolvedContextPath: loaded.resolvedPath,
        contextChars: loaded.content.length,
        contextBytes: loaded.bytes,
        contextLines: countLines(loaded.content),
        questionChars: validated.question.length,
      },
      bridgeRun: {
        executionStarted: true,
        pythonBridge: true,
        protocol: "strict-stdout-stdin-ndjson",
        runId,
        stdoutProtocolLines: bridge.stdoutLines.length,
        stderrDiagnosticsChars: bridge.stderr.length,
        modelCallbacks: bridge.modelCallbacks.map((callback) => ({
          requestId: callback.requestId,
          metadata: callback.metadata,
          promptChars: callback.prompt.length,
        })),
        modelCallResponses: bridge.modelCallResponses.map((response) => ({
          ok: response.ok,
          requestId: response.requestId,
          ...(response.ok ? { stdoutChars: response.diagnostics.stdoutChars } : { error: response.error }),
        })),
        finalResults: bridge.finalResults.length,
        realLambdaRlm: false,
        childPiLeafCalls: bridge.modelCallResponses.length,
        leafProfile: "formal_pi_print",
        leafModel,
        leafThinking,
      },
      fakeRun: {
        engine: "synthetic-python-ndjson-bridge",
        executionStarted: true,
        pythonBridge: true,
        realLambdaRlm: false,
        childPiLeafCalls: bridge.modelCallResponses.length,
      },
      output: {
        bounded: true,
        visibleChars: answer.text.length,
        truncated: answer.truncated,
        maxVisibleChars: VISIBLE_OUTPUT_LIMIT,
      },
      warnings: ["Synthetic bridge tracer bullet only; real Lambda-RLM is intentionally out of scope for this slice."],
    },
  };
}
