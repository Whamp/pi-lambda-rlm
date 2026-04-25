import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeProtocolError, BridgeRunFailedError, runSyntheticBridge } from "./bridgeRunner.js";
import { runFormalPiLeafModelCall, type LeafThinking, type ProcessRunner } from "./leafRunner.js";
import {
  DEFAULT_VISIBLE_OUTPUT_LIMIT,
  countLines,
  formatRuntimeFailure,
  formatSuccessResult,
  formatValidationFailure,
  sha256Hex,
  type SourceMetadata,
  type TextContent,
} from "./resultFormatter.js";

const ALLOWED_KEYS = new Set(["contextPath", "question"]);

export type LambdaRlmParams = {
  contextPath: string;
  question: string;
};

export type LambdaRlmToolResult = {
  content: TextContent[];
  details: Record<string, unknown>;
};

export class LambdaRlmValidationError extends Error {
  readonly details: {
    ok: false;
    error: {
      type: "validation";
      code: string;
      message: string;
      field?: string;
    };
    execution: { executionStarted: false; partialDetailsAvailable: false };
  };

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "LambdaRlmValidationError";
    this.details = {
      ok: false,
      error: { type: "validation", code, message, ...(field ? { field } : {}) },
      execution: { executionStarted: false, partialDetailsAvailable: false },
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

function toSourceMetadata(input: { path: string; resolvedPath: string; content: string; bytes: number }): SourceMetadata {
  return {
    path: input.path,
    resolvedPath: input.resolvedPath,
    bytes: input.bytes,
    chars: input.content.length,
    lines: countLines(input.content),
    sha256: sha256Hex(input.content),
  };
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
    /** Internal/test run-control knob; not part of the public lambda_rlm params schema. */
    contextWindowChars?: number;
    /** Internal/default output bound; TOML configurability is intentionally deferred. */
    outputMaxVisibleChars?: number;
    /** Optional directory for recoverable full output when truncation occurs. */
    fullOutputDir?: string;
  } = {},
): Promise<LambdaRlmToolResult> {
  let validated: LambdaRlmParams;
  try {
    validated = validateLambdaRlmParams(params);
  } catch (error) {
    if (error instanceof LambdaRlmValidationError) {
      return formatValidationFailure(error.details.error);
    }
    throw error;
  }

  const cwd = options.cwd ?? process.cwd();
  let loaded: Awaited<ReturnType<typeof loadContextFile>>;
  try {
    loaded = await loadContextFile(validated.contextPath, cwd);
  } catch (error) {
    if (error instanceof LambdaRlmValidationError) {
      return formatValidationFailure(error.details.error);
    }
    throw error;
  }
  const sourceMetadata = toSourceMetadata({ path: validated.contextPath, ...loaded });
  const bridgePath = options.bridgePath ?? fileURLToPath(new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url));
  const runId = `lambda-rlm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const leafModel = options.leafModel ?? process.env.LAMBDA_RLM_LEAF_MODEL ?? "google/gemini-3-flash-preview";
  const leafThinking = options.leafThinking ?? "off";
  const outputOptions = {
    maxVisibleChars: options.outputMaxVisibleChars ?? DEFAULT_VISIBLE_OUTPUT_LIMIT,
    ...(options.fullOutputDir ? { fullOutputDir: options.fullOutputDir } : {}),
    runId,
  };

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
      ...(options.contextWindowChars !== undefined ? { contextWindowChars: options.contextWindowChars } : {}),
    });
  } catch (error) {
    if (error instanceof BridgeRunFailedError) {
      return formatRuntimeFailure({
        error: error.details.error,
        source: sourceMetadata,
        question: validated.question,
        partialBridgeRun: {
          executionStarted: true,
          partialDetailsAvailable: true,
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
          realLambdaRlm: true,
          childPiLeafCalls: error.details.modelCallResponses.length,
          leafProfile: "formal_pi_print",
          leafModel,
          leafThinking,
        },
        output: outputOptions,
      });
    }
    if (error instanceof BridgeProtocolError) {
      return formatRuntimeFailure({
        error: error.details.error,
        source: sourceMetadata,
        question: validated.question,
        partialBridgeRun: {
          executionStarted: true,
          partialDetailsAvailable: true,
          pythonBridge: true,
          protocol: "strict-stdout-stdin-ndjson",
          runId,
          stdoutProtocolLines: error.details.diagnostics.stdoutLines.length,
          stderrDiagnosticsChars: error.details.diagnostics.stderr.length,
          protocolError: {
            code: error.details.error.code,
            message: error.details.error.message,
            ...(error.details.error.line ? { stdoutLine: error.details.error.line } : {}),
          },
          finalResults: 0,
          realLambdaRlm: true,
          childPiLeafCalls: 0,
          leafProfile: "formal_pi_print",
          leafModel,
          leafThinking,
        },
        output: outputOptions,
      });
    }
    throw error;
  }

  const modelCallSummary = {
    total: bridge.modelCallResponses.length,
    succeeded: bridge.modelCallResponses.filter((response) => response.ok).length,
    failed: bridge.modelCallResponses.filter((response) => !response.ok).length,
    phases: bridge.modelCallbacks.map((callback) => callback.metadata?.phase).filter((phase): phase is string => typeof phase === "string"),
  };

  return formatSuccessResult({
    answer: bridge.content,
    source: sourceMetadata,
    question: validated.question,
    modelCallSummary,
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
      realLambdaRlm: true,
      childPiLeafCalls: bridge.modelCallResponses.length,
      leafProfile: "formal_pi_print",
      leafModel,
      leafThinking,
      ...(bridge.metadata ? { lambdaRlm: bridge.metadata } : {}),
    },
    output: outputOptions,
  });
}
