import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { LeafProcessFailure, type LeafModelCallFailureDetails, type LeafModelCallSuccess, type ModelCall } from "./leafRunner.js";
import { ModelCallQueueCancelledError } from "./modelCallQueue.js";

export type BridgeRunRequest = {
  type: "run_request";
  runId: string;
  input: { contextPath: string; question: string; context?: string };
  lambdaRlm?: { contextWindowChars?: number };
};

export type ModelCallbackRequest = {
  type: "model_callback_request";
  runId: string;
  requestId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
};

export type ModelCallbackResponse = LeafModelCallSuccess | LeafModelCallFailureDetails;

export type ModelCallRunner = (call: ModelCall) => Promise<ModelCallbackResponse>;

export type BridgeRunResult = {
  type: "run_result";
  runId: string;
  ok: true;
  content: string;
  modelCalls: number;
  metadata?: Record<string, unknown>;
};

export type BridgeFailedRunResult = {
  type: "run_result";
  runId: string;
  ok: false;
  error: { type: string; code: string; message: string };
  modelCalls?: number;
  modelCallFailure?: LeafModelCallFailureDetails;
};

export type CompletedSyntheticBridgeRun = BridgeRunResult & {
  modelCallbacks: Array<Omit<ModelCallbackRequest, "type" | "runId">>;
  modelCallResponses: ModelCallbackResponse[];
  finalResults: BridgeRunResult[];
  stdoutLines: string[];
  stderr: string;
};

export class BridgeRunFailedError extends Error {
  readonly details: {
    ok: false;
    error: { type: "runtime"; code: string; message: string };
    failedRunResult: BridgeFailedRunResult;
    diagnostics: { stderr: string; stdoutLines: string[] };
    modelCallResponses: ModelCallbackResponse[];
  };

  constructor(failedRunResult: BridgeFailedRunResult, diagnostics: { stderr: string; stdoutLines: string[] }, modelCallResponses: ModelCallbackResponse[]) {
    super(failedRunResult.error.message);
    this.name = "BridgeRunFailedError";
    this.details = {
      ok: false,
      error: { type: "runtime", code: failedRunResult.error.code, message: failedRunResult.error.message },
      failedRunResult,
      diagnostics,
      modelCallResponses,
    };
  }
}

function isLeafModelCallFailureDetails(value: unknown): value is LeafModelCallFailureDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
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

export class BridgeProtocolError extends Error {
  readonly details: {
    ok: false;
    error: { type: "protocol"; code: string; message: string; line?: string };
    diagnostics: { stderr: string; stdoutLines: string[] };
  };

  constructor(code: string, message: string, diagnostics: { stderr: string; stdoutLines: string[]; line?: string }) {
    super(message);
    this.name = "BridgeProtocolError";
    this.details = {
      ok: false,
      error: { type: "protocol", code, message, ...(diagnostics.line ? { line: diagnostics.line } : {}) },
      diagnostics: { stderr: diagnostics.stderr, stdoutLines: diagnostics.stdoutLines },
    };
  }
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
}): Promise<CompletedSyntheticBridgeRun> {
  const pythonPath = options.pythonPath ?? "python3";
  const child = spawn(pythonPath, [options.bridgePath, ...(options.bridgeArgs ?? [])], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  let stderr = "";
  const callbacks: Array<Omit<ModelCallbackRequest, "type" | "runId">> = [];
  const modelCallResponses: ModelCallbackResponse[] = [];
  const finalResults: BridgeRunResult[] = [];
  let pendingCallbackId: string | undefined;
  let settled = false;
  let startedModelCalls = 0;
  const runAbortController = new AbortController();
  let wholeRunTimeout: NodeJS.Timeout | undefined;

  function protocolError(code: string, message: string, line?: string): BridgeProtocolError {
    return new BridgeProtocolError(code, message, { stderr, stdoutLines, ...(line ? { line } : {}) });
  }

  function runtimeFailure(code: string, message: string): BridgeRunFailedError {
    return new BridgeRunFailedError(
      {
        type: "run_result",
        runId: options.runId,
        ok: false,
        error: { type: "runtime_control", code, message },
        modelCalls: startedModelCalls,
      },
      { stderr, stdoutLines },
      modelCallResponses,
    );
  }

  const stdout = createInterface({ input: child.stdout });
  let failBridge: (error: unknown) => void = () => undefined;
  let writeBridgeMessage: (message: unknown, description: string) => Promise<void> = async () => undefined;

  const done = new Promise<CompletedSyntheticBridgeRun>((resolve, reject) => {
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    function stdinRuntimeFailure(description: string, error?: unknown) {
      const code = typeof (error as { code?: unknown } | undefined)?.code === "string" ? (error as { code: string }).code : undefined;
      return runtimeFailure(
        "bridge_stdin_write_failed",
        `Failed to write ${description} to Python bridge stdin${code ? ` (${code})` : ""}.`,
      );
    }

    function fail(error: unknown) {
      if (!settled) {
        settled = true;
        if (wholeRunTimeout) clearTimeout(wholeRunTimeout);
        runAbortController.abort();
        child.kill();
        reject(error);
      }
    }

    failBridge = fail;
    child.stdin.on("error", (error) => fail(stdinRuntimeFailure("NDJSON message", error)));
    writeBridgeMessage = (message: unknown, description: string) =>
      new Promise<void>((resolveWrite, rejectWrite) => {
        if (settled) {
          resolveWrite();
          return;
        }
        if (!child.stdin.writable) {
          rejectWrite(stdinRuntimeFailure(description));
          return;
        }
        const payload = `${JSON.stringify(message)}\n`;
        let doneWriting = false;
        let waitingForDrain = false;
        const cleanup = () => {
          child.stdin.off("drain", onDrain);
          child.stdin.off("error", onError);
        };
        const finish = (error?: unknown) => {
          if (doneWriting) return;
          doneWriting = true;
          cleanup();
          if (error) {
            rejectWrite(stdinRuntimeFailure(description, error));
          } else {
            resolveWrite();
          }
        };
        const onDrain = () => finish();
        const onError = (error: Error) => finish(error);
        child.stdin.once("error", onError);
        try {
          const accepted = child.stdin.write(payload, (error?: Error | null) => {
            if (error) {
              finish(error);
              return;
            }
            if (!waitingForDrain) finish();
          });
          if (!accepted) {
            waitingForDrain = true;
            child.stdin.once("drain", onDrain);
          }
        } catch (error) {
          finish(error);
        }
      });

    const onExternalAbort = () => fail(runtimeFailure("run_cancelled", "Lambda-RLM run was cancelled."));
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) onExternalAbort();
    if (options.wholeRunTimeoutMs && options.wholeRunTimeoutMs > 0) {
      wholeRunTimeout = setTimeout(() => {
        fail(runtimeFailure("whole_run_timeout", `Lambda-RLM run exceeded whole-run timeout of ${options.wholeRunTimeoutMs}ms.`));
      }, options.wholeRunTimeoutMs);
    }

    stdout.on("line", (line) => {
      stdoutLines.push(line);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail(protocolError("malformed_stdout_json", `Bridge stdout line was not valid JSON: ${line}`, line));
        return;
      }

      if (!message || typeof message !== "object" || Array.isArray(message)) {
        fail(protocolError("invalid_stdout_message", "Bridge stdout message must be a JSON object.", line));
        return;
      }

      const typed = message as Record<string, unknown>;
      if (typed.type === "model_callback_request") {
        if (pendingCallbackId) {
          fail(protocolError("single_in_flight_violation", "Bridge emitted a model callback while another callback was unresolved.", line));
          return;
        }
        if (typed.runId !== options.runId || typeof typed.requestId !== "string" || typeof typed.prompt !== "string") {
          fail(protocolError("invalid_model_callback_request", "Bridge model callback request was missing runId, requestId, or prompt.", line));
          return;
        }
        pendingCallbackId = typed.requestId;
        const call: ModelCall = {
          requestId: typed.requestId,
          prompt: typed.prompt,
          signal: runAbortController.signal,
          ...(typeof typed.metadata === "object" && typed.metadata && !Array.isArray(typed.metadata)
            ? { metadata: typed.metadata as Record<string, unknown> }
            : {}),
        };
        callbacks.push({
          requestId: call.requestId,
          prompt: call.prompt,
          ...(call.metadata ? { metadata: call.metadata } : {}),
        });
        if (options.maxModelCalls !== undefined && startedModelCalls >= options.maxModelCalls) {
          const response: LeafModelCallFailureDetails = {
            ok: false,
            requestId: call.requestId,
            error: {
              type: "child_process",
              code: "max_model_calls_exceeded",
              message: `Max model calls limit of ${options.maxModelCalls} was exhausted before ${call.requestId}.`,
            },
            diagnostics: { stdout: "", stderr: "", exitCode: null },
          };
          modelCallResponses.push(response);
          fail(
            new BridgeRunFailedError(
              {
                type: "run_result",
                runId: options.runId,
                ok: false,
                error: { type: "runtime_control", code: "max_model_calls_exceeded", message: response.error.message },
                modelCalls: startedModelCalls,
                modelCallFailure: response,
              },
              { stderr, stdoutLines },
              modelCallResponses,
            ),
          );
          pendingCallbackId = undefined;
          return;
        }
        startedModelCalls += 1;
        void options
          .modelCallRunner(call)
          .then((response) => {
            if (!settled && child.stdin.writable) {
              modelCallResponses.push(response);
              void writeBridgeMessage({ type: "model_callback_response", runId: options.runId, ...response }, "model callback response")
                .then(() => {
                  pendingCallbackId = undefined;
                })
                .catch(fail);
            }
          })
          .catch((error: unknown) => {
            if (!settled && child.stdin.writable) {
              const response: LeafModelCallFailureDetails =
                error instanceof LeafProcessFailure
                  ? error.details
                  : error instanceof ModelCallQueueCancelledError
                    ? {
                        ok: false,
                        requestId: call.requestId,
                        error: { type: "child_process", code: "model_call_cancelled", message: error.message },
                        diagnostics: { stdout: "", stderr: "", exitCode: null, signal: "SIGTERM" },
                      }
                    : {
                      ok: false,
                      requestId: call.requestId,
                      error: {
                        type: "child_process",
                        code: "model_call_runner_error",
                        message: error instanceof Error ? error.message : String(error),
                      },
                      diagnostics: { stdout: "", stderr: "", exitCode: null },
                    };
              modelCallResponses.push(response);
              void writeBridgeMessage({ type: "model_callback_response", runId: options.runId, ...response }, "model callback response")
                .then(() => {
                  pendingCallbackId = undefined;
                })
                .catch(fail);
            }
          });
        return;
      }

      if (typed.type === "run_result") {
        if (typed.ok === false) {
          const error = typed.error as Record<string, unknown> | undefined;
          const failedRunResult: BridgeFailedRunResult = {
            type: "run_result",
            runId: typeof typed.runId === "string" ? typed.runId : options.runId,
            ok: false,
            error: {
              type: typeof error?.type === "string" ? error.type : "runtime",
              code: typeof error?.code === "string" ? error.code : "bridge_run_failed",
              message: typeof error?.message === "string" ? error.message : "Bridge returned a structured failure result.",
            },
            ...(typeof typed.modelCalls === "number" ? { modelCalls: typed.modelCalls } : {}),
            ...(isLeafModelCallFailureDetails(typed.modelCallFailure) ? { modelCallFailure: typed.modelCallFailure } : {}),
          };
          fail(new BridgeRunFailedError(failedRunResult, { stderr, stdoutLines }, modelCallResponses));
          return;
        }
        if (typed.ok !== true || typed.runId !== options.runId || typeof typed.content !== "string") {
          fail(protocolError("invalid_run_result", "Bridge final run result was malformed.", line));
          return;
        }
        if (finalResults.length > 0) {
          fail(protocolError("multiple_final_results", "Bridge emitted more than one final run result.", line));
          return;
        }
        finalResults.push({
          type: "run_result",
          runId: typed.runId,
          ok: true,
          content: typed.content,
          modelCalls: typeof typed.modelCalls === "number" ? typed.modelCalls : callbacks.length,
          ...(typeof typed.metadata === "object" && typed.metadata && !Array.isArray(typed.metadata)
            ? { metadata: typed.metadata as Record<string, unknown> }
            : {}),
        });
        child.stdin.end();
        return;
      }

      fail(protocolError("unknown_stdout_message_type", `Unknown bridge stdout message type: ${String(typed.type)}`, line));
    });

    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        fail(protocolError("bridge_exit_nonzero", `Bridge exited with code ${code ?? "null"} signal ${signal ?? "null"}.`));
        return;
      }
      if (finalResults.length !== 1) {
        fail(protocolError("missing_final_result", `Bridge emitted ${finalResults.length} final run results; expected exactly one.`));
        return;
      }
      const [finalResult] = finalResults;
      if (!finalResult) {
        fail(protocolError("missing_final_result", "Bridge did not emit a final run result."));
        return;
      }
      settled = true;
      if (wholeRunTimeout) clearTimeout(wholeRunTimeout);
      options.signal?.removeEventListener("abort", onExternalAbort);
      resolve({ ...finalResult, modelCallbacks: callbacks, modelCallResponses, finalResults, stdoutLines, stderr });
    });
  });

  const request: BridgeRunRequest = {
    type: "run_request",
    runId: options.runId,
    input: { contextPath: options.contextPath, question: options.question, ...(options.context !== undefined ? { context: options.context } : {}) },
    ...(options.contextWindowChars !== undefined ? { lambdaRlm: { contextWindowChars: options.contextWindowChars } } : {}),
  };
  const requestWrite = writeBridgeMessage(request, "run request").catch((error: unknown) => failBridge(error));
  await Promise.race([requestWrite, done.then(() => undefined, () => undefined)]);

  return done;
}
