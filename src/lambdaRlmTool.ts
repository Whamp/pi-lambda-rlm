import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeProtocolError, BridgeRunFailedError, runSyntheticBridge } from "./bridgeRunner.js";
import { resolveRunConfig, type RunConfig } from "./configResolver.js";
import { runFormalPiLeafModelCall, type LeafThinking, type ProcessRunner } from "./leafRunner.js";
import { ModelCallConcurrencyQueue } from "./modelCallQueue.js";
import { resolvePromptBundle } from "./promptResolver.js";
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

const ALLOWED_KEYS = new Set([
  "contextPath",
  "contextPaths",
  "question",
  "maxInputBytes",
  "outputMaxBytes",
  "outputMaxLines",
  "maxModelCalls",
  "wholeRunTimeoutMs",
  "modelCallTimeoutMs",
]);

export type LambdaRlmParams = {
  contextPath?: string;
  contextPaths?: string[];
  question: string;
  maxInputBytes?: number;
  outputMaxBytes?: number;
  outputMaxLines?: number;
  maxModelCalls?: number;
  wholeRunTimeoutMs?: number;
  modelCallTimeoutMs?: number;
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
    const ambiguous = extraKeys.some((key) => ["context", "prompt", "rawPrompt", "path", "paths"].includes(key));
    throw new LambdaRlmValidationError(
      ambiguous ? "unsupported_input" : "unknown_keys",
      `lambda_rlm only accepts exactly one of contextPath or contextPaths plus question. Rejected key(s): ${extraKeys.join(", ")}.`,
    );
  }

  const hasContextPath = value.contextPath !== undefined;
  const hasContextPaths = value.contextPaths !== undefined;
  if (hasContextPath && hasContextPaths) {
    throw new LambdaRlmValidationError("mixed_context_path_fields", "Pass exactly one of contextPath or contextPaths, not both.", "contextPaths");
  }
  if (!hasContextPath && !hasContextPaths) {
    throw new LambdaRlmValidationError("missing_context_path", "contextPath or contextPaths is required.", "contextPath");
  }

  const contextPath = typeof value.contextPath === "string" ? value.contextPath.trim() : "";
  if (hasContextPath && !contextPath) {
    throw new LambdaRlmValidationError("missing_context_path", "contextPath is required and must be a non-empty string.", "contextPath");
  }

  let contextPaths: string[] | undefined;
  if (hasContextPaths) {
    if (!Array.isArray(value.contextPaths) || value.contextPaths.length === 0) {
      throw new LambdaRlmValidationError("invalid_context_paths", "contextPaths must be a non-empty array of non-empty strings.", "contextPaths");
    }
    contextPaths = value.contextPaths.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
    if (contextPaths.some((entry) => !entry)) {
      throw new LambdaRlmValidationError("invalid_context_paths", "contextPaths must be a non-empty array of non-empty strings.", "contextPaths");
    }
  }

  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question) {
    throw new LambdaRlmValidationError("missing_question", "question is required and must be a non-empty string.", "question");
  }

  const perRun: Partial<Pick<LambdaRlmParams, "maxInputBytes" | "outputMaxBytes" | "outputMaxLines" | "maxModelCalls" | "wholeRunTimeoutMs" | "modelCallTimeoutMs">> = {};
  for (const field of ["maxInputBytes", "outputMaxBytes", "outputMaxLines", "maxModelCalls", "wholeRunTimeoutMs", "modelCallTimeoutMs"] as const) {
    if (value[field] !== undefined) {
      if (!Number.isSafeInteger(value[field]) || (value[field] as number) <= 0) {
        throw new LambdaRlmValidationError("invalid_config_value", `${field} must be a positive safe integer.`, field);
      }
      perRun[field] = value[field] as number;
    }
  }

  if (hasContextPath) {
    return { contextPath, question, ...perRun };
  }
  return { contextPaths: contextPaths!, question, ...perRun };
}

function maxInputBytesError(bytes: number, maxInputBytes: number, field: "contextPath" | "contextPaths") {
  return new LambdaRlmValidationError(
    "max_input_bytes_exceeded",
    `${field} total is ${bytes} bytes, exceeding the resolved max_input_bytes limit of ${maxInputBytes}.`,
    field,
  );
}

type LoadedSource = { sourceNumber: number; path: string; resolvedPath: string; content: string; bytes: number };

async function loadContextSources(contextPaths: string[], cwd: string, maxInputBytes: number, field: "contextPath" | "contextPaths") {
  const prepared: Array<{ sourceNumber: number; path: string; resolvedPath: string; statBytes: number }> = [];
  let statTotal = 0;

  for (const [index, contextPath] of contextPaths.entries()) {
    const normalizedPath = contextPath.startsWith("@") ? contextPath.slice(1) : contextPath;
    const resolvedPath = resolve(cwd, normalizedPath);
    try {
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        throw new LambdaRlmValidationError("unreadable_context_path", `${field} entry is not a readable file: ${contextPath}`, field);
      }
      statTotal += fileStat.size;
      if (statTotal > maxInputBytes) {
        throw maxInputBytesError(statTotal, maxInputBytes, field);
      }
      await access(resolvedPath, fsConstants.R_OK);
      prepared.push({ sourceNumber: index + 1, path: contextPath, resolvedPath, statBytes: fileStat.size });
    } catch (error) {
      if (error instanceof LambdaRlmValidationError) throw error;
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_context_path_file" : "unreadable_context_path";
      throw new LambdaRlmValidationError(code, `Unable to read ${field} before execution: ${contextPath}`, field);
    }
  }

  const loaded: LoadedSource[] = [];
  let readTotal = 0;
  for (const source of prepared) {
    try {
      const content = await readFile(source.resolvedPath, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      readTotal += bytes;
      if (readTotal > maxInputBytes) {
        throw maxInputBytesError(readTotal, maxInputBytes, field);
      }
      loaded.push({ sourceNumber: source.sourceNumber, path: source.path, resolvedPath: source.resolvedPath, content, bytes });
    } catch (error) {
      if (error instanceof LambdaRlmValidationError) throw error;
      throw new LambdaRlmValidationError("unreadable_context_path", `Unable to read ${field} before execution: ${source.path}`, field);
    }
  }
  return loaded;
}

function toSourceMetadata(input: LoadedSource): SourceMetadata {
  return {
    sourceNumber: input.sourceNumber,
    path: input.path,
    resolvedPath: input.resolvedPath,
    bytes: input.bytes,
    chars: input.content.length,
    lines: countLines(input.content),
    sha256: sha256Hex(input.content),
  };
}

function safePromptSource(source: unknown) {
  if (!source || typeof source !== "object") return source;
  const record = source as { layer?: unknown; path?: unknown };
  if (record.layer === "built_in") return { layer: "built_in", path: null };
  return source;
}

function promptMetadata(prompts: Record<string, { source: unknown; shadowedSources: unknown; bytes: number; sha256: string }>) {
  return Object.fromEntries(
    Object.entries(prompts).map(([key, prompt]) => [
      key,
      {
        source: safePromptSource(prompt.source),
        shadowedSources: Array.isArray(prompt.shadowedSources) ? prompt.shadowedSources.map(safePromptSource) : prompt.shadowedSources,
        bytes: prompt.bytes,
        sha256: prompt.sha256,
      },
    ]),
  );
}

function assembleSourceContext(sources: LoadedSource[]) {
  if (sources.length === 1) return sources[0]!.content;
  const manifest = ["Sources:", ...sources.map((source) => `[${source.sourceNumber}] ${source.path} (${source.bytes} bytes)`)].join("\n");
  const delimited = sources
    .map((source) => [`--- BEGIN SOURCE ${source.sourceNumber}: ${source.path} ---`, source.content, `--- END SOURCE ${source.sourceNumber} ---`].join("\n"))
    .join("\n\n");
  return `${manifest}\n\n${delimited}`;
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
    /** Internal/default output bound retained for older tests/callers; TOML outputMaxBytes is preferred. */
    outputMaxVisibleChars?: number;
    /** Test/runtime injection for config source paths; defaults remain ~/.pi/lambda-rlm and <cwd>/.pi/lambda-rlm. */
    homeDir?: string;
    globalConfigPath?: string;
    projectConfigPath?: string;
    /** Test/runtime injection for prompt source paths; defaults remain ~/.pi/lambda-rlm/prompts and <cwd>/.pi/lambda-rlm/prompts. */
    builtInPromptDir?: string;
    globalPromptDir?: string;
    projectPromptDir?: string;
    /** Optional directory for recoverable full output when truncation occurs. */
    fullOutputDir?: string;
    /** Extension-scoped queue injection for tests/host integration. */
    modelCallQueue?: ModelCallConcurrencyQueue;
    /** Mutable extension-instance state used to lazily create one shared queue after config resolution. */
    modelCallQueueState?: { current?: ModelCallConcurrencyQueue };
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
  const configResult = await resolveRunConfig({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.globalConfigPath ? { globalConfigPath: options.globalConfigPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    perRun: {
      ...(validated.maxInputBytes !== undefined ? { maxInputBytes: validated.maxInputBytes } : {}),
      ...(validated.outputMaxBytes !== undefined ? { outputMaxBytes: validated.outputMaxBytes } : {}),
      ...(validated.outputMaxLines !== undefined ? { outputMaxLines: validated.outputMaxLines } : {}),
      ...(validated.maxModelCalls !== undefined ? { maxModelCalls: validated.maxModelCalls } : {}),
      ...(validated.wholeRunTimeoutMs !== undefined ? { wholeRunTimeoutMs: validated.wholeRunTimeoutMs } : {}),
      ...(validated.modelCallTimeoutMs !== undefined ? { modelCallTimeoutMs: validated.modelCallTimeoutMs } : {}),
    },
  });
  if (!configResult.ok) {
    return formatValidationFailure(configResult.error);
  }
  let runConfig: RunConfig = configResult.config;
  if (options.outputMaxVisibleChars !== undefined) {
    runConfig = { ...runConfig, outputMaxBytes: Math.min(runConfig.outputMaxBytes, options.outputMaxVisibleChars) };
  }

  const promptResult = await resolvePromptBundle({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.builtInPromptDir ? { builtInPromptDir: options.builtInPromptDir } : {}),
    ...(options.globalPromptDir ? { globalPromptDir: options.globalPromptDir } : {}),
    ...(options.projectPromptDir ? { projectPromptDir: options.projectPromptDir } : {}),
  });
  if (!promptResult.ok) {
    return formatValidationFailure(promptResult.error);
  }
  const promptBundle = promptResult.bundle;
  const promptDetails = promptMetadata(promptBundle.prompts);

  const contextPaths = validated.contextPaths ?? [validated.contextPath!];
  const contextField = validated.contextPaths ? "contextPaths" : "contextPath";
  let loadedSources: Awaited<ReturnType<typeof loadContextSources>>;
  try {
    loadedSources = await loadContextSources(contextPaths, cwd, runConfig.maxInputBytes, contextField);
  } catch (error) {
    if (error instanceof LambdaRlmValidationError) {
      return formatValidationFailure(error.details.error);
    }
    throw error;
  }
  const sourceMetadata = loadedSources.map(toSourceMetadata);
  const assembledContext = assembleSourceContext(loadedSources);
  const bridgePath = options.bridgePath ?? fileURLToPath(new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url));
  const runId = `lambda-rlm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const leafModel = options.leafModel ?? process.env.LAMBDA_RLM_LEAF_MODEL ?? "google/gemini-3-flash-preview";
  const leafThinking = options.leafThinking ?? "off";
  const modelCallQueue =
    options.modelCallQueue ??
    (options.modelCallQueueState
      ? (options.modelCallQueueState.current ??= new ModelCallConcurrencyQueue({ concurrency: runConfig.modelProcessConcurrency }))
      : new ModelCallConcurrencyQueue({ concurrency: runConfig.modelProcessConcurrency }));

  const outputOptions = {
    maxVisibleChars: options.outputMaxVisibleChars ?? DEFAULT_VISIBLE_OUTPUT_LIMIT,
    maxVisibleBytes: runConfig.outputMaxBytes,
    maxVisibleLines: runConfig.outputMaxLines,
    ...(options.fullOutputDir ? { fullOutputDir: options.fullOutputDir } : {}),
    runId,
  };

  let bridge;
  try {
    bridge = await runSyntheticBridge({
      bridgePath,
      runId,
      contextPath: loadedSources.length === 1 ? loadedSources[0]!.resolvedPath : "<assembled-context>",
      context: assembledContext,
      question: validated.question,
      modelCallRunner: (call) =>
        modelCallQueue.run(call, (queuedCall) =>
          runFormalPiLeafModelCall(queuedCall, {
            ...(options.piExecutable ? { piExecutable: options.piExecutable } : {}),
            leafModel,
            leafThinking,
            timeoutMs: options.leafTimeoutMs !== undefined ? Math.min(options.leafTimeoutMs, runConfig.modelCallTimeoutMs) : runConfig.modelCallTimeoutMs,
            ...(queuedCall.signal ? { signal: queuedCall.signal } : {}),
            systemPrompt: promptBundle.formalLeafSystemPrompt,
            ...(options.leafProcessRunner ? { processRunner: options.leafProcessRunner } : {}),
          }),
        ),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.contextWindowChars !== undefined ? { contextWindowChars: options.contextWindowChars } : {}),
      maxModelCalls: runConfig.maxModelCalls,
      wholeRunTimeoutMs: runConfig.wholeRunTimeoutMs,
      promptBundle,
    });
  } catch (error) {
    if (error instanceof BridgeRunFailedError) {
      return formatRuntimeFailure({
        error: error.details.error,
        sources: sourceMetadata,
        question: validated.question,
        partialBridgeRun: {
          executionStarted: true,
          partialDetailsAvailable: true,
          pythonBridge: true,
          protocol: "strict-stdout-stdin-ndjson",
          runId,
          stdoutProtocolLines: error.details.diagnostics.stdout.lines,
          stdoutProtocolBytes: error.details.diagnostics.stdout.bytes,
          stdoutProtocolSha256: error.details.diagnostics.stdout.sha256,
          stderrDiagnosticsChars: error.details.diagnostics.stderr.chars,
          stderrDiagnosticsBytes: error.details.diagnostics.stderr.bytes,
          stderrDiagnosticsSha256: error.details.diagnostics.stderr.sha256,
          modelCallResponses: error.details.modelCallResponses.map((response) => ({
            ok: response.ok,
            requestId: response.requestId,
            status: response.ok ? "succeeded" : "failed",
            ...(response.metadata ? { metadata: response.metadata } : {}),
            ...(response.ok
              ? { stdoutChars: response.diagnostics.stdoutChars }
              : { error: response.error, diagnostics: response.diagnostics }),
          })),
          failedRunResult: error.details.failedRunResult,
          finalResults: error.details.finalResults,
          realLambdaRlm: true,
          childPiLeafCalls:
            typeof error.details.failedRunResult.modelCalls === "number" ? error.details.failedRunResult.modelCalls : error.details.modelCallResponses.length,
          leafProfile: "formal_pi_print",
          leafModel,
          leafThinking,
          runControls: runConfig,
          prompts: promptDetails,
        },
        output: outputOptions,
      });
    }
    if (error instanceof BridgeProtocolError) {
      return formatRuntimeFailure({
        error: error.details.error,
        sources: sourceMetadata,
        question: validated.question,
        partialBridgeRun: {
          executionStarted: true,
          partialDetailsAvailable: true,
          pythonBridge: true,
          protocol: "strict-stdout-stdin-ndjson",
          runId,
          stdoutProtocolLines: error.details.diagnostics.stdout.lines,
          stdoutProtocolBytes: error.details.diagnostics.stdout.bytes,
          stdoutProtocolSha256: error.details.diagnostics.stdout.sha256,
          stderrDiagnosticsChars: error.details.diagnostics.stderr.chars,
          stderrDiagnosticsBytes: error.details.diagnostics.stderr.bytes,
          stderrDiagnosticsSha256: error.details.diagnostics.stderr.sha256,
          protocolError: {
            code: error.details.error.code,
            message: error.details.error.message,
            ...(error.details.diagnostics.offendingLine ? { offendingStdoutLine: error.details.diagnostics.offendingLine } : {}),
          },
          ...(error.details.finalResults !== undefined ? { finalResults: error.details.finalResults } : {}),
          realLambdaRlm: true,
          childPiLeafCalls: 0,
          leafProfile: "formal_pi_print",
          leafModel,
          leafThinking,
          runControls: runConfig,
          prompts: promptDetails,
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
    sources: sourceMetadata,
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
      modelCallResponses: bridge.modelCallResponses.map((response) => {
        const callback = bridge.modelCallbacks.find((modelCallback) => modelCallback.requestId === response.requestId);
        return {
          ok: response.ok,
          requestId: response.requestId,
          status: response.ok ? "succeeded" : "failed",
          ...(callback?.metadata ? { metadata: callback.metadata } : {}),
          ...(response.ok ? { stdoutChars: response.diagnostics.stdoutChars } : { error: response.error }),
        };
      }),
      finalResults: bridge.finalResults.length,
      realLambdaRlm: true,
      childPiLeafCalls: bridge.modelCallResponses.length,
      leafProfile: "formal_pi_print",
      leafModel,
      leafThinking,
      runControls: runConfig,
      prompts: promptDetails,
      ...(bridge.metadata ? { lambdaRlm: bridge.metadata } : {}),
    },
    output: outputOptions,
  });
}
