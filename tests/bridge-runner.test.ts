import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BridgeProtocolError } from "../src/bridge-runner.js";
import { runSyntheticBridge } from "../src/bridge-runner.js";

const bridgePath = fileURLToPath(
  new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url),
);

async function tempContextFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-bridge-test-"));
  const path = join(dir, "context.txt");
  await writeFile(path, content, "utf-8");
  return path;
}

async function tempPythonBridgeScript(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-bridge-control-test-"));
  const path = join(dir, "bridge.py");
  await writeFile(path, source, "utf-8");
  await chmod(path, 0o755);
  return path;
}

const successfulModelCallRunner = (call: { requestId: string; prompt?: string }) => {
  const prompt = call.prompt ?? "";
  const content = prompt.includes("Single digit:") ? "2" : "real bridge model answer";
  return {
    content,
    diagnostics: { exitCode: 0, stderr: "", stdoutChars: content.length },
    ok: true as const,
    requestId: call.requestId,
  };
};

function neverSettles<T>(): Promise<T> {
  // This test double must keep a callback in flight indefinitely.
  // oxlint-disable-next-line promise/avoid-new
  return new Promise(() => {
    // Intentionally never resolves.
  });
}

function deferredVoid() {
  let resolveDeferred!: () => void;
  // Tests need a controllable deferred to assert cancellation ordering.
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function resolveOnAbort<T>(signal: AbortSignal | undefined, value: T): Promise<T> {
  // AbortSignal is EventTarget-based; a one-shot promise is the clearest test seam.
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(value), { once: true });
  });
}

describe("Python NDJSON bridge runner", () => {
  it("starts the Python bridge, answers request-identified real Lambda-RLM model callbacks through a model call runner, and returns exactly one final result", async () => {
    const contextPath = await tempContextFile("small context for bridge test");
    const result = await runSyntheticBridge({
      bridgePath,
      contextPath,
      modelCallRunner: successfulModelCallRunner,
      question: "What is this file about?",
      runId: "run-test-1",
    });

    expect(result.content).toBe("real bridge model answer");
    expect(result.modelCallbacks).toStrictEqual([
      {
        metadata: expect.objectContaining({
          source: "lambda_rlm",
          phase: "task_detection",
          combinator: "classifier",
          promptKey: "TASK-DETECTION-PROMPT.md",
        }),
        prompt: expect.stringContaining("Single digit:"),
        requestId: "model-call-1",
      },
      {
        metadata: expect.objectContaining({
          source: "lambda_rlm",
          phase: "execute_phi",
          combinator: "leaf",
          promptKey: "tasks/qa.md",
        }),
        prompt: expect.stringContaining("What is this file about?"),
        requestId: "model-call-2",
      },
    ]);
    expect(result.modelCallResponses).toStrictEqual([
      expect.objectContaining({ content: "2", ok: true, requestId: "model-call-1" }),
      expect.objectContaining({
        content: "real bridge model answer",
        ok: true,
        requestId: "model-call-2",
      }),
    ]);
    expect(result.finalResults).toHaveLength(1);
    expect(result.stderr).toContain("bridge: received real Lambda-RLM run request run-test-1");
    expect(result.stdoutLines).toHaveLength(3);
  });

  it("rejects model callback requests that omit explicit metadata", async () => {
    const missingMetadataBridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json
request = json.loads(input())
print(json.dumps({"type":"model_callback_request","runId":request["runId"],"requestId":"model-call-1","prompt":"ordinary overridden prompt without metadata"}), flush=True)
`);

    await expect(
      runSyntheticBridge({
        bridgePath: missingMetadataBridgePath,
        contextPath: "context.txt",
        modelCallRunner: successfulModelCallRunner,
        question: "What?",
        runId: "run-missing-metadata",
      }),
    ).rejects.toMatchObject({
      details: { error: { code: "invalid_model_callback_request" } },
      name: "BridgeProtocolError",
    });
  });

  it("sends a structured failure response when the model call runner fails", async () => {
    await expect(
      runSyntheticBridge({
        bridgePath,
        contextPath: await tempContextFile("failure context"),
        modelCallRunner: (call) => ({
          diagnostics: {
            exitCode: 1,
            stderr: "",
            stderrBytes: Buffer.byteLength("bad auth", "utf-8"),
            stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            stdout: "",
          },
          error: { code: "child_exit_nonzero", message: "child failed", type: "child_process" },
          ok: false,
          requestId: call.requestId,
        }),
        question: "What?",
        runId: "run-leaf-failure",
      }),
    ).rejects.toMatchObject({
      details: {
        error: {
          code: "model_callback_failed",
          message: expect.stringContaining("child failed"),
          type: "runtime",
        },
        failedRunResult: {
          error: { code: "model_callback_failed", type: "model_callback_failure" },
          modelCallFailure: {
            diagnostics: {
              exitCode: 1,
              stderr: "",
              stderrBytes: Buffer.byteLength("bad auth", "utf-8"),
              stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              stdout: "",
            },
          },
        },
        modelCallResponses: [
          {
            ok: false,
            diagnostics: {
              stdout: "",
              stderr: "",
              stderrBytes: Buffer.byteLength("bad auth", "utf-8"),
              stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              exitCode: 1,
            },
          },
        ],
      },
      name: "BridgeRunFailedError",
    });
  });

  it("omits untrusted unknown stdout message type values from protocol errors", async () => {
    const leakingType = "RAW_SECRET_SENTINEL";
    const malformedBridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys
sys.stdin.readline()
print(json.dumps({"type":"${leakingType}"}), flush=True)
`);

    await expect(
      runSyntheticBridge({
        bridgePath: malformedBridgePath,
        contextPath: "context.txt",
        modelCallRunner: successfulModelCallRunner,
        question: "What?",
        runId: "run-unknown-type",
      }),
    ).rejects.toMatchObject({
      details: {
        diagnostics: {
          offendingLine: {
            bytes: expect.any(Number),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        error: {
          code: "unknown_stdout_message_type",
          message: "Unknown bridge stdout message type.",
        },
      },
      name: "BridgeProtocolError",
    });

    let serializedDetails = "";
    try {
      await runSyntheticBridge({
        bridgePath: malformedBridgePath,
        contextPath: "context.txt",
        modelCallRunner: successfulModelCallRunner,
        question: "What?",
        runId: "run-unknown-type-recheck",
      });
      throw new Error("expected bridge protocol error");
    } catch (error) {
      serializedDetails = JSON.stringify((error as BridgeProtocolError).details);
    }
    expect(serializedDetails).not.toContain(leakingType);
  });

  it("fails with a structured protocol error when stdout contains malformed NDJSON", async () => {
    await expect(
      runSyntheticBridge({
        bridgeArgs: ["--emit-malformed-stdout"],
        bridgePath,
        contextPath: "context.txt",
        modelCallRunner: successfulModelCallRunner,
        question: "What?",
        runId: "run-malformed-stdout",
      }),
    ).rejects.toMatchObject({
      details: {
        error: {
          code: "malformed_stdout_json",
          message: expect.stringContaining("Bridge stdout line was not valid JSON"),
          type: "protocol",
        },
        ok: false,
      },
      name: "BridgeProtocolError",
    });
  });

  it("the Python bridge returns a structured error result when stdin contains malformed JSON", async () => {
    const child = spawn("python3", [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.write("{not json}\n");
    child.stdin.end();

    const [stdout] = (await once(child.stdout, "data")) as [Buffer];
    const message = JSON.parse(stdout.toString("utf-8"));
    expect(message).toMatchObject({
      error: { code: "malformed_stdin_json", type: "protocol" },
      ok: false,
      type: "run_result",
    });

    await once(child, "exit");
  });

  it("fails single-in-flight mode when the bridge emits a second callback before the first response, even if the bridge exits immediately", async () => {
    const duplicateCallbackBridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, os, sys
request = json.loads(sys.stdin.readline())
first = {"type":"model_callback_request","runId":request["runId"],"requestId":"model-call-1","prompt":"first callback","metadata":{"phase":"test"}}
second = dict(first)
second["requestId"] = "model-call-2"
os.write(1, (json.dumps(first) + "\\n" + json.dumps(second) + "\\n").encode("utf-8"))
os._exit(0)
`);

    await expect(
      runSyntheticBridge({
        bridgePath: duplicateCallbackBridgePath,
        contextPath: "context.txt",
        modelCallRunner: () => neverSettles(),
        question: "What?",
        runId: "run-duplicate-callback",
      }),
    ).rejects.toMatchObject({
      details: {
        error: { code: "single_in_flight_violation", type: "protocol" },
        ok: false,
      },
      name: "BridgeProtocolError",
    });
  });

  it("enforces max model calls before starting another leaf call and returns a structured runtime failure", async () => {
    const contextPath = await tempContextFile("budget context");
    const started: string[] = [];

    await expect(
      runSyntheticBridge({
        bridgePath,
        contextPath,
        maxModelCalls: 1,
        modelCallRunner: (call) => {
          started.push(call.requestId);
          return successfulModelCallRunner(call);
        },
        question: "What?",
        runId: "run-budget",
      }),
    ).rejects.toMatchObject({
      details: {
        error: { code: "max_model_calls_exceeded", type: "runtime" },
        failedRunResult: {
          modelCallFailure: {
            error: { code: "max_model_calls_exceeded" },
            requestId: "model-call-2",
          },
        },
      },
      name: "BridgeRunFailedError",
    });
    expect(started).toStrictEqual(["model-call-1"]);
  });

  it("aborts the Python bridge on whole-run timeout and reports partial runtime details", async () => {
    const slowBridge = await tempPythonBridgeScript(`#!/usr/bin/env python3
import signal, sys, time
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
sys.stdin.readline()
sys.stderr.write("slow bridge started\\n")
sys.stderr.flush()
time.sleep(30)
`);

    await expect(
      runSyntheticBridge({
        bridgePath: slowBridge,
        contextPath: "context.txt",
        modelCallRunner: successfulModelCallRunner,
        question: "What?",
        runId: "run-timeout",
        wholeRunTimeoutMs: 30,
      }),
    ).rejects.toMatchObject({
      details: {
        error: { code: "whole_run_timeout", type: "runtime" },
        failedRunResult: { error: { code: "whole_run_timeout", type: "runtime_control" } },
      },
      name: "BridgeRunFailedError",
    });
  });

  it("user cancellation aborts the bridge and passes abort to an active model call", async () => {
    const abortingBridge = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys, time
request = json.loads(sys.stdin.readline())
print(json.dumps({"type":"model_callback_request","runId":request["runId"],"requestId":"model-call-1","prompt":"slow","metadata":{}}), flush=True)
time.sleep(30)
`);
    const controller = new AbortController();
    let observedAbort = false;
    const modelCallActive = deferredVoid();
    const promise = runSyntheticBridge({
      bridgePath: abortingBridge,
      contextPath: "context.txt",
      modelCallRunner: async (call) => {
        modelCallActive.resolve();
        const response = await resolveOnAbort(call.signal, {
          diagnostics: { exitCode: null, signal: "SIGTERM", stderr: "", stdout: "" },
          error: {
            code: "model_call_cancelled",
            message: "cancelled",
            type: "child_process" as const,
          },
          ok: false as const,
          requestId: call.requestId,
        });
        observedAbort = true;
        return response;
      },
      question: "What?",
      runId: "run-cancel",
      signal: controller.signal,
    });

    await modelCallActive.promise;
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      details: { error: { code: "run_cancelled", type: "runtime" } },
      name: "BridgeRunFailedError",
    });
    expect(observedAbort).toBeTruthy();
  });
});
