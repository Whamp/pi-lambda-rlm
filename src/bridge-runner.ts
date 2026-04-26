import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { LeafProcessFailure } from "./leaf-runner.js";
import type {
  Awaitable,
  LeafModelCallFailureDetails,
  LeafModelCallSuccess,
  ModelCall,
} from "./leaf-runner.js";
import { BridgeProtocolError } from "./bridge-protocol-error.js";
import { BridgeRunFailedError } from "./bridge-run-failed-error.js";
import { sanitizeLocalLeafFailureDetails } from "./diagnostics.js";
import { ModelCallQueueCancelledError } from "./model-call-error.js";
import type { ResolvedPromptBundle } from "./prompt-resolver.js";

export { BridgeProtocolError } from "./bridge-protocol-error.js";
export { BridgeRunFailedError } from "./bridge-run-failed-error.js";

function ignoreBridgeFailure(_error: unknown) {
  // Replaced immediately when a bridge run starts.
}

function noop() {
  // Replaced when a bridge run has an external abort listener.
}

function resolvedBridgeMessageWrite(_message: unknown, _description: string) {
  return Promise.resolve();
}

function runResultMetadata(typed: { metadata?: unknown }) {
  const { metadata } = typed;
  if (typeof metadata === "object" && metadata !== null && Array.isArray(metadata) === false) {
    return { metadata: metadata as Record<string, unknown> };
  }
  return {};
}

export interface BridgeRunRequest {
  type: "run_request";
  runId: string;
  input: { contextPath: string; question: string; context?: string };
  lambdaRlm?: { contextWindowChars?: number };
  promptBundle?: ResolvedPromptBundle;
}

export interface ModelCallbackRequest {
  type: "model_callback_request";
  runId: string;
  requestId: string;
  prompt: string;
  metadata: Record<string, unknown>;
}

export interface BridgeProgressEvent {
  phase: string;
  [key: string]: unknown;
}

export interface BridgeTimelineEvent {
  elapsedMs: number;
  event: string;
  [key: string]: unknown;
}

export type ModelCallbackResponse = (LeafModelCallSuccess | LeafModelCallFailureDetails) & {
  metadata?: Record<string, unknown>;
};

export type ModelCallRunner = (call: ModelCall) => Awaitable<ModelCallbackResponse>;

export interface BridgeRunResult {
  type: "run_result";
  runId: string;
  ok: true;
  content: string;
  modelCalls: number;
  metadata?: Record<string, unknown>;
}

export interface BridgeFailedRunResult {
  type: "run_result";
  runId: string;
  ok: false;
  error: { type: string; code: string; message: string };
  modelCalls?: number;
  modelCallFailure?: LeafModelCallFailureDetails;
}

export type CompletedSyntheticBridgeRun = BridgeRunResult & {
  modelCallbacks: Omit<ModelCallbackRequest, "type" | "runId">[];
  modelCallResponses: ModelCallbackResponse[];
  finalResults: BridgeRunResult[];
  progressEvents: BridgeProgressEvent[];
  stdoutLines: string[];
  stderr: string;
  timeline: BridgeTimelineEvent[];
};

function isLeafModelCallFailureDetails(value: unknown): value is LeafModelCallFailureDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const diagnostics = record.diagnostics as Record<string, unknown> | undefined;
  return (
    record.ok === false &&
    typeof record.requestId === "string" &&
    typeof record.error === "object" &&
    !!record.error &&
    typeof diagnostics === "object" &&
    !!diagnostics &&
    typeof diagnostics.stdout === "string" &&
    typeof diagnostics.stderr === "string" &&
    (typeof diagnostics.exitCode === "number" || diagnostics.exitCode === null)
  );
}

export async function runSyntheticBridge(options: {
  bridgePath: string;
  runId: string;
  contextPath: string;
  question: string;
  context?: string;
  modelCallRunner: ModelCallRunner;
  pythonPath?: string;
  bridgeArgs?: string[];
  signal?: AbortSignal;
  contextWindowChars?: number;
  maxModelCalls?: number;
  wholeRunTimeoutMs?: number;
  promptBundle?: ResolvedPromptBundle;
}): Promise<CompletedSyntheticBridgeRun> {
  const pythonPath = options.pythonPath ?? "python3";
  const child = spawn(pythonPath, [options.bridgePath, ...(options.bridgeArgs ?? [])], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  let stderr = "";
  const callbacks: Omit<ModelCallbackRequest, "type" | "runId">[] = [];
  const modelCallResponses: ModelCallbackResponse[] = [];
  const finalResults: BridgeRunResult[] = [];
  const progressEvents: BridgeProgressEvent[] = [];
  const timeline: BridgeTimelineEvent[] = [];
  const startedAt = Date.now();
  let pendingCallbackId: string | undefined;
  let settled = false;
  let startedModelCalls = 0;
  const runAbortController = new AbortController();
  let wholeRunTimeout: NodeJS.Timeout | undefined;

  function elapsedMs() {
    return Date.now() - startedAt;
  }

  function recordTimeline(event: string, fields: Record<string, unknown> = {}) {
    timeline.push({ elapsedMs: elapsedMs(), event, ...fields });
  }

  function telemetrySnapshot() {
    return { progressEvents: [...progressEvents], timeline: [...timeline] };
  }

  recordTimeline("bridge_process_started", { pythonPath });

  function protocolError(code: string, message: string, line?: string): BridgeProtocolError {
    return new BridgeProtocolError(code, message, {
      stderr,
      stdoutLines,
      ...(line ? { line } : {}),
      finalResults: finalResults.length,
    });
  }

  function runtimeFailure(code: string, message: string): BridgeRunFailedError {
    return new BridgeRunFailedError(
      {
        error: { code, message, type: "runtime_control" },
        modelCalls: startedModelCalls,
        ok: false,
        runId: options.runId,
        type: "run_result",
      },
      { stderr, stdoutLines },
      modelCallResponses,
      finalResults.length,
      telemetrySnapshot(),
    );
  }

  const stdout = createInterface({ input: child.stdout });
  let failBridge: (error: unknown) => void = ignoreBridgeFailure;
  let writeBridgeMessage: (message: unknown, description: string) => Promise<void> =
    resolvedBridgeMessageWrite;
  let removeExternalAbortListener: () => void = noop;

  // The bridge lifecycle is event-driven; this promise is the explicit boundary
  // between child-process events and the async tool API.
  // oxlint-disable-next-line promise/avoid-new
  const done = new Promise<CompletedSyntheticBridgeRun>((_resolve, _reject) => {
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    function stdinRuntimeFailure(description: string, error?: unknown) {
      const code =
        typeof (error as { code?: unknown } | undefined)?.code === "string"
          ? (error as { code: string }).code
          : undefined;
      return runtimeFailure(
        "bridge_stdin_write_failed",
        `Failed to write ${description} to Python bridge stdin${code ? ` (${code})` : ""}.`,
      );
    }

    function fail(error: unknown) {
      if (!settled) {
        settled = true;
        if (wholeRunTimeout) {
          clearTimeout(wholeRunTimeout);
        }
        removeExternalAbortListener();
        runAbortController.abort();
        child.kill();
        _reject(error);
      }
    }

    failBridge = fail;
    child.stdin.on("error", (error) => fail(stdinRuntimeFailure("NDJSON message", error)));
    writeBridgeMessage = (message: unknown, description: string) =>
      // `stdin.write` reports completion through callbacks/drain/error events.
      // oxlint-disable-next-line promise/avoid-new
      new Promise<void>((resolve, reject) => {
        if (settled) {
          resolve();
          return;
        }
        if (!child.stdin.writable) {
          reject(stdinRuntimeFailure(description));
          return;
        }
        const payload = `${JSON.stringify(message)}\n`;
        let doneWriting = false;
        let waitingForDrain = false;
        // Stream callbacks close over `finish` before they are registered.
        // oxlint-disable-next-line prefer-const
        let finish: (error?: unknown) => void;
        const onDrain = () => finish();
        const onError = (error: Error) => finish(error);
        const cleanup = () => {
          child.stdin.off("drain", onDrain);
          child.stdin.off("error", onError);
        };
        finish = (error?: unknown) => {
          if (doneWriting) {
            return;
          }
          doneWriting = true;
          cleanup();
          if (error) {
            reject(stdinRuntimeFailure(description, error));
          } else {
            resolve();
          }
        };
        child.stdin.once("error", onError);
        try {
          // `Writable.write` exposes write completion through this callback.
          // oxlint-disable-next-line promise/prefer-await-to-callbacks
          const accepted = child.stdin.write(payload, (error?: Error | null) => {
            if (error) {
              finish(error);
              return;
            }
            if (!waitingForDrain) {
              finish();
            }
          });
          if (!accepted) {
            waitingForDrain = true;
            child.stdin.once("drain", onDrain);
          }
        } catch (error) {
          finish(error);
        }
      });

    const onExternalAbort = () => {
      recordTimeline("run_cancelled", { pendingCallbackId, startedModelCalls });
      fail(runtimeFailure("run_cancelled", "Lambda-RLM run was cancelled."));
    };
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    removeExternalAbortListener = () =>
      options.signal?.removeEventListener("abort", onExternalAbort);
    if (options.signal?.aborted) {
      onExternalAbort();
    }
    if (options.wholeRunTimeoutMs && options.wholeRunTimeoutMs > 0) {
      wholeRunTimeout = setTimeout(() => {
        recordTimeline("whole_run_timeout", {
          pendingCallbackId,
          startedModelCalls,
          timeoutMs: options.wholeRunTimeoutMs,
        });
        fail(
          runtimeFailure(
            "whole_run_timeout",
            `Lambda-RLM run exceeded whole-run timeout of ${options.wholeRunTimeoutMs}ms.`,
          ),
        );
      }, options.wholeRunTimeoutMs);
    }

    function parseStdoutMessage(line: string): Record<string, unknown> | undefined {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail(
          protocolError("malformed_stdout_json", "Bridge stdout line was not valid JSON.", line),
        );
        return undefined;
      }

      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        fail(
          protocolError(
            "invalid_stdout_message",
            "Bridge stdout message must be a JSON object.",
            line,
          ),
        );
        return undefined;
      }

      return message as Record<string, unknown>;
    }

    function isRunProgressMessage(typed: Record<string, unknown>): typed is {
      phase: string;
      runId: string;
    } & Record<string, unknown> {
      return typed.runId === options.runId && typeof typed.phase === "string";
    }

    function isModelCallbackRequest(typed: Record<string, unknown>): typed is {
      metadata: Record<string, unknown>;
      prompt: string;
      requestId: string;
      runId: string;
    } {
      const { metadata } = typed;
      return (
        typed.runId === options.runId &&
        typeof typed.requestId === "string" &&
        typeof typed.prompt === "string" &&
        typeof metadata === "object" &&
        metadata !== null &&
        Array.isArray(metadata) === false
      );
    }

    function failureResponseFromError(
      error: unknown,
      call: ModelCall,
    ): LeafModelCallFailureDetails {
      if (error instanceof LeafProcessFailure) {
        return error.details;
      }
      if (error instanceof ModelCallQueueCancelledError) {
        return {
          diagnostics: { exitCode: null, signal: "SIGTERM", stderr: "", stdout: "" },
          error: {
            code: "model_call_cancelled",
            message: error.message,
            type: "child_process",
          },
          ok: false,
          requestId: call.requestId,
        };
      }
      return {
        diagnostics: { exitCode: null, stderr: "", stdout: "" },
        error: {
          code: "model_call_runner_error",
          message: error instanceof Error ? error.message : String(error),
          type: "child_process",
        },
        ok: false,
        requestId: call.requestId,
      };
    }

    async function sendModelCallbackResponse(
      response: ModelCallbackResponse,
      callbackMetadata: Record<string, unknown>,
    ) {
      if (settled || child.stdin.writable === false) {
        return;
      }
      const safeResponse = response.ok ? response : sanitizeLocalLeafFailureDetails(response);
      modelCallResponses.push({ ...safeResponse, metadata: callbackMetadata });
      await writeBridgeMessage(
        { runId: options.runId, type: "model_callback_response", ...safeResponse },
        "model callback response",
      );
      pendingCallbackId = undefined;
    }

    async function runModelCallback(call: ModelCall, callbackMetadata: Record<string, unknown>) {
      const started = Date.now();
      recordTimeline("model_callback_started", {
        combinator: callbackMetadata.combinator,
        phase: callbackMetadata.phase,
        promptChars: call.prompt.length,
        requestId: call.requestId,
      });
      let response: ModelCallbackResponse;
      try {
        response = await options.modelCallRunner(call);
      } catch (error) {
        response = failureResponseFromError(error, call);
      }

      const durationMs = Date.now() - started;
      recordTimeline(response.ok ? "model_callback_completed" : "model_callback_failed", {
        combinator: callbackMetadata.combinator,
        durationMs,
        errorCode: response.ok ? undefined : response.error.code,
        errorType: response.ok ? undefined : response.error.type,
        phase: callbackMetadata.phase,
        requestId: call.requestId,
        stdoutChars: response.ok ? response.content.length : undefined,
      });

      try {
        await sendModelCallbackResponse(response, callbackMetadata);
      } catch (error) {
        fail(error);
      }
    }

    function failMaxModelCalls(call: ModelCall, callbackMetadata: Record<string, unknown>) {
      recordTimeline("max_model_calls_exceeded", {
        limit: options.maxModelCalls,
        requestId: call.requestId,
        startedModelCalls,
      });
      const response: LeafModelCallFailureDetails = {
        diagnostics: { exitCode: null, stderr: "", stdout: "" },
        error: {
          code: "max_model_calls_exceeded",
          message: `Max model calls limit of ${options.maxModelCalls} was exhausted before ${call.requestId}.`,
          type: "child_process",
        },
        ok: false,
        requestId: call.requestId,
      };
      modelCallResponses.push({ ...response, metadata: callbackMetadata });
      fail(
        new BridgeRunFailedError(
          {
            error: {
              code: "max_model_calls_exceeded",
              message: response.error.message,
              type: "runtime_control",
            },
            modelCallFailure: response,
            modelCalls: startedModelCalls,
            ok: false,
            runId: options.runId,
            type: "run_result",
          },
          { stderr, stdoutLines },
          modelCallResponses,
          0,
          telemetrySnapshot(),
        ),
      );
      pendingCallbackId = undefined;
    }

    function handleRunProgress(typed: Record<string, unknown>, line: string) {
      if (isRunProgressMessage(typed) === false) {
        fail(
          protocolError(
            "invalid_run_progress",
            "Bridge progress message was missing runId or phase.",
            line,
          ),
        );
        return;
      }
      const { phase, runId: _runId, type: _type, ...rest } = typed;
      const progressEvent: BridgeProgressEvent = { phase, ...rest };
      progressEvents.push(progressEvent);
      recordTimeline("run_progress", progressEvent);
    }

    function handleModelCallbackRequest(typed: Record<string, unknown>, line: string) {
      if (pendingCallbackId) {
        fail(
          protocolError(
            "single_in_flight_violation",
            "Bridge emitted a model callback while another callback was unresolved.",
            line,
          ),
        );
        return;
      }
      if (isModelCallbackRequest(typed) === false) {
        fail(
          protocolError(
            "invalid_model_callback_request",
            "Bridge model callback request was missing runId, requestId, prompt, or metadata object.",
            line,
          ),
        );
        return;
      }

      pendingCallbackId = typed.requestId;
      const callbackMetadata = typed.metadata as Record<string, unknown>;
      recordTimeline("model_callback_requested", {
        combinator: callbackMetadata.combinator,
        phase: callbackMetadata.phase,
        promptChars: typed.prompt.length,
        requestId: typed.requestId,
      });
      const call: ModelCall = {
        metadata: callbackMetadata,
        prompt: typed.prompt,
        requestId: typed.requestId,
        signal: runAbortController.signal,
      };
      callbacks.push({
        metadata: callbackMetadata,
        prompt: call.prompt,
        requestId: call.requestId,
      });
      if (options.maxModelCalls !== undefined && startedModelCalls >= options.maxModelCalls) {
        failMaxModelCalls(call, callbackMetadata);
        return;
      }
      startedModelCalls += 1;
      void runModelCallback(call, callbackMetadata);
    }

    function failedRunResultFromMessage(typed: Record<string, unknown>): BridgeFailedRunResult {
      const error = typed.error as Record<string, unknown> | undefined;
      return {
        error: {
          code: typeof error?.code === "string" ? error.code : "bridge_run_failed",
          message:
            typeof error?.message === "string"
              ? error.message
              : "Bridge returned a structured failure result.",
          type: typeof error?.type === "string" ? error.type : "runtime",
        },
        ok: false,
        runId: typeof typed.runId === "string" ? typed.runId : options.runId,
        type: "run_result",
        ...(typeof typed.modelCalls === "number" ? { modelCalls: typed.modelCalls } : {}),
        ...(isLeafModelCallFailureDetails(typed.modelCallFailure)
          ? { modelCallFailure: typed.modelCallFailure }
          : {}),
      };
    }

    function isSuccessfulRunResultMessage(typed: Record<string, unknown>): typed is {
      content: string;
      metadata?: unknown;
      modelCalls?: unknown;
      ok: true;
      runId: string;
    } {
      return (
        typed.ok === true && typed.runId === options.runId && typeof typed.content === "string"
      );
    }

    function handleRunResult(typed: Record<string, unknown>, line: string) {
      if (typed.ok === false) {
        fail(
          new BridgeRunFailedError(
            failedRunResultFromMessage(typed),
            { stderr, stdoutLines },
            modelCallResponses,
            1,
            telemetrySnapshot(),
          ),
        );
        return;
      }
      if (isSuccessfulRunResultMessage(typed) === false) {
        fail(protocolError("invalid_run_result", "Bridge final run result was malformed.", line));
        return;
      }
      if (finalResults.length > 0) {
        fail(
          protocolError(
            "multiple_final_results",
            "Bridge emitted more than one final run result.",
            line,
          ),
        );
        return;
      }
      recordTimeline("run_result", {
        modelCalls: typeof typed.modelCalls === "number" ? typed.modelCalls : callbacks.length,
        status: "succeeded",
      });
      finalResults.push({
        content: typed.content,
        modelCalls: typeof typed.modelCalls === "number" ? typed.modelCalls : callbacks.length,
        ok: true,
        runId: typed.runId,
        type: "run_result",
        ...runResultMetadata(typed),
      });
      child.stdin.end();
    }

    function handleStdoutLine(line: string) {
      stdoutLines.push(line);
      const typed = parseStdoutMessage(line);
      if (typed === undefined) {
        return;
      }
      if (typed.type === "run_progress") {
        handleRunProgress(typed, line);
        return;
      }
      if (typed.type === "model_callback_request") {
        handleModelCallbackRequest(typed, line);
        return;
      }
      if (typed.type === "run_result") {
        handleRunResult(typed, line);
        return;
      }
      fail(
        protocolError("unknown_stdout_message_type", "Unknown bridge stdout message type.", line),
      );
    }

    stdout.on("line", handleStdoutLine);

    let bridgeExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let stdoutClosed = false;

    function finishAfterBridgeExitAndStdoutClose() {
      if (settled || bridgeExit === undefined || stdoutClosed === false) {
        return;
      }
      const { code, signal } = bridgeExit;
      if (code !== 0) {
        fail(
          protocolError(
            "bridge_exit_nonzero",
            `Bridge exited with code ${code ?? "null"} signal ${signal ?? "null"}.`,
          ),
        );
        return;
      }
      if (finalResults.length !== 1) {
        fail(
          protocolError(
            "missing_final_result",
            `Bridge emitted ${finalResults.length} final run results; expected exactly one.`,
          ),
        );
        return;
      }
      const [finalResult] = finalResults;
      if (finalResult === undefined) {
        fail(protocolError("missing_final_result", "Bridge did not emit a final run result."));
        return;
      }
      settled = true;
      if (wholeRunTimeout) {
        clearTimeout(wholeRunTimeout);
      }
      removeExternalAbortListener();
      _resolve({
        ...finalResult,
        finalResults,
        modelCallResponses,
        modelCallbacks: callbacks,
        progressEvents,
        stderr,
        stdoutLines,
        timeline,
      });
    }

    stdout.on("close", () => {
      stdoutClosed = true;
      finishAfterBridgeExitAndStdoutClose();
    });
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      bridgeExit = { code, signal };
      finishAfterBridgeExitAndStdoutClose();
    });
  });

  const request: BridgeRunRequest = {
    input: {
      contextPath: options.contextPath,
      question: options.question,
      ...(options.context === undefined ? {} : { context: options.context }),
    },
    runId: options.runId,
    type: "run_request",
    ...(options.contextWindowChars === undefined
      ? {}
      : { lambdaRlm: { contextWindowChars: options.contextWindowChars } }),
    ...(options.promptBundle ? { promptBundle: options.promptBundle } : {}),
  };
  const writeRequest = async () => {
    try {
      await writeBridgeMessage(request, "run request");
      recordTimeline("run_request_sent", {
        contextChars: options.context?.length,
        questionChars: options.question.length,
      });
    } catch (error) {
      failBridge(error);
    }
  };
  const waitForBridgeToSettle = async () => {
    try {
      await done;
    } catch {
      // The rejection is handled by awaiting `done` below.
    }
  };
  await Promise.race([writeRequest(), waitForBridgeToSettle()]);

  return done;
}
