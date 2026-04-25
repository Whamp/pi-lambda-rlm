import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSyntheticBridge, BridgeProtocolError } from "../src/bridgeRunner.js";

const bridgePath = fileURLToPath(new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url));

async function tempContextFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-bridge-test-"));
  const path = join(dir, "context.txt");
  await writeFile(path, content, "utf8");
  return path;
}

async function tempPythonBridgeScript(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-bridge-control-test-"));
  const path = join(dir, "bridge.py");
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return path;
}

const successfulModelCallRunner = async (call: { requestId: string; prompt?: string }) => {
  const prompt = call.prompt ?? "";
  const content = prompt.includes("Single digit:") ? "2" : "real bridge model answer";
  return {
    ok: true as const,
    requestId: call.requestId,
    content,
    diagnostics: { stdoutChars: content.length, stderr: "", exitCode: 0 },
  };
};

describe("Python NDJSON bridge runner", () => {
  it("starts the Python bridge, answers request-identified real Lambda-RLM model callbacks through a model call runner, and returns exactly one final result", async () => {
    const contextPath = await tempContextFile("small context for bridge test");
    const result = await runSyntheticBridge({
      bridgePath,
      runId: "run-test-1",
      question: "What is this file about?",
      contextPath,
      modelCallRunner: successfulModelCallRunner,
    });

    expect(result.content).toEqual("real bridge model answer");
    expect(result.modelCallbacks).toEqual([
      {
        requestId: "model-call-1",
        prompt: expect.stringContaining("Single digit:"),
        metadata: expect.objectContaining({ source: "lambda_rlm", phase: "task_detection", combinator: "classifier", promptKey: "TASK-DETECTION-PROMPT.md" }),
      },
      {
        requestId: "model-call-2",
        prompt: expect.stringContaining("What is this file about?"),
        metadata: expect.objectContaining({ source: "lambda_rlm", phase: "execute_phi", combinator: "leaf", promptKey: "tasks/qa.md" }),
      },
    ]);
    expect(result.modelCallResponses).toEqual([
      expect.objectContaining({ ok: true, requestId: "model-call-1", content: "2" }),
      expect.objectContaining({ ok: true, requestId: "model-call-2", content: "real bridge model answer" }),
    ]);
    expect(result.finalResults).toHaveLength(1);
    expect(result.stderr).toContain("bridge: received real Lambda-RLM run request run-test-1");
    expect(result.stdoutLines).toHaveLength(3);
  });

  it("rejects model callback requests that omit explicit metadata", async () => {
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json
request = json.loads(input())
print(json.dumps({"type":"model_callback_request","runId":request["runId"],"requestId":"model-call-1","prompt":"ordinary overridden prompt without metadata"}), flush=True)
`);

    await expect(
      runSyntheticBridge({
        bridgePath,
        runId: "run-missing-metadata",
        question: "What?",
        contextPath: "context.txt",
        modelCallRunner: successfulModelCallRunner,
      }),
    ).rejects.toMatchObject({
      name: "BridgeProtocolError",
      details: { error: { code: "invalid_model_callback_request" } },
    });
  });

  it("sends a structured failure response when the model call runner fails", async () => {
    await expect(
      runSyntheticBridge({
        bridgePath,
        runId: "run-leaf-failure",
        question: "What?",
        contextPath: await tempContextFile("failure context"),
        modelCallRunner: async (call) => ({
          ok: false,
          requestId: call.requestId,
          error: { type: "child_process", code: "child_exit_nonzero", message: "child failed" },
          diagnostics: { stdout: "", stderr: "bad auth", exitCode: 1 },
        }),
      }),
    ).rejects.toMatchObject({
      name: "BridgeRunFailedError",
      details: {
        error: { type: "runtime", code: "model_callback_failed", message: expect.stringContaining("child failed") },
        failedRunResult: {
          error: { type: "model_callback_failure", code: "model_callback_failed" },
          modelCallFailure: {
            diagnostics: { stdout: "", stderr: "bad auth", exitCode: 1 },
          },
        },
        modelCallResponses: [
          {
            ok: false,
            diagnostics: { stdout: "", stderr: "bad auth", exitCode: 1 },
          },
        ],
      },
    });
  });

  it("fails with a structured protocol error when stdout contains malformed NDJSON", async () => {
    await expect(
      runSyntheticBridge({
        bridgePath,
        runId: "run-malformed-stdout",
        question: "What?",
        contextPath: "context.txt",
        modelCallRunner: successfulModelCallRunner,
        bridgeArgs: ["--emit-malformed-stdout"],
      }),
    ).rejects.toMatchObject({
      name: "BridgeProtocolError",
      details: {
        ok: false,
        error: {
          type: "protocol",
          code: "malformed_stdout_json",
          message: expect.stringContaining("Bridge stdout line was not valid JSON"),
        },
      },
    });
  });

  it("the Python bridge returns a structured error result when stdin contains malformed JSON", async () => {
    const child = spawn("python3", [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.write("{not json}\n");
    child.stdin.end();

    const [stdout] = (await once(child.stdout, "data")) as [Buffer];
    const message = JSON.parse(stdout.toString("utf8"));
    expect(message).toMatchObject({
      type: "run_result",
      ok: false,
      error: { type: "protocol", code: "malformed_stdin_json" },
    });

    await once(child, "exit");
  });

  it("fails single-in-flight mode when the bridge emits a second callback before the first response", async () => {
    await expect(
      runSyntheticBridge({
        bridgePath,
        runId: "run-duplicate-callback",
        question: "What?",
        contextPath: "context.txt",
        modelCallRunner: successfulModelCallRunner,
        bridgeArgs: ["--emit-second-callback"],
      }),
    ).rejects.toMatchObject({
      name: "BridgeProtocolError",
      details: {
        ok: false,
        error: { type: "protocol", code: "single_in_flight_violation" },
      },
    });
  });

  it("enforces max model calls before starting another leaf call and returns a structured runtime failure", async () => {
    const contextPath = await tempContextFile("budget context");
    const started: string[] = [];

    await expect(
      runSyntheticBridge({
        bridgePath,
        runId: "run-budget",
        question: "What?",
        contextPath,
        maxModelCalls: 1,
        modelCallRunner: async (call) => {
          started.push(call.requestId);
          return successfulModelCallRunner(call);
        },
      }),
    ).rejects.toMatchObject({
      name: "BridgeRunFailedError",
      details: {
        error: { type: "runtime", code: "max_model_calls_exceeded" },
        failedRunResult: {
          modelCallFailure: {
            requestId: "model-call-2",
            error: { code: "max_model_calls_exceeded" },
          },
        },
      },
    });
    expect(started).toEqual(["model-call-1"]);
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
        runId: "run-timeout",
        question: "What?",
        contextPath: "context.txt",
        wholeRunTimeoutMs: 30,
        modelCallRunner: successfulModelCallRunner,
      }),
    ).rejects.toMatchObject({
      name: "BridgeRunFailedError",
      details: {
        error: { type: "runtime", code: "whole_run_timeout" },
        failedRunResult: { error: { type: "runtime_control", code: "whole_run_timeout" } },
      },
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
    const promise = runSyntheticBridge({
      bridgePath: abortingBridge,
      runId: "run-cancel",
      question: "What?",
      contextPath: "context.txt",
      signal: controller.signal,
      modelCallRunner: (call) =>
        new Promise((resolve) => {
          call.signal?.addEventListener("abort", () => {
            observedAbort = true;
            resolve({
              ok: false,
              requestId: call.requestId,
              error: { type: "child_process", code: "model_call_cancelled", message: "cancelled" },
              diagnostics: { stdout: "", stderr: "", exitCode: null, signal: "SIGTERM" },
            });
          });
        }),
    });

    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toMatchObject({
      name: "BridgeRunFailedError",
      details: { error: { type: "runtime", code: "run_cancelled" } },
    });
    expect(observedAbort).toBe(true);
  });
});
