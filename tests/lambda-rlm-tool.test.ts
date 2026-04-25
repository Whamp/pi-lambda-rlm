import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLambdaRlmTool, LambdaRlmValidationError } from "../src/lambdaRlmTool.js";
import { ModelCallConcurrencyQueue } from "../src/modelCallQueue.js";

async function tempContextFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-test-"));
  const path = join(dir, "context.txt");
  await writeFile(path, content, "utf8");
  return path;
}

async function tempPythonBridgeScript(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-bridge-script-"));
  const path = join(dir, "bridge.py");
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return path;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("real Lambda-RLM bridge lambda_rlm tool execution", () => {
  it("reads contextPath internally, runs real Lambda-RLM through the Python bridge, services callbacks through a constrained leaf runner, and returns a bounded result without dumping source content", async () => {
    const secretContent = [
      "SECRET_SOURCE_CONTENT_SHOULD_NOT_BE_RETURNED",
      "Ada Lovelace wrote notes about the Analytical Engine.",
      "Grace Hopper worked on compilers and programming languages.",
      "Katherine Johnson calculated trajectories for spaceflight.",
      "The Analytical Engine notes described algorithms and computation.",
    ].join(" ");
    const contextPath = await tempContextFile(secretContent);
    const processCalls: Array<{ args: string[]; prompt: string }> = [];

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Who wrote notes about the Analytical Engine?" },
      {
        leafModel: "google/gemini-test",
        contextWindowChars: 80,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@") ? await readFile(promptFile.slice(1), "utf8") : "";
          processCalls.push({ args: invocation.args, prompt });
          if (prompt.includes("Single digit:") && prompt.includes("select the single most appropriate task type")) {
            return { exitCode: 0, stdout: "2\n", stderr: "" };
          }
          if (prompt.includes("Does this excerpt contain information relevant")) {
            return { exitCode: 0, stdout: "YES\n", stderr: "" };
          }
          if (prompt.includes("Using the following context, answer")) {
            return { exitCode: 0, stdout: "Partial answer: Ada Lovelace wrote notes about the Analytical Engine.\n", stderr: "" };
          }
          if (prompt.includes("Synthesise these partial answers")) {
            return { exitCode: 0, stdout: "Ada Lovelace wrote notes about the Analytical Engine.\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected prompt: ${prompt.slice(0, 120)}` };
        },
      },
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Ada Lovelace wrote notes about the Analytical Engine.");
    expect(text).toContain("Real Lambda-RLM completed");
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).not.toContain("SECRET_SOURCE_CONTENT_SHOULD_NOT_BE_RETURNED");
    expect(JSON.stringify(result.details)).not.toContain("SECRET_SOURCE_CONTENT_SHOULD_NOT_BE_RETURNED");
    expect(result.details).toMatchObject({
      ok: true,
      authoritativeAnswerAvailable: true,
      input: {
        source: "file",
        contextPath,
        contextChars: secretContent.length,
        questionChars: "Who wrote notes about the Analytical Engine?".length,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      modelCalls: {
        total: processCalls.length,
        failed: 0,
      },
      bridgeRun: {
        executionStarted: true,
        pythonBridge: true,
        protocol: "strict-stdout-stdin-ndjson",
        realLambdaRlm: true,
        childPiLeafCalls: processCalls.length,
        leafProfile: "formal_pi_print",
        leafModel: "google/gemini-test",
      },
      output: {
        bounded: true,
        truncated: false,
      },
    });
    expect(result.details).not.toHaveProperty("fakeRun");
    const bridgeRunDetails = result.details.bridgeRun as { modelCallbacks: Array<Record<string, unknown>>; modelCallResponses: Array<Record<string, unknown>> };
    expect(bridgeRunDetails.modelCallbacks[0]).toEqual(
      expect.objectContaining({
        requestId: "model-call-1",
        metadata: expect.objectContaining({ source: "lambda_rlm", phase: "task_detection", combinator: "classifier" }),
        promptChars: expect.any(Number),
      }),
    );
    expect(bridgeRunDetails.modelCallbacks[0]).not.toHaveProperty("prompt");
    expect(bridgeRunDetails.modelCallResponses[0]).toEqual(
      expect.objectContaining({
        requestId: "model-call-1",
        status: "succeeded",
        metadata: expect.objectContaining({ source: "lambda_rlm", phase: "task_detection", combinator: "classifier" }),
        stdoutChars: expect.any(Number),
      }),
    );
    expect(JSON.stringify(result.details)).not.toContain("Single digit:");
    expect(processCalls.length).toBeGreaterThan(1);
    expect(processCalls.some((call) => call.prompt.includes("Single digit:"))).toBe(true);
    expect(processCalls.some((call) => call.prompt.includes("Using the following context, answer"))).toBe(true);
    expect(processCalls[0]?.args).toEqual(
      expect.arrayContaining(["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
    );
  });

  it("shares one configured model-process queue across simultaneous tool runs", async () => {
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys
request = json.loads(sys.stdin.readline())
prompt = "queued prompt for " + request["input"]["question"]
print(json.dumps({"type":"model_callback_request","runId":request["runId"],"requestId":"model-call-1","prompt":prompt,"metadata":{"phase":"leaf"}}), flush=True)
response = json.loads(sys.stdin.readline())
print(json.dumps({"type":"run_result","runId":request["runId"],"ok":True,"content":response.get("content", ""),"modelCalls":1}), flush=True)
`);
    const contextPath = await tempContextFile("queue context");
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const releaseFirst = deferred();
    const starts: string[] = [];

    const sharedLeafProcessRunner = async (invocation: { args: string[] }) => {
      const promptFile = invocation.args.at(-1);
      const prompt = promptFile?.startsWith("@") ? await readFile(promptFile.slice(1), "utf8") : "";
      starts.push(prompt);
      if (starts.length === 1) await releaseFirst.promise;
      const answer = prompt.includes("run A") ? "answer A" : "answer B";
      return { exitCode: 0, stdout: `${answer}\n`, stderr: "" };
    };

    const runA = executeLambdaRlmTool(
      { contextPath, question: "run A" },
      { bridgePath, modelCallQueue: queue, leafProcessRunner: sharedLeafProcessRunner },
    );
    const runB = executeLambdaRlmTool(
      { contextPath, question: "run B" },
      { bridgePath, modelCallQueue: queue, leafProcessRunner: sharedLeafProcessRunner },
    );

    await waitUntil(() => starts.length === 1 && queue.snapshot().queued === 1);
    expect(starts).toHaveLength(1);
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 1, queued: 1 });

    releaseFirst.resolve();
    const [resultA, resultB] = await Promise.all([runA, runB]);
    expect(resultA.details).toMatchObject({ ok: true });
    expect(resultB.details).toMatchObject({ ok: true });
    expect(starts).toEqual(expect.arrayContaining([expect.stringContaining("run A"), expect.stringContaining("run B")]));
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 0, queued: 0 });
  });

  it("returns a structured runtime failure with child process diagnostics when the constrained leaf process exits non-zero", async () => {
    const contextPath = await tempContextFile("context that is read internally");

    const result = await executeLambdaRlmTool(
      { contextPath, question: "What fails?" },
      {
        leafModel: "google/gemini-test",
        leafProcessRunner: async () => ({
          exitCode: 7,
          stdout: "leaf stdout before failure",
          stderr: "leaf stderr auth failure",
          signal: null,
        }),
      },
    );

    expect(result.content[0]!.text).toContain("No authoritative answer is available");
    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "runtime_failed",
      answer: null,
      authoritativeAnswerAvailable: false,
      error: {
        type: "runtime",
        code: "model_callback_failed",
        message: expect.stringContaining("Child pi leaf process exited with code 7"),
      },
      partialRun: {
        executionStarted: true,
        partialDetailsAvailable: true,
        pythonBridge: true,
        modelCallResponses: [
          {
            ok: false,
            requestId: "model-call-1",
            error: { type: "child_process", code: "child_exit_nonzero" },
            diagnostics: {
              stdout: "leaf stdout before failure",
              stderr: "leaf stderr auth failure",
              exitCode: 7,
              signal: null,
            },
          },
        ],
        failedRunResult: {
          error: { type: "model_callback_failure", code: "model_callback_failed" },
          modelCallFailure: {
            diagnostics: {
              stdout: "leaf stdout before failure",
              stderr: "leaf stderr auth failure",
              exitCode: 7,
              signal: null,
            },
          },
        },
      },
    });
  });

  it.each([
    [{}, "missing_context_path"],
    [{ contextPath: "", question: "What?" }, "missing_context_path"],
    [{ contextPath: "file.txt" }, "missing_question"],
    [{ contextPath: "file.txt", question: "" }, "missing_question"],
    [{ contextPath: "file.txt", question: "What?", context: "inline text" }, "unsupported_input"],
    [{ contextPath: "file.txt", question: "What?", prompt: "raw prompt" }, "unsupported_input"],
    [{ contextPath: "file.txt", question: "What?", rawPrompt: "raw prompt" }, "unsupported_input"],
    [{ contextPath: "file.txt", question: "What?", contextPaths: ["a", "b"] }, "mixed_context_path_fields"],
    [{ contextPath: "file.txt", question: "What?", path: "other.txt" }, "unsupported_input"],
    [{ contextPath: "file.txt", question: "What?", extra: true }, "unknown_keys"],
  ])("returns a pre-execution validation failure result for invalid public input shape %#", async (params, code) => {
    const result = await executeLambdaRlmTool(params);

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
    expect(result.details).not.toHaveProperty("partialRun");
  });

  it("fails before execution with structured validation details when the context file is missing", async () => {
    const result = await executeLambdaRlmTool({ contextPath: "/definitely/missing/context.txt", question: "What?" });

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "missing_context_path_file", field: "contextPath" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
    expect(result.details).not.toHaveProperty("partialRun");
  });

  it("fails before execution with structured validation details when contextPath is not a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-dir-"));
    const childDir = join(dir, "not-a-file");
    await mkdir(childDir);

    const result = await executeLambdaRlmTool({ contextPath: childDir, question: "What?" });

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "unreadable_context_path", field: "contextPath" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
    expect(result.details).not.toHaveProperty("partialRun");
  });

  it("returns a structured runtime failure when the bridge emits malformed stdout after execution starts", async () => {
    const contextPath = await tempContextFile("context read before malformed bridge output");
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import sys
sys.stdin.readline()
sys.stderr.write("bridge diagnostic before malformed stdout\\n")
sys.stderr.flush()
print("{not json", flush=True)
`);

    const result = await executeLambdaRlmTool({ contextPath, question: "What happened?" }, { bridgePath });

    expect(result.content[0]!.text).toContain("No authoritative answer is available");
    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "runtime_failed",
      answer: null,
      authoritativeAnswerAvailable: false,
      error: {
        type: "protocol",
        code: "malformed_stdout_json",
        message: expect.stringContaining("Bridge stdout line was not valid JSON"),
      },
      partialRun: {
        executionStarted: true,
        partialDetailsAvailable: true,
        pythonBridge: true,
        protocol: "strict-stdout-stdin-ndjson",
        stdoutProtocolLines: 1,
        stderrDiagnosticsChars: expect.any(Number),
        protocolError: {
          code: "malformed_stdout_json",
          stdoutLine: "{not json",
        },
      },
    });
  });

  it("returns a structured runtime failure when the bridge exits without a final result", async () => {
    const contextPath = await tempContextFile("context read before missing bridge result");
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import sys
sys.stdin.readline()
sys.stderr.write("bridge exited before final result\\n")
sys.stderr.flush()
sys.exit(0)
`);

    const result = await executeLambdaRlmTool({ contextPath, question: "What happened?" }, { bridgePath });

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "runtime_failed",
      answer: null,
      authoritativeAnswerAvailable: false,
      error: {
        type: "protocol",
        code: "missing_final_result",
      },
      partialRun: {
        executionStarted: true,
        partialDetailsAvailable: true,
        pythonBridge: true,
        stdoutProtocolLines: 0,
        finalResults: 0,
      },
    });
  });

  it("returns a structured runtime failure without source contents when a large assembled request hits a bridge that exits before reading stdin", async () => {
    const secretContent = `SECRET_LARGE_STDIN_SOURCE_${"x".repeat(256 * 1024)}`;
    const firstPath = await tempContextFile(secretContent);
    const secondPath = await tempContextFile("small second source keeps contextPaths assembly active");
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import sys
sys.stderr.write("bridge exiting before stdin read\\n")
sys.stderr.flush()
sys.exit(0)
`);

    const result = await executeLambdaRlmTool({ contextPaths: [firstPath, secondPath], question: "What happened?" }, { bridgePath });

    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("lambda_rlm runtime failed");
    expect(result.details).toMatchObject({ ok: false, error: { type: "runtime", code: "bridge_stdin_write_failed" } });
    expect(JSON.stringify(result.details)).not.toContain("SECRET_LARGE_STDIN_SOURCE_");
    expect(text).not.toContain("SECRET_LARGE_STDIN_SOURCE_");
  });

  it("enforces resolved max input bytes from TOML config before starting the real bridge path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lambda-rlm-project-config-"));
    const configPath = join(cwd, ".pi", "lambda-rlm", "config.toml");
    await mkdir(join(cwd, ".pi", "lambda-rlm"), { recursive: true });
    await writeFile(configPath, "[run]\nmax_input_bytes = 9\n", "utf8");
    const contextPath = join(cwd, "context.txt");
    await writeFile(contextPath, "1234567890", "utf8");
    let bridgeStarted = false;

    const result = await executeLambdaRlmTool(
      { contextPath: "context.txt", question: "Too large?" },
      {
        cwd,
        leafProcessRunner: async () => {
          bridgeStarted = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(bridgeStarted).toBe(false);
    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "max_input_bytes_exceeded", field: "contextPath" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
  });

  it("enforces resolved max input bytes before starting the real bridge path", async () => {
    const contextPath = await tempContextFile("1234567890");
    let bridgeStarted = false;

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Too large?", maxInputBytes: 9 },
      {
        leafProcessRunner: async () => {
          bridgeStarted = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(bridgeStarted).toBe(false);
    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "max_input_bytes_exceeded", field: "contextPath" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
  });

  it("rejects an oversized contextPath from stat before reading unreadable contents or invoking the bridge", async () => {
    const contextPath = await tempContextFile("1234567890");
    await chmod(contextPath, 0o000);
    let bridgeStarted = false;

    try {
      const result = await executeLambdaRlmTool(
        { contextPath, question: "Too large?", maxInputBytes: 9 },
        {
          leafProcessRunner: async () => {
            bridgeStarted = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(bridgeStarted).toBe(false);
      expect(result.details).toMatchObject({
        ok: false,
        runStatus: "validation_failed",
        error: { type: "validation", code: "max_input_bytes_exceeded", field: "contextPath" },
        execution: { executionStarted: false, partialDetailsAvailable: false },
      });
    } finally {
      await chmod(contextPath, 0o600);
    }
  });

  it("uses per-run output byte and line tightening in the real bridge path", async () => {
    const contextPath = await tempContextFile("short source");
    const fullOutputDir = await mkdtemp(join(tmpdir(), "lambda-rlm-full-output-"));
    const longAnswer = ["ANSWER", "line two", "line three", "line four"].join("\n");

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Produce long output", outputMaxBytes: 140, outputMaxLines: 3 },
      {
        fullOutputDir,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@") ? await readFile(promptFile.slice(1), "utf8") : "";
          return { exitCode: 0, stdout: prompt.includes("Single digit:") ? "2\n" : `${longAnswer}\n`, stderr: "" };
        },
      },
    );

    expect(result.content[0]!.text).toContain("truncated");
    expect(result.content[0]!.text.split("\n").length).toBeLessThanOrEqual(3);
    expect(Buffer.byteLength(result.content[0]!.text, "utf8")).toBeLessThanOrEqual(140);
    expect(result.details).toMatchObject({ ok: true, output: { truncated: true, maxVisibleBytes: 140, maxVisibleLines: 3 } });
    const fullOutputPath = (result.details.output as any).fullOutputPath;
    await expect(readFile(fullOutputPath, "utf8")).resolves.toContain(longAnswer);
  });

  it("enforces per-run max model calls in the real bridge path before starting an additional leaf process", async () => {
    const contextPath = await tempContextFile("budgeted context");
    const started: string[] = [];

    const result = await executeLambdaRlmTool(
      { contextPath, question: "What?", maxModelCalls: 1 },
      {
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@") ? await readFile(promptFile.slice(1), "utf8") : "";
          started.push(prompt);
          return { exitCode: 0, stdout: prompt.includes("Single digit:") ? "2\n" : "unexpected\n", stderr: "" };
        },
      },
    );

    expect(started).toHaveLength(1);
    expect(result.content[0]!.text).toContain("No authoritative answer is available");
    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "runtime_failed",
      authoritativeAnswerAvailable: false,
      error: { type: "runtime", code: "max_model_calls_exceeded" },
      partialRun: {
        childPiLeafCalls: 1,
        runControls: { maxModelCalls: 1 },
        modelCallResponses: [
          { ok: true, requestId: "model-call-1" },
          { ok: false, requestId: "model-call-2", error: { code: "max_model_calls_exceeded" } },
        ],
      },
    });
  });

  it("returns a structured runtime failure when whole-run timeout aborts the bridge", async () => {
    const contextPath = await tempContextFile("timeout context");
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import sys, time
sys.stdin.readline()
sys.stderr.write("slow bridge started\\n")
sys.stderr.flush()
time.sleep(30)
`);

    const result = await executeLambdaRlmTool({ contextPath, question: "Timeout?", wholeRunTimeoutMs: 20 }, { bridgePath });

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "runtime_failed",
      authoritativeAnswerAvailable: false,
      error: { type: "runtime", code: "whole_run_timeout" },
      partialRun: { executionStarted: true, partialDetailsAvailable: true, stderrDiagnosticsChars: expect.any(Number), runControls: { wholeRunTimeoutMs: 20 } },
    });
  });

  it("passes configured per-model-call timeout into the leaf runner and reports cleanup as a runtime failure", async () => {
    const contextPath = await tempContextFile("per call timeout context");
    let observedAbort = false;

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Timeout leaf?", modelCallTimeoutMs: 10 },
      {
        leafProcessRunner: (invocation) =>
          new Promise((resolve) => {
            invocation.signal?.addEventListener("abort", () => {
              observedAbort = true;
              resolve({ exitCode: null, signal: "SIGTERM", stdout: "partial", stderr: "leaf timeout" });
            });
          }),
      },
    );

    expect(observedAbort).toBe(true);
    expect(result.details).toMatchObject({
      ok: false,
      authoritativeAnswerAvailable: false,
      error: { code: "model_callback_failed" },
      partialRun: {
        runControls: { modelCallTimeoutMs: 10 },
        modelCallResponses: [{ ok: false, error: { code: "per_model_call_timeout" }, diagnostics: { signal: "SIGTERM" } }],
      },
    });
  });

  it("accepts contextPaths, assembles ordered source manifest and source-delimited context for one consolidated bridge run without returning source contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-multi-"));
    const firstPath = join(dir, "b.txt");
    const secondPath = join(dir, "a.txt");
    await writeFile(firstPath, "FIRST_SECRET_CONTENT\nfirst fact", "utf8");
    await writeFile(secondPath, "SECOND_SECRET_CONTENT\nsecond fact", "utf8");
    const prompts: string[] = [];

    const result = await executeLambdaRlmTool(
      { contextPaths: [firstPath, secondPath], question: "What facts are present?" },
      {
        contextWindowChars: 1000,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@") ? await readFile(promptFile.slice(1), "utf8") : "";
          prompts.push(prompt);
          return { exitCode: 0, stdout: prompt.includes("Single digit:") ? "2\n" : "Both facts are present.\n", stderr: "" };
        },
      },
    );

    expect(result.details).toMatchObject({
      ok: true,
      input: {
        source: "files",
        sourceCount: 2,
        totalBytes: Buffer.byteLength("FIRST_SECRET_CONTENT\nfirst factSECOND_SECRET_CONTENT\nsecond fact", "utf8"),
        sources: [
          { sourceNumber: 1, path: firstPath, bytes: Buffer.byteLength("FIRST_SECRET_CONTENT\nfirst fact", "utf8"), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          { sourceNumber: 2, path: secondPath, bytes: Buffer.byteLength("SECOND_SECRET_CONTENT\nsecond fact", "utf8"), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
      },
      bridgeRun: { childPiLeafCalls: prompts.length },
    });
    const leafPrompt = prompts.find((prompt) => prompt.includes("Using the following context, answer"));
    expect(leafPrompt).toContain(`Sources:\n[1] ${firstPath} (`);
    expect(leafPrompt).toContain(`[2] ${secondPath} (`);
    expect(leafPrompt).toContain(`--- BEGIN SOURCE 1: ${firstPath} ---`);
    expect(leafPrompt).toContain("FIRST_SECRET_CONTENT");
    expect(leafPrompt).toContain(`--- BEGIN SOURCE 2: ${secondPath} ---`);
    expect(leafPrompt).toContain("SECOND_SECRET_CONTENT");
    expect(JSON.stringify(result.details)).not.toContain("FIRST_SECRET_CONTENT");
    expect(JSON.stringify(result.details)).not.toContain("SECOND_SECRET_CONTENT");
    expect(result.content[0]!.text).not.toContain("FIRST_SECRET_CONTENT");
    expect(result.content[0]!.text).not.toContain("SECOND_SECRET_CONTENT");
  });

  it("rejects requests that mix contextPath and contextPaths before execution", async () => {
    const result = await executeLambdaRlmTool({ contextPath: "one.txt", contextPaths: ["two.txt"], question: "What?" });

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "mixed_context_path_fields", field: "contextPaths" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
  });

  it("fails before execution when one contextPaths entry is missing", async () => {
    const existing = await tempContextFile("exists");

    const result = await executeLambdaRlmTool({ contextPaths: [existing, "/definitely/missing/multi.txt"], question: "What?" });

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "missing_context_path_file", field: "contextPaths" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
    expect(result.details).not.toHaveProperty("partialRun");
  });

  it("fails before execution when one contextPaths entry is unreadable", async () => {
    const existing = await tempContextFile("exists");
    const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-multi-unreadable-"));

    const result = await executeLambdaRlmTool({ contextPaths: [existing, dir], question: "What?" });

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "unreadable_context_path", field: "contextPaths" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
  });

  it("enforces max input bytes across all contextPaths before invoking the bridge", async () => {
    const first = await tempContextFile("12345");
    const second = await tempContextFile("67890");
    let bridgeStarted = false;

    const result = await executeLambdaRlmTool(
      { contextPaths: [first, second], question: "Too large?", maxInputBytes: 9 },
      { leafProcessRunner: async () => { bridgeStarted = true; return { exitCode: 0, stdout: "", stderr: "" }; } },
    );

    expect(bridgeStarted).toBe(false);
    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "max_input_bytes_exceeded", field: "contextPaths" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
  });

  it("uses one consolidated bridge request for multiple contextPaths", async () => {
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3\nimport json, sys\nrequest = json.loads(sys.stdin.readline())\ncontext = request["input"].get("context", "")\nassert "--- BEGIN SOURCE 1:" in context and "--- BEGIN SOURCE 2:" in context\nassert request["input"]["question"] == "Consolidated?"\nprint(json.dumps({"type":"model_callback_request","runId":request["runId"],"requestId":"model-call-1","prompt":context,"metadata":{"phase":"leaf"}}), flush=True)\nresponse = json.loads(sys.stdin.readline())\nprint(json.dumps({"type":"run_result","runId":request["runId"],"ok":True,"content":"consolidated answer","modelCalls":1}), flush=True)\n`);
    const first = await tempContextFile("alpha");
    const second = await tempContextFile("beta");
    let leafCalls = 0;

    const result = await executeLambdaRlmTool(
      { contextPaths: [first, second], question: "Consolidated?" },
      { bridgePath, leafProcessRunner: async () => { leafCalls += 1; return { exitCode: 0, stdout: "ok\n", stderr: "" }; } },
    );

    expect(leafCalls).toBe(1);
    expect(result.details).toMatchObject({ ok: true, bridgeRun: { finalResults: 1, childPiLeafCalls: 1 } });
  });

  it("returns structured cancellation failure and aborts the active leaf through the tool boundary", async () => {
    const contextPath = await tempContextFile("cancel context");
    const controller = new AbortController();
    let observedAbort = false;
    const promise = executeLambdaRlmTool(
      { contextPath, question: "Cancel?" },
      {
        signal: controller.signal,
        leafProcessRunner: (invocation) =>
          new Promise((resolve) => {
            invocation.signal?.addEventListener("abort", () => {
              observedAbort = true;
              resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "cancelled" });
            });
            setTimeout(() => controller.abort(), 0);
          }),
      },
    );

    const result = await promise;

    expect(observedAbort).toBe(true);
    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "runtime_failed",
      authoritativeAnswerAvailable: false,
      error: { code: "run_cancelled" },
      partialRun: { executionStarted: true, partialDetailsAvailable: true },
    });
  });

  it("rejects per-run loosening with a structured pre-execution validation failure", async () => {
    const contextPath = await tempContextFile("short source");

    const result = await executeLambdaRlmTool({ contextPath, question: "Loosen?", maxInputBytes: 999999999 });

    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: "per_run_limit_loosened", field: "maxInputBytes" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
  });

  it("truncates long visible output deterministically, preserves the compact run summary, and writes recoverable full output when configured", async () => {
    const contextPath = await tempContextFile("short source");
    const fullOutputDir = await mkdtemp(join(tmpdir(), "lambda-rlm-full-output-"));
    const longAnswer = `ANSWER-${"x".repeat(500)}`;

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Produce long output" },
      {
        outputMaxVisibleChars: 180,
        fullOutputDir,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@") ? await readFile(promptFile.slice(1), "utf8") : "";
          return { exitCode: 0, stdout: prompt.includes("Single digit:") ? "2\n" : `${longAnswer}\n`, stderr: "" };
        },
      },
    );

    expect(result.content[0]!.text.length).toBeLessThanOrEqual(180);
    expect(result.content[0]!.text).toContain("truncated");
    expect(result.content[0]!.text).toContain("Run summary: Real Lambda-RLM completed");
    expect(result.content[0]!.text).toContain("Model calls:");
    expect(result.details).toMatchObject({ ok: true, output: { truncated: true, maxVisibleChars: 180 } });
    const fullOutputPath = (result.details.output as any).fullOutputPath;
    expect(fullOutputPath).toEqual(expect.stringContaining(fullOutputDir));
    await expect(readFile(fullOutputPath, "utf8")).resolves.toContain(longAnswer);
  });
});
