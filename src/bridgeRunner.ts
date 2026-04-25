import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { LeafProcessFailure, type LeafModelCallFailureDetails, type LeafModelCallSuccess, type ModelCall } from "./leafRunner.js";

export type BridgeRunRequest = {
  type: "run_request";
  runId: string;
  input: { contextPath: string; question: string };
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
  modelCallRunner: ModelCallRunner;
  pythonPath?: string;
  bridgeArgs?: string[];
  signal?: AbortSignal;
}): Promise<CompletedSyntheticBridgeRun> {
  const pythonPath = options.pythonPath ?? "python3";
  const child = spawn(pythonPath, [options.bridgePath, ...(options.bridgeArgs ?? [])], {
    stdio: ["pipe", "pipe", "pipe"],
    signal: options.signal,
  });

  const stdoutLines: string[] = [];
  let stderr = "";
  const callbacks: Array<Omit<ModelCallbackRequest, "type" | "runId">> = [];
  const modelCallResponses: ModelCallbackResponse[] = [];
  const finalResults: BridgeRunResult[] = [];
  let pendingCallbackId: string | undefined;
  let settled = false;

  function protocolError(code: string, message: string, line?: string): BridgeProtocolError {
    return new BridgeProtocolError(code, message, { stderr, stdoutLines, ...(line ? { line } : {}) });
  }

  const stdout = createInterface({ input: child.stdout });

  const done = new Promise<CompletedSyntheticBridgeRun>((resolve, reject) => {
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    function fail(error: unknown) {
      if (!settled) {
        settled = true;
        child.kill();
        reject(error);
      }
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
          ...(typeof typed.metadata === "object" && typed.metadata && !Array.isArray(typed.metadata)
            ? { metadata: typed.metadata as Record<string, unknown> }
            : {}),
        };
        callbacks.push(call);
        void options
          .modelCallRunner(call)
          .then((response) => {
            if (!settled && child.stdin.writable) {
              modelCallResponses.push(response);
              child.stdin.write(JSON.stringify({ type: "model_callback_response", runId: options.runId, ...response }) + "\n");
              pendingCallbackId = undefined;
            }
          })
          .catch((error: unknown) => {
            if (!settled && child.stdin.writable) {
              const response: LeafModelCallFailureDetails =
                error instanceof LeafProcessFailure
                  ? error.details
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
              child.stdin.write(JSON.stringify({ type: "model_callback_response", runId: options.runId, ...response }) + "\n");
              pendingCallbackId = undefined;
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
      resolve({ ...finalResult, modelCallbacks: callbacks, modelCallResponses, finalResults, stdoutLines, stderr });
    });
  });

  const request: BridgeRunRequest = {
    type: "run_request",
    runId: options.runId,
    input: { contextPath: options.contextPath, question: options.question },
  };
  child.stdin.write(JSON.stringify(request) + "\n");

  return done;
}
