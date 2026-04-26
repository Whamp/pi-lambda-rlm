import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeProtocolError, BridgeRunFailedError, runSyntheticBridge } from "./bridge-runner.js";
import type { BridgeProgressEvent, BridgeTimelineEvent, ModelCallRunner } from "./bridge-runner.js";
import { resolveLambdaRlmConfig } from "./config-resolver.js";
import type {
  ConfigValidationError,
  DebugConfig,
  LeafConfig,
  RunConfig,
} from "./config-resolver.js";
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
  "debug",
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
  debug?: boolean;
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

export function defaultLambdaRlmBridgePath() {
  return fileURLToPath(new URL("../extensions/lambda-rlm/bridge.py", import.meta.url));
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
  /** Optional directory for source-free debug run artifacts. */
  debugLogDir?: string;
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

function validatedDebug(value: Record<string, unknown>) {
  if (value.debug === undefined) {
    return;
  }
  if (typeof value.debug !== "boolean") {
    throw new LambdaRlmValidationError(
      "invalid_debug",
      "debug must be a boolean when provided.",
      "debug",
    );
  }
  return value.debug;
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
  const debug = validatedDebug(value);
  const perRun = validatedPerRunOptions(value);
  const debugParam = debug === undefined ? {} : { debug };

  if (hasContextPath) {
    return { contextPath, question, ...debugParam, ...perRun };
  }
  if (contextPaths === undefined) {
    throw new LambdaRlmValidationError(
      "invalid_context_paths",
      "contextPaths must be a non-empty array of non-empty strings.",
      "contextPaths",
    );
  }
  return { contextPaths, question, ...debugParam, ...perRun };
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
  debugConfig: DebugConfig;
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

function compactDebugInput(sources: SourceMetadata[], question: string) {
  return {
    questionChars: question.length,
    sourceCount: sources.length,
    sources: sources.map((source) => ({
      bytes: source.bytes,
      chars: source.chars,
      lines: source.lines,
      path: source.path,
      resolvedPath: source.resolvedPath,
      sha256: source.sha256,
      sourceNumber: source.sourceNumber,
    })),
  };
}

function planFromProgress(
  progressEvents: BridgeProgressEvent[],
  metadata?: Record<string, unknown>,
) {
  const planned = progressEvents.find(
    (event) => event.phase === "planned" && event.plan && typeof event.plan === "object",
  );
  if (planned?.plan && typeof planned.plan === "object" && !Array.isArray(planned.plan)) {
    return planned.plan;
  }
  const plan = metadata?.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return;
  }
  const record = plan as Record<string, unknown>;
  return {
    composeOp: record.compose_op,
    costEstimate: record.cost_estimate,
    depth: record.depth,
    kStar: record.k_star,
    n: record.n,
    taskType: record.task_type,
    tauStar: record.tau_star,
    useFilter: record.use_filter,
  };
}

function countTimelineEvents(timeline: BridgeTimelineEvent[], event: string) {
  return timeline.filter((entry) => entry.event === event).length;
}

function timelineStringField(entry: BridgeTimelineEvent, key: string) {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
}

function countsByTimelineField(timeline: BridgeTimelineEvent[], event: string, key: string) {
  const counts: Record<string, number> = {};
  for (const entry of timeline) {
    if (entry.event !== event) {
      continue;
    }
    const value = timelineStringField(entry, key);
    if (!value) {
      continue;
    }
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function inFlightRequestIdsAtEnd(timeline: BridgeTimelineEvent[]) {
  const open = new Set<string>();
  for (const entry of timeline) {
    const requestId = timelineStringField(entry, "requestId");
    if (!requestId) {
      continue;
    }
    if (entry.event === "model_callback_started") {
      open.add(requestId);
    }
    if (entry.event === "model_callback_completed" || entry.event === "model_callback_failed") {
      open.delete(requestId);
    }
  }
  return [...open];
}

function debugModelCallSummary(timeline: BridgeTimelineEvent[], responseCount: number) {
  return {
    byCombinator: countsByTimelineField(timeline, "model_callback_requested", "combinator"),
    byPhase: countsByTimelineField(timeline, "model_callback_requested", "phase"),
    completed: countTimelineEvents(timeline, "model_callback_completed"),
    failed: countTimelineEvents(timeline, "model_callback_failed"),
    inFlightAtEnd: inFlightRequestIdsAtEnd(timeline),
    requested: countTimelineEvents(timeline, "model_callback_requested"),
    responses: responseCount,
    started: countTimelineEvents(timeline, "model_callback_started"),
  };
}

function debugError(error: BridgeRunFailedError | BridgeProtocolError) {
  return {
    code: error.details.error.code,
    message: error.details.error.message,
    type: error.details.error.type,
  };
}

function debugLogBaseDir(context: RuntimeFormattingContext, options: ExecuteLambdaRlmToolOptions) {
  if (options.debugLogDir) {
    return options.debugLogDir;
  }
  if (context.debugConfig.logDir) {
    const homeDir = options.homeDir ?? process.env.HOME;
    if (homeDir && context.debugConfig.logDir === "~") {
      return homeDir;
    }
    if (homeDir && context.debugConfig.logDir.startsWith("~/")) {
      return join(homeDir, context.debugConfig.logDir.slice(2));
    }
    return resolve(options.cwd ?? process.cwd(), context.debugConfig.logDir);
  }
  const homeDir = options.homeDir ?? process.env.HOME;
  return homeDir
    ? join(homeDir, ".pi", "lambda-rlm", "runs")
    : join(process.cwd(), ".pi", "lambda-rlm", "runs");
}

async function writeDebugLog(args: {
  context: RuntimeFormattingContext;
  error?: BridgeRunFailedError | BridgeProtocolError;
  lambdaRlmMetadata?: Record<string, unknown>;
  modelCallResponseCount: number;
  options: ExecuteLambdaRlmToolOptions;
  progressEvents: BridgeProgressEvent[];
  status: "runtime_failed" | "succeeded";
  timeline: BridgeTimelineEvent[];
}) {
  const runDir = join(debugLogBaseDir(args.context, args.options), args.context.runId);
  await mkdir(runDir, { recursive: true });
  const debugLogPath = join(runDir, "debug.json");
  const artifact = {
    diagnostics: args.error
      ? {
          stderr: args.error.details.diagnostics.stderr,
          stdout: args.error.details.diagnostics.stdout,
        }
      : undefined,
    error: args.error ? debugError(args.error) : undefined,
    input: compactDebugInput(args.context.sourceMetadata, args.context.question),
    lambdaRlm: {
      metadata: args.lambdaRlmMetadata,
      plan: planFromProgress(args.progressEvents, args.lambdaRlmMetadata),
    },
    leaf: {
      model: args.context.leafModel,
      profile: "formal_pi_print",
      thinking: args.context.leafThinking,
    },
    modelCalls: debugModelCallSummary(args.timeline, args.modelCallResponseCount),
    progressEvents: args.progressEvents,
    protocol: "strict-stdout-stdin-ndjson",
    runControls: args.context.runConfig,
    runId: args.context.runId,
    schemaVersion: 1,
    status: args.status,
    timeline: args.timeline,
  };
  await writeFile(debugLogPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return debugLogPath;
}

function formatBridgeRuntimeFailure(
  error: BridgeRunFailedError | BridgeProtocolError,
  context: RuntimeFormattingContext,
  debugLogPath?: string,
) {
  return formatRuntimeFailure({
    ...(debugLogPath ? { debugLogPath } : {}),
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

function configValidationFailure(error: ConfigValidationError) {
  const doctorCodes = new Set(["invalid_toml", "unknown_config_key", "invalid_config_value"]);
  const message = doctorCodes.has(error.code)
    ? `${error.message} Run /lambda-rlm-doctor for setup diagnostics and remediation guidance.`
    : error.message;
  return formatValidationFailure({ ...error, message });
}

async function resolveToolConfig(
  validated: LambdaRlmParams,
  options: ExecuteLambdaRlmToolOptions,
  cwd: string,
) {
  const configResult = await resolveLambdaRlmConfig({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.globalConfigPath ? { globalConfigPath: options.globalConfigPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    perRun: perRunConfigOptions(validated),
  });
  if (!configResult.ok) {
    return { ok: false as const, result: configValidationFailure(configResult.error) };
  }
  const runConfig =
    options.outputMaxVisibleChars === undefined
      ? configResult.config.run
      : {
          ...configResult.config.run,
          outputMaxBytes: Math.min(
            configResult.config.run.outputMaxBytes,
            options.outputMaxVisibleChars,
          ),
        };
  return {
    debugConfig: configResult.config.debug,
    leafConfig: configResult.config.leaf,
    ok: true as const,
    runConfig,
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

function resolvedLeafModel(options: ExecuteLambdaRlmToolOptions, leafConfig: LeafConfig) {
  return options.leafModel ?? leafConfig.model;
}

function modelCallRunnerFor(args: {
  leafModel: string;
  leafPiExecutable: string;
  leafThinking: LeafThinking;
  modelCallQueue: ModelCallConcurrencyQueue;
  options: ExecuteLambdaRlmToolOptions;
  promptBundle: ResolvedPromptBundle;
  runConfig: RunConfig;
}): ModelCallRunner {
  return (call) =>
    args.modelCallQueue.run(call, (queuedCall) =>
      runFormalPiLeafModelCall(queuedCall, {
        piExecutable: args.leafPiExecutable,
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
  debugConfig: DebugConfig;
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
  leafPiExecutable: string;
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
      leafPiExecutable: args.leafPiExecutable,
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

function isBridgeRuntimeError(error: unknown): error is BridgeRunFailedError | BridgeProtocolError {
  return error instanceof BridgeRunFailedError || error instanceof BridgeProtocolError;
}

function bridgeFailureModelCallResponseCount(error: BridgeRunFailedError | BridgeProtocolError) {
  return error instanceof BridgeRunFailedError ? error.details.modelCallResponses.length : 0;
}

function bridgeFailureProgressEvents(error: BridgeRunFailedError | BridgeProtocolError) {
  return error instanceof BridgeRunFailedError ? error.details.progressEvents : [];
}

function bridgeFailureTimeline(error: BridgeRunFailedError | BridgeProtocolError) {
  return error instanceof BridgeRunFailedError ? error.details.timeline : [];
}

function debugLogPathForBridgeFailure(args: {
  context: RuntimeFormattingContext;
  enabled: boolean | undefined;
  error: BridgeRunFailedError | BridgeProtocolError;
  options: ExecuteLambdaRlmToolOptions;
}) {
  if (!args.enabled) {
    return;
  }
  return writeDebugLog({
    context: args.context,
    error: args.error,
    modelCallResponseCount: bridgeFailureModelCallResponseCount(args.error),
    options: args.options,
    progressEvents: bridgeFailureProgressEvents(args.error),
    status: "runtime_failed",
    timeline: bridgeFailureTimeline(args.error),
  });
}

function debugLogPathForSuccessfulBridge(args: {
  bridge: CompletedBridgeRun;
  context: RuntimeFormattingContext;
  enabled: boolean | undefined;
  options: ExecuteLambdaRlmToolOptions;
}) {
  if (!args.enabled) {
    return;
  }
  return writeDebugLog({
    context: args.context,
    modelCallResponseCount: args.bridge.modelCallResponses.length,
    options: args.options,
    progressEvents: args.bridge.progressEvents,
    status: "succeeded",
    timeline: args.bridge.timeline,
    ...(args.bridge.metadata ? { lambdaRlmMetadata: args.bridge.metadata } : {}),
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

  const config = await resolveToolConfig(validated, options, cwd);
  if (!config.ok) {
    return config.result;
  }
  const { debugConfig, leafConfig, runConfig } = config;

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
  const bridgePath = options.bridgePath ?? defaultLambdaRlmBridgePath();
  const runId = `lambda-rlm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const leafModel = resolvedLeafModel(options, leafConfig);
  if (!leafModel) {
    return formatValidationFailure({
      code: "missing_leaf_model",
      field: "leaf.model",
      message:
        'No Formal Leaf model is configured. Run /lambda-rlm-doctor for diagnostics and Formal Leaf Model Selection, or add [leaf].model (model = "<provider>/<model-id>") to ~/.pi/lambda-rlm/config.toml or the project .pi/lambda-rlm/config.toml.',
    });
  }
  const leafPiExecutable = options.piExecutable ?? leafConfig.piExecutable;
  const leafThinking = options.leafThinking ?? leafConfig.thinking;
  const modelCallQueue = modelCallQueueFor(options, runConfig);
  const outputOptions = outputOptionsFor(options, runConfig, runId);

  let bridge;
  try {
    bridge = await runBridgeForTool({
      assembledContext,
      bridgePath,
      leafModel,
      leafPiExecutable,
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
      debugConfig,
      leafModel,
      leafThinking,
      outputOptions,
      promptDetails,
      question: validated.question,
      runConfig,
      runId,
      sourceMetadata,
    });
    if (isBridgeRuntimeError(error)) {
      const debugLogPath = await debugLogPathForBridgeFailure({
        context: runtimeContext,
        enabled: debugConfig.enabled || validated.debug,
        error,
        options,
      });
      return formatBridgeRuntimeFailure(error, runtimeContext, debugLogPath);
    }
    throw error;
  }

  const runtimeContext = runtimeContextFor({
    debugConfig,
    leafModel,
    leafThinking,
    outputOptions,
    promptDetails,
    question: validated.question,
    runConfig,
    runId,
    sourceMetadata,
  });
  const debugLogPath = await debugLogPathForSuccessfulBridge({
    bridge,
    context: runtimeContext,
    enabled: debugConfig.enabled || validated.debug,
    options,
  });
  return formatSuccessResult({
    answer: bridge.content,
    bridgeRun: successBridgeRunDetails(bridge, runtimeContext),
    ...(debugLogPath ? { debugLogPath } : {}),
    modelCallSummary: modelCallSummaryFromBridge(bridge),
    output: outputOptions,
    question: validated.question,
    sources: sourceMetadata,
  });
}
