import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSyntheticBridge, BridgeProtocolError } from "../src/bridgeRunner.js";

const bridgePath = fileURLToPath(new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url));
const successfulModelCallRunner = async (call: { requestId: string }) => ({
  ok: true as const,
  requestId: call.requestId,
  content: "synthetic model answer",
  diagnostics: { stdoutChars: "synthetic model answer".length, stderr: "", exitCode: 0 },
});

describe("Python NDJSON bridge runner", () => {
  it("starts the Python bridge, answers one request-identified synthetic model callback through a model call runner, and returns exactly one final result", async () => {
    const result = await runSyntheticBridge({
      bridgePath,
      runId: "run-test-1",
      question: "What is this file about?",
      contextPath: "context.txt",
      modelCallRunner: successfulModelCallRunner,
    });

    expect(result.content).toEqual("synthetic model answer");
    expect(result.modelCallbacks).toEqual([
      {
        requestId: "model-call-1",
        prompt: expect.stringContaining("What is this file about?"),
        metadata: { phase: "synthetic", promptKey: "synthetic.tracer" },
      },
    ]);
    expect(result.modelCallResponses).toEqual([
      expect.objectContaining({ ok: true, requestId: "model-call-1", content: "synthetic model answer" }),
    ]);
    expect(result.finalResults).toHaveLength(1);
    expect(result.stderr).toContain("bridge: received run request run-test-1");
    expect(result.stdoutLines).toHaveLength(2);
  });

  it("sends a structured failure response when the model call runner fails", async () => {
    await expect(
      runSyntheticBridge({
        bridgePath,
        runId: "run-leaf-failure",
        question: "What?",
        contextPath: "context.txt",
        modelCallRunner: async (call) => ({
          ok: false,
          requestId: call.requestId,
          error: { type: "child_process", code: "child_exit_nonzero", message: "child failed" },
          diagnostics: { stdout: "", stderr: "bad auth", exitCode: 1 },
        }),
      }),
    ).rejects.toMatchObject({
      name: "BridgeProtocolError",
      details: { error: { code: "bridge_run_failed", message: expect.stringContaining("child failed") } },
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
});
