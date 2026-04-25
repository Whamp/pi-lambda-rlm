import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeProtocolError, BridgeRunFailedError, runSyntheticBridge } from "./bridge-runner.js";
import type { ModelCallRunner } from "./bridge-runner.js";
import { resolveRunConfig } from "./config-resolver.js";
import type { RunConfig } from "./config-resolver.js";
import { runFormalPiLeafModelCall } from "./leaf-runner.js";
import type { LeafThinking, ProcessRunner } from "./leaf-runner.js";
import { ModelCallConcurrencyQueue } from "./model-call-queue.js";
import { resolvePromptBundle } from "./prompt-resolver.js";
import type { ResolvedPromptBundle } from "./prompt-resolver.js";
import {
  DEFAULT_VISIBLE_OUTPUT_LIMIT,
  countLines,
  formatRuntimeFailure,
  formatSuccessResult,
  formatValidationFailure,
  sha256Hex,
} from "./result-formatter.js";
import type { OutputLimitOptions, SourceMetadata, TextContent } from "./result-formatter.js";

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

export interface LambdaRlmParams {
  contextPath?: string;
  contextPaths?: string[];
  question: string;
  maxInputBytes?: number;
  outputMaxBytes?: number;
  outputMaxLines?: number;
  maxModelCalls?: number;
  wholeRunTimeoutMs?: number;
  modelCallTimeoutMs?: number;
}

export interface LambdaRlmToolResult {
  content: TextContent[];
  details: Record<string, unknown>;
}

export interface ExecuteLambdaRlmToolOptions {
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
    execution: { executionStarted: false; partialDetailsAvailable: false };
  };

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "LambdaRlmValidationError";
    this.details = {
      error: { code, message, type: "validation", ...(field ? { field } : {}) },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
    };
  }
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LambdaRlmValidationError(
      "invalid_params",
      "lambda_rlm parameters must be an object.",
    );
  }
}

const AMBIGUOUS_REJECTED_KEYS = new Set(["context", "prompt", "rawPrompt", "path", "paths"]);
const PER_RUN_FIELDS = [
  "maxInputBytes",
  "outputMaxBytes",
  "outputMaxLines",
  "maxModelCalls",
  "wholeRunTimeoutMs",
  "modelCallTimeoutMs",
] as const;

type PerRunField = (typeof PER_RUN_FIELDS)[number];
type PerRunOptions = Partial<Pick<LambdaRlmParams, PerRunField>>;

function rejectUnknownKeys(value: Record<string, unknown>) {
  const extraKeys = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (extraKeys.length === 0) {
    return;
  }
  const ambiguous = extraKeys.some((key) => AMBIGUOUS_REJECTED_KEYS.has(key));
  throw new LambdaRlmValidationError(
    ambiguous ? "unsupported_input" : "unknown_keys",
    `lambda_rlm only accepts exactly one of contextPath or contextPaths plus question. Rejected key(s): ${extraKeys.join(", ")}.`,
  );
}

function validatedContextPath(value: Record<string, unknown>, enabled: boolean) {
  const contextPath = typeof value.contextPath === "string" ? value.contextPath.trim() : "";
  if (enabled && contextPath.length === 0) {
    throw new LambdaRlmValidationError(
      "missing_context_path",
      "contextPath is required and must be a non-empty string.",
      "contextPath",
    );
  }
  return contextPath;
}

function validatedContextPaths(value: Record<string, unknown>, enabled: boolean) {
  if (enabled === false) {
    return;
  }
  if (!Array.isArray(value.contextPaths) || value.contextPaths.length === 0) {
    throw new LambdaRlmValidationError(
      "invalid_context_paths",
      "contextPaths must be a non-empty array of non-empty strings.",
      "contextPaths",
    );
  }
  const contextPaths = value.contextPaths.map((entry) =>
    typeof entry === "string" ? entry.trim() : "",
  );
  if (contextPaths.some((entry) => entry.length === 0)) {
    throw new LambdaRlmValidationError(
      "invalid_context_paths",
      "contextPaths must be a non-empty array of non-empty strings.",
      "contextPaths",
    );
  }
  return contextPaths;
}

function validatedQuestion(value: Record<string, unknown>) {
  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (question.length === 0) {
    throw new LambdaRlmValidationError(
      "missing_question",
      "question is required and must be a non-empty string.",
      "question",
    );
  }
  return question;
}

function validatedPerRunOptions(value: Record<string, unknown>) {
  const perRun: PerRunOptions = {};
  for (const field of PER_RUN_FIELDS) {
    if (value[field] !== undefined) {
      if (!Number.isSafeInteger(value[field]) || (value[field] as number) <= 0) {
        throw new LambdaRlmValidationError(
          "invalid_config_value",
          `${field} must be a positive safe integer.`,
          field,
        );
      }
      perRun[field] = value[field] as number;
    }
  }
  return perRun;
}

export function validateLambdaRlmParams(value: unknown): LambdaRlmParams {
  assertPlainObject(value);
  rejectUnknownKeys(value);

  const hasContextPath = value.contextPath !== undefined;
  const hasContextPaths = value.contextPaths !== undefined;
  if (hasContextPath && hasContextPaths) {
    throw new LambdaRlmValidationError(
      "mixed_context_path_fields",
      "Pass exactly one of contextPath or contextPaths, not both.",
      "contextPaths",
    );
  }
  if (hasContextPath === false && hasContextPaths === false) {
    throw new LambdaRlmValidationError(
      "missing_context_path",
      "contextPath or contextPaths is required.",
      "contextPath",
    );
  }

  const contextPath = validatedContextPath(value, hasContextPath);
  const contextPaths = validatedContextPaths(value, hasContextPaths);
  const question = validatedQuestion(value);
  const perRun = validatedPerRunOptions(value);

  if (hasContextPath) {
    return { contextPath, question, ...perRun };
  }
  if (contextPaths === undefined) {
    throw new LambdaRlmValidationError(
      "invalid_context_paths",
      "contextPaths must be a non-empty array of non-empty strings.",
      "contextPaths",
    );
  }
  return { contextPaths, question, ...perRun };
}

function maxInputBytesError(
  bytes: number,
  maxInputBytes: number,
  field: "contextPath" | "contextPaths",
) {
  return new LambdaRlmValidationError(
    "max_input_bytes_exceeded",
    `${field} total is ${bytes} bytes, exceeding the resolved max_input_bytes limit of ${maxInputBytes}.`,
    field,
  );
}

interface LoadedSource {
  sourceNumber: number;
  path: string;
  resolvedPath: string;
  content: string;
  bytes: number;
}

async function loadContextSources(
  contextPaths: string[],
  cwd: string,
  maxInputBytes: number,
  field: "contextPath" | "contextPaths",
) {
  const prepared: {
    sourceNumber: number;
    path: string;
    resolvedPath: string;
    statBytes: number;
  }[] = [];
  let statTotal = 0;

  for (const [index, contextPath] of contextPaths.entries()) {
    const normalizedPath = contextPath.startsWith("@") ? contextPath.slice(1) : contextPath;
    const resolvedPath = resolve(cwd, normalizedPath);
    try {
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        throw new LambdaRlmValidationError(
          "unreadable_context_path",
          `${field} entry is not a readable file: ${contextPath}`,
          field,
        );
      }
      statTotal += fileStat.size;
      if (statTotal > maxInputBytes) {
        throw maxInputBytesError(statTotal, maxInputBytes, field);
      }
      await access(resolvedPath, fsConstants.R_OK);
      prepared.push({
        path: contextPath,
        resolvedPath,
        sourceNumber: index + 1,
        statBytes: fileStat.size,
      });
    } catch (error) {
      if (error instanceof LambdaRlmValidationError) {
        throw error;
      }
      const code =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing_context_path_file"
          : "unreadable_context_path";
      throw new LambdaRlmValidationError(
        code,
        `Unable to read ${field} before execution: ${contextPath}`,
        field,
      );
    }
  }

  const loaded: LoadedSource[] = [];
  let readTotal = 0;
  for (const source of prepared) {
    try {
      const content = await readFile(source.resolvedPath, "utf-8");
      const bytes = Buffer.byteLength(content, "utf-8");
      readTotal += bytes;
      if (readTotal > maxInputBytes) {
        throw maxInputBytesError(readTotal, maxInputBytes, field);
      }
      loaded.push({
        bytes,
        content,
        path: source.path,
        resolvedPath: source.resolvedPath,
        sourceNumber: source.sourceNumber,
      });
    } catch (error) {
      if (error instanceof LambdaRlmValidationError) {
        throw error;
      }
      throw new LambdaRlmValidationError(
        "unreadable_context_path",
        `Unable to read ${field} before execution: ${source.path}`,
        field,
      );
    }
  }
  return loaded;
}

function toSourceMetadata(input: LoadedSource): SourceMetadata {
  return {
    bytes: input.bytes,
    chars: input.content.length,
    lines: countLines(input.content),
    path: input.path,
    resolvedPath: input.resolvedPath,
    sha256: sha256Hex(input.content),
    sourceNumber: input.sourceNumber,
  };
}

function safePromptSource(source: unknown) {
  if (!source || typeof source !== "object") {
    return source;
  }
  const record = source as { layer?: unknown; path?: unknown };
  if (record.layer === "built_in") {
    return { layer: "built_in", path: null };
  }
  return source;
}

function promptMetadata(
  prompts: Record<
    string,
    { source: unknown; shadowedSources: unknown; bytes: number; sha256: string }
  >,
) {
  return Object.fromEntries(
    Object.entries(prompts).map(([key, prompt]) => [
      key,
      {
        bytes: prompt.bytes,
        sha256: prompt.sha256,
        shadowedSources: Array.isArray(prompt.shadowedSources)
          ? prompt.shadowedSources.map(safePromptSource)
          : prompt.shadowedSources,
        source: safePromptSource(prompt.source),
      },
    ]),
  );
}

function assembleSourceContext(sources: LoadedSource[]) {
  if (sources.length === 1) {
    const [source] = sources;
    if (!source) {
      throw new Error("Expected a single loaded source when assembling source context.");
    }
    return source.content;
  }
  const manifest = [
    "Sources:",
    ...sources.map((source) => `[${source.sourceNumber}] ${source.path} (${source.bytes} bytes)`),
  ].join("\n");
  const delimited = sources
    .map((source) =>
      [
        `--- BEGIN SOURCE ${source.sourceNumber}: ${source.path} ---`,
        source.content,
        `--- END SOURCE ${source.sourceNumber} ---`,
      ].join("\n"),
    )
    .join("\n\n");
  return `${manifest}\n\n${delimited}`;
}

type CompletedBridgeRun = Awaited<ReturnType<typeof runSyntheticBridge>>;

interface RuntimeFormattingContext {
  leafModel: string;
  leafThinking: LeafThinking;
  outputOptions: OutputLimitOptions;
  promptDetails: Record<string, unknown>;
  question: string;
  runConfig: RunConfig;
  runId: string;
  sourceMetadata: SourceMetadata[];
}

function bridgeContextPath(loadedSources: LoadedSource[]) {
  if (loadedSources.length !== 1) {
    return "<assembled-context>";
  }
  return loadedSources[0]?.resolvedPath ?? "<assembled-context>";
}

function modelCallSummaryFromBridge(bridge: CompletedBridgeRun) {
  let failed = 0;
  let succeeded = 0;
  const phases: string[] = [];
  for (const response of bridge.modelCallResponses) {
    if (response.ok) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  }
  for (const modelCallback of bridge.modelCallbacks) {
    const phase = modelCallback.metadata?.phase;
    if (typeof phase === "string") {
      phases.push(phase);
    }
  }
  return { failed, phases, succeeded, total: bridge.modelCallResponses.length };
}

function callbackMetadataByRequestId(bridge: CompletedBridgeRun) {
  const metadataByRequestId = new Map<string, Record<string, unknown>>();
  for (const modelCallback of bridge.modelCallbacks) {
    metadataByRequestId.set(modelCallback.requestId, modelCallback.metadata);
  }
  return metadataByRequestId;
}

function successfulModelCallResponses(bridge: CompletedBridgeRun) {
  const metadataByRequestId = callbackMetadataByRequestId(bridge);
  const summaries: Record<string, unknown>[] = [];
  for (const response of bridge.modelCallResponses) {
    const metadata = metadataByRequestId.get(response.requestId);
    summaries.push({
      ok: response.ok,
      requestId: response.requestId,
      status: response.ok ? "succeeded" : "failed",
      ...(metadata ? { metadata } : {}),
      ...(response.ok
        ? { stdoutChars: response.diagnostics.stdoutChars }
        : { error: response.error }),
    });
  }
  return summaries;
}

function partialModelCallResponses(error: BridgeRunFailedError) {
  const summaries: Record<string, unknown>[] = [];
  for (const response of error.details.modelCallResponses) {
    summaries.push({
      ok: response.ok,
      requestId: response.requestId,
      status: response.ok ? "succeeded" : "failed",
      ...(response.metadata ? { metadata: response.metadata } : {}),
      ...(response.ok
        ? { stdoutChars: response.diagnostics.stdoutChars }
        : { diagnostics: response.diagnostics, error: response.error }),
    });
  }
  return summaries;
}

function modelCallbackSummaries(bridge: CompletedBridgeRun) {
  const summaries: Record<string, unknown>[] = [];
  for (const modelCallback of bridge.modelCallbacks) {
    summaries.push({
      metadata: modelCallback.metadata,
      promptChars: modelCallback.prompt.length,
      requestId: modelCallback.requestId,
    });
  }
  return summaries;
}

function childPiLeafCallsForFailedRun(error: BridgeRunFailedError) {
  const { modelCalls } = error.details.failedRunResult;
  return typeof modelCalls === "number" ? modelCalls : error.details.modelCallResponses.length;
}

function partialRunForBridgeRunFailure(
  error: BridgeRunFailedError,
  context: RuntimeFormattingContext,
) {
  return {
    childPiLeafCalls: childPiLeafCallsForFailedRun(error),
    executionStarted: true,
    failedRunResult: error.details.failedRunResult,
    finalResults: error.details.finalResults,
    leafModel: context.leafModel,
    leafProfile: "formal_pi_print",
    leafThinking: context.leafThinking,
    modelCallResponses: partialModelCallResponses(error),
    partialDetailsAvailable: true,
    prompts: context.promptDetails,
    protocol: "strict-stdout-stdin-ndjson",
    pythonBridge: true,
    realLambdaRlm: true,
    runControls: context.runConfig,
    runId: context.runId,
    stderrDiagnosticsBytes: error.details.diagnostics.stderr.bytes,
    stderrDiagnosticsChars: error.details.diagnostics.stderr.chars,
    stderrDiagnosticsSha256: error.details.diagnostics.stderr.sha256,
    stdoutProtocolBytes: error.details.diagnostics.stdout.bytes,
    stdoutProtocolLines: error.details.diagnostics.stdout.lines,
    stdoutProtocolSha256: error.details.diagnostics.stdout.sha256,
  };
}

function partialRunForBridgeProtocolFailure(
  error: BridgeProtocolError,
  context: RuntimeFormattingContext,
) {
  return {
    childPiLeafCalls: 0,
    executionStarted: true,
    finalResults: error.details.finalResults,
    leafModel: context.leafModel,
    leafProfile: "formal_pi_print",
    leafThinking: context.leafThinking,
    partialDetailsAvailable: true,
    prompts: context.promptDetails,
    protocol: "strict-stdout-stdin-ndjson",
    protocolError: {
      code: error.details.error.code,
      message: error.details.error.message,
      ...(error.details.diagnostics.offendingLine
        ? { offendingStdoutLine: error.details.diagnostics.offendingLine }
        : {}),
    },
    pythonBridge: true,
    realLambdaRlm: true,
    runControls: context.runConfig,
    runId: context.runId,
    stderrDiagnosticsBytes: error.details.diagnostics.stderr.bytes,
    stderrDiagnosticsChars: error.details.diagnostics.stderr.chars,
    stderrDiagnosticsSha256: error.details.diagnostics.stderr.sha256,
    stdoutProtocolBytes: error.details.diagnostics.stdout.bytes,
    stdoutProtocolLines: error.details.diagnostics.stdout.lines,
    stdoutProtocolSha256: error.details.diagnostics.stdout.sha256,
  };
}

function successBridgeRunDetails(bridge: CompletedBridgeRun, context: RuntimeFormattingContext) {
  return {
    childPiLeafCalls: bridge.modelCallResponses.length,
    executionStarted: true,
    finalResults: bridge.finalResults.length,
    leafModel: context.leafModel,
    leafProfile: "formal_pi_print",
    leafThinking: context.leafThinking,
    modelCallResponses: successfulModelCallResponses(bridge),
    modelCallbacks: modelCallbackSummaries(bridge),
    prompts: context.promptDetails,
    protocol: "strict-stdout-stdin-ndjson",
    pythonBridge: true,
    realLambdaRlm: true,
    runControls: context.runConfig,
    runId: context.runId,
    stderrDiagnosticsChars: bridge.stderr.length,
    stdoutProtocolLines: bridge.stdoutLines.length,
    ...(bridge.metadata ? { lambdaRlm: bridge.metadata } : {}),
  };
}

function formatBridgeRuntimeFailure(
  error: BridgeRunFailedError | BridgeProtocolError,
  context: RuntimeFormattingContext,
) {
  return formatRuntimeFailure({
    error: error.details.error,
    output: context.outputOptions,
    partialBridgeRun:
      error instanceof BridgeRunFailedError
        ? partialRunForBridgeRunFailure(error, context)
        : partialRunForBridgeProtocolFailure(error, context),
    question: context.question,
    sources: context.sourceMetadata,
  });
}

function validateParamsForExecution(params: unknown) {
  try {
    return { ok: true as const, validated: validateLambdaRlmParams(params) };
  } catch (error) {
    if (error instanceof LambdaRlmValidationError) {
      return { ok: false as const, result: formatValidationFailure(error.details.error) };
    }
    throw error;
  }
}

function perRunConfigOptions(validated: LambdaRlmParams) {
  const perRun: Partial<Pick<RunConfig, PerRunField>> = {};
  for (const field of PER_RUN_FIELDS) {
    const value = validated[field];
    if (value !== undefined) {
      perRun[field] = value;
    }
  }
  return perRun;
}

async function resolveToolRunConfig(
  validated: LambdaRlmParams,
  options: ExecuteLambdaRlmToolOptions,
  cwd: string,
) {
  const configResult = await resolveRunConfig({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.globalConfigPath ? { globalConfigPath: options.globalConfigPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    perRun: perRunConfigOptions(validated),
  });
  if (!configResult.ok) {
    return { ok: false as const, result: formatValidationFailure(configResult.error) };
  }
  if (options.outputMaxVisibleChars === undefined) {
    return { ok: true as const, runConfig: configResult.config };
  }
  return {
    ok: true as const,
    runConfig: {
      ...configResult.config,
      outputMaxBytes: Math.min(configResult.config.outputMaxBytes, options.outputMaxVisibleChars),
    },
  };
}

async function resolveToolPrompts(options: ExecuteLambdaRlmToolOptions, cwd: string) {
  const promptResult = await resolvePromptBundle({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.builtInPromptDir ? { builtInPromptDir: options.builtInPromptDir } : {}),
    ...(options.globalPromptDir ? { globalPromptDir: options.globalPromptDir } : {}),
    ...(options.projectPromptDir ? { projectPromptDir: options.projectPromptDir } : {}),
  });
  if (!promptResult.ok) {
    return { ok: false as const, result: formatValidationFailure(promptResult.error) };
  }
  return {
    ok: true as const,
    promptBundle: promptResult.bundle,
    promptDetails: promptMetadata(promptResult.bundle.prompts),
  };
}

function contextPathsFor(validated: LambdaRlmParams) {
  return validated.contextPaths ?? (validated.contextPath ? [validated.contextPath] : []);
}

function contextFieldFor(validated: LambdaRlmParams): "contextPath" | "contextPaths" {
  return validated.contextPaths ? "contextPaths" : "contextPath";
}

async function loadToolSources(validated: LambdaRlmParams, cwd: string, runConfig: RunConfig) {
  try {
    return {
      loadedSources: await loadContextSources(
        contextPathsFor(validated),
        cwd,
        runConfig.maxInputBytes,
        contextFieldFor(validated),
      ),
      ok: true as const,
    };
  } catch (error) {
    if (error instanceof LambdaRlmValidationError) {
      return { ok: false as const, result: formatValidationFailure(error.details.error) };
    }
    throw error;
  }
}

function modelCallQueueFor(options: ExecuteLambdaRlmToolOptions, runConfig: RunConfig) {
  if (options.modelCallQueue) {
    return options.modelCallQueue;
  }
  if (options.modelCallQueueState) {
    options.modelCallQueueState.current ??= new ModelCallConcurrencyQueue({
      concurrency: runConfig.modelProcessConcurrency,
    });
    return options.modelCallQueueState.current;
  }
  return new ModelCallConcurrencyQueue({ concurrency: runConfig.modelProcessConcurrency });
}

function leafTimeoutMs(options: ExecuteLambdaRlmToolOptions, runConfig: RunConfig) {
  if (options.leafTimeoutMs === undefined) {
    return runConfig.modelCallTimeoutMs;
  }
  return Math.min(options.leafTimeoutMs, runConfig.modelCallTimeoutMs);
}

function modelCallRunnerFor(args: {
  leafModel: string;
  leafThinking: LeafThinking;
  modelCallQueue: ModelCallConcurrencyQueue;
  options: ExecuteLambdaRlmToolOptions;
  promptBundle: ResolvedPromptBundle;
  runConfig: RunConfig;
}): ModelCallRunner {
  return (call) =>
    args.modelCallQueue.run(call, (queuedCall) =>
      runFormalPiLeafModelCall(queuedCall, {
        ...(args.options.piExecutable ? { piExecutable: args.options.piExecutable } : {}),
        leafModel: args.leafModel,
        leafThinking: args.leafThinking,
        timeoutMs: leafTimeoutMs(args.options, args.runConfig),
        ...(queuedCall.signal ? { signal: queuedCall.signal } : {}),
        systemPrompt: args.promptBundle.formalLeafSystemPrompt,
        ...(args.options.leafProcessRunner
          ? { processRunner: args.options.leafProcessRunner }
          : {}),
      }),
    );
}

function outputOptionsFor(
  options: ExecuteLambdaRlmToolOptions,
  runConfig: RunConfig,
  runId: string,
): OutputLimitOptions {
  return {
    maxVisibleBytes: runConfig.outputMaxBytes,
    maxVisibleChars: options.outputMaxVisibleChars ?? DEFAULT_VISIBLE_OUTPUT_LIMIT,
    maxVisibleLines: runConfig.outputMaxLines,
    ...(options.fullOutputDir ? { fullOutputDir: options.fullOutputDir } : {}),
    runId,
  };
}

function runtimeContextFor(args: {
  leafModel: string;
  leafThinking: LeafThinking;
  outputOptions: OutputLimitOptions;
  promptDetails: Record<string, unknown>;
  question: string;
  runConfig: RunConfig;
  runId: string;
  sourceMetadata: SourceMetadata[];
}): RuntimeFormattingContext {
  return args;
}

function runBridgeForTool(args: {
  assembledContext: string;
  bridgePath: string;
  leafModel: string;
  leafThinking: LeafThinking;
  loadedSources: LoadedSource[];
  modelCallQueue: ModelCallConcurrencyQueue;
  options: ExecuteLambdaRlmToolOptions;
  promptBundle: ResolvedPromptBundle;
  question: string;
  runConfig: RunConfig;
  runId: string;
}) {
  return runSyntheticBridge({
    bridgePath: args.bridgePath,
    context: args.assembledContext,
    contextPath: bridgeContextPath(args.loadedSources),
    maxModelCalls: args.runConfig.maxModelCalls,
    modelCallRunner: modelCallRunnerFor({
      leafModel: args.leafModel,
      leafThinking: args.leafThinking,
      modelCallQueue: args.modelCallQueue,
      options: args.options,
      promptBundle: args.promptBundle,
      runConfig: args.runConfig,
    }),
    promptBundle: args.promptBundle,
    question: args.question,
    runId: args.runId,
    ...(args.options.signal ? { signal: args.options.signal } : {}),
    ...(args.options.contextWindowChars === undefined
      ? {}
      : { contextWindowChars: args.options.contextWindowChars }),
    wholeRunTimeoutMs: args.runConfig.wholeRunTimeoutMs,
  });
}

export async function executeLambdaRlmTool(
  params: unknown,
  options: ExecuteLambdaRlmToolOptions = {},
): Promise<LambdaRlmToolResult> {
  const validation = validateParamsForExecution(params);
  if (!validation.ok) {
    return validation.result;
  }
  const { validated } = validation;
  const cwd = options.cwd ?? process.cwd();

  const config = await resolveToolRunConfig(validated, options, cwd);
  if (!config.ok) {
    return config.result;
  }
  const { runConfig } = config;

  const prompts = await resolveToolPrompts(options, cwd);
  if (!prompts.ok) {
    return prompts.result;
  }
  const { promptBundle, promptDetails } = prompts;

  const sources = await loadToolSources(validated, cwd, runConfig);
  if (!sources.ok) {
    return sources.result;
  }
  const { loadedSources } = sources;
  const sourceMetadata = loadedSources.map(toSourceMetadata);
  const assembledContext = assembleSourceContext(loadedSources);
  const bridgePath =
    options.bridgePath ??
    fileURLToPath(new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url));
  const runId = `lambda-rlm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const leafModel =
    options.leafModel ?? process.env.LAMBDA_RLM_LEAF_MODEL ?? "google/gemini-3-flash-preview";
  const leafThinking = options.leafThinking ?? "off";
  const modelCallQueue = modelCallQueueFor(options, runConfig);
  const outputOptions = outputOptionsFor(options, runConfig, runId);

  let bridge;
  try {
    bridge = await runBridgeForTool({
      assembledContext,
      bridgePath,
      leafModel,
      leafThinking,
      loadedSources,
      modelCallQueue,
      options,
      promptBundle,
      question: validated.question,
      runConfig,
      runId,
    });
  } catch (error) {
    const runtimeContext = runtimeContextFor({
      leafModel,
      leafThinking,
      outputOptions,
      promptDetails,
      question: validated.question,
      runConfig,
      runId,
      sourceMetadata,
    });
    if (error instanceof BridgeRunFailedError || error instanceof BridgeProtocolError) {
      return formatBridgeRuntimeFailure(error, runtimeContext);
    }
    throw error;
  }

  const runtimeContext = runtimeContextFor({
    leafModel,
    leafThinking,
    outputOptions,
    promptDetails,
    question: validated.question,
    runConfig,
    runId,
    sourceMetadata,
  });
  return formatSuccessResult({
    answer: bridge.content,
    bridgeRun: successBridgeRunDetails(bridge, runtimeContext),
    modelCallSummary: modelCallSummaryFromBridge(bridge),
    output: outputOptions,
    question: validated.question,
    sources: sourceMetadata,
  });
}
