import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { diagnosticHash } from "../src/diagnostics.js";
import { executeLambdaRlmTool as executeLambdaRlmToolRaw } from "../src/lambda-rlm-tool.js";
import type { ProcessResult } from "../src/leaf-runner.js";
import { ModelCallConcurrencyQueue } from "../src/model-call-queue.js";

async function tempContextFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-test-"));
  const path = join(dir, "context.txt");
  await writeFile(path, content, "utf-8");
  return path;
}

async function executeLambdaRlmTool(
  params: unknown,
  options: Parameters<typeof executeLambdaRlmToolRaw>[1] = {},
) {
  const isolatedHome =
    options.homeDir || options.globalConfigPath
      ? undefined
      : await mkdtemp(join(tmpdir(), "lambda-rlm-isolated-home-"));
  return executeLambdaRlmToolRaw(params, {
    ...(isolatedHome ? { homeDir: isolatedHome } : {}),
    leafModel: "google/gemini-test",
    ...options,
  });
}

async function tempPythonBridgeScript(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-bridge-script-"));
  const path = join(dir, "bridge.py");
  await writeFile(path, source, "utf-8");
  await chmod(path, 0o755);
  return path;
}

type LambdaRlmToolTestResult = Awaited<ReturnType<typeof executeLambdaRlmTool>>;

function firstContentText(result: LambdaRlmToolTestResult): string {
  const [first] = result.content;
  if (!first) {
    throw new Error("Expected lambda_rlm result to include visible text content.");
  }
  return first.text;
}

function sortedStrings(values: Iterable<string>) {
  const sorted = [...values];
  // ES2022 target: Array#toSorted is unavailable in this project.
  // oxlint-disable-next-line unicorn/no-array-sort
  return sorted.sort();
}

function fullOutputPath(result: LambdaRlmToolTestResult): string {
  const { output } = result.details;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("Expected lambda_rlm result details to include output metadata.");
  }
  const path = (output as Record<string, unknown>).fullOutputPath;
  if (typeof path !== "string") {
    throw new TypeError("Expected output metadata to include a fullOutputPath string.");
  }
  return path;
}

function resolveOnAbort(
  signal: AbortSignal | undefined,
  result: ProcessResult,
): Promise<ProcessResult> {
  // AbortSignal is EventTarget-based; a one-shot promise is the clearest test seam.
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(result), { once: true });
  });
}

function deferred<T = void>() {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void;
  // Tests need a controllable deferred to assert queue ordering.
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(5);
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
    const processCalls: { args: string[]; prompt: string }[] = [];

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Who wrote notes about the Analytical Engine?" },
      {
        contextWindowChars: 80,
        leafModel: "google/gemini-test",
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@")
            ? await readFile(promptFile.slice(1), "utf-8")
            : "";
          processCalls.push({ args: invocation.args, prompt });
          if (
            prompt.includes("Single digit:") &&
            prompt.includes("select the single most appropriate task type")
          ) {
            return { exitCode: 0, stdout: "2\n", stderr: "" };
          }
          if (prompt.includes("Does this excerpt contain information relevant")) {
            return { exitCode: 0, stdout: "YES\n", stderr: "" };
          }
          if (prompt.includes("Using the following context, answer")) {
            return {
              exitCode: 0,
              stdout: "Partial answer: Ada Lovelace wrote notes about the Analytical Engine.\n",
              stderr: "",
            };
          }
          if (prompt.includes("Synthesise these partial answers")) {
            return {
              exitCode: 0,
              stdout: "Ada Lovelace wrote notes about the Analytical Engine.\n",
              stderr: "",
            };
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
    expect(JSON.stringify(result.details)).not.toContain(
      "SECRET_SOURCE_CONTENT_SHOULD_NOT_BE_RETURNED",
    );
    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: true,
      bridgeRun: {
        childPiLeafCalls: processCalls.length,
        executionStarted: true,
        leafModel: "google/gemini-test",
        leafProfile: "formal_pi_print",
        protocol: "strict-stdout-stdin-ndjson",
        pythonBridge: true,
        realLambdaRlm: true,
      },
      input: {
        contextChars: secretContent.length,
        contextPath,
        questionChars: "Who wrote notes about the Analytical Engine?".length,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: "file",
      },
      modelCalls: {
        failed: 0,
        total: processCalls.length,
      },
      ok: true,
      output: {
        bounded: true,
        truncated: false,
      },
    });
    expect(result.details).not.toHaveProperty("fakeRun");
    const bridgeRunDetails = result.details.bridgeRun as {
      modelCallbacks: Record<string, unknown>[];
      modelCallResponses: Record<string, unknown>[];
    };
    expect(bridgeRunDetails.modelCallbacks[0]).toStrictEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: "lambda_rlm",
          phase: "task_detection",
          combinator: "classifier",
        }),
        promptChars: expect.any(Number),
        requestId: "model-call-1",
      }),
    );
    expect(bridgeRunDetails.modelCallbacks[0]).not.toHaveProperty("prompt");
    expect(bridgeRunDetails.modelCallResponses[0]).toStrictEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: "lambda_rlm",
          phase: "task_detection",
          combinator: "classifier",
        }),
        requestId: "model-call-1",
        status: "succeeded",
        stdoutChars: expect.any(Number),
      }),
    );
    const promptDetails = (
      result.details.bridgeRun as { prompts: Record<string, Record<string, unknown>> }
    ).prompts;
    expect(promptDetails["TASK-DETECTION-PROMPT.md"]).toStrictEqual(
      expect.objectContaining({
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: expect.objectContaining({ layer: "built_in" }),
      }),
    );
    expect(promptDetails["tasks/qa.md"]).toStrictEqual(
      expect.objectContaining({
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: expect.objectContaining({ layer: "built_in" }),
      }),
    );
    expect(promptDetails["filters/relevance.md"]).toStrictEqual(
      expect.objectContaining({
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: expect.objectContaining({ layer: "built_in" }),
      }),
    );
    expect(promptDetails["reducers/select-relevant.md"]).toStrictEqual(
      expect.objectContaining({
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: expect.objectContaining({ layer: "built_in" }),
      }),
    );
    expect(promptDetails["tasks/qa.md"]).not.toHaveProperty("template");
    expect(promptDetails["tasks/qa.md"]).not.toHaveProperty("body");
    expect(JSON.stringify(result.details)).not.toContain("Single digit:");
    expect(processCalls.length).toBeGreaterThan(1);
    expect(processCalls.some((call) => call.prompt.includes("Single digit:"))).toBeTruthy();
    expect(
      processCalls.some((call) => call.prompt.includes("Using the following context, answer")),
    ).toBeTruthy();
    expect(processCalls[0]?.args).toStrictEqual(
      expect.arrayContaining([
        "--print",
        "--no-session",
        "--tools",
        "read,grep,find,ls",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
      ]),
    );
  });

  it("uses a QA prompt overlay in model-visible Lambda-RLM leaf prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lambda-rlm-qa-overlay-"));
    await mkdir(join(cwd, ".pi", "lambda-rlm", "prompts", "tasks"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "lambda-rlm", "prompts", "tasks", "qa.md"),
      "PROJECT QA OVERRIDE\nQuestion: <<query>>\nText: <<text>>",
      "utf-8",
    );
    const contextPath = join(cwd, "context.txt");
    await writeFile(contextPath, "The override fact is blue.", "utf-8");
    const prompts: string[] = [];

    const result = await executeLambdaRlmTool(
      { contextPath: "context.txt", question: "What color is the override fact?" },
      {
        contextWindowChars: 1000,
        cwd,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@")
            ? await readFile(promptFile.slice(1), "utf-8")
            : "";
          prompts.push(prompt);
          return {
            exitCode: 0,
            stdout: prompt.includes("Single digit:") ? "2\n" : "blue\n",
            stderr: "",
          };
        },
      },
    );

    expect(result.details).toMatchObject({
      bridgeRun: { childPiLeafCalls: prompts.length },
      ok: true,
    });
    expect(prompts.some((prompt) => prompt.includes("PROJECT QA OVERRIDE"))).toBeTruthy();
    expect(
      prompts.some((prompt) => prompt.includes("Using the following context, answer")),
    ).toBeFalsy();
    expect(JSON.stringify(result.details)).not.toContain("PROJECT QA OVERRIDE");
    expect(result.details).toMatchObject({
      bridgeRun: {
        prompts: {
          "tasks/qa.md": {
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            source: { layer: "project" },
          },
        },
      },
    });
  });

  it("uses a Formal Leaf system prompt overlay when constructing child Pi commands", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lambda-rlm-formal-overlay-"));
    await mkdir(join(cwd, ".pi", "lambda-rlm", "prompts"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "lambda-rlm", "prompts", "FORMAL-LEAF-SYSTEM-PROMPT.md"),
      "PROJECT FORMAL LEAF SYSTEM",
      "utf-8",
    );
    const contextPath = join(cwd, "context.txt");
    await writeFile(contextPath, "Formal overlay context", "utf-8");
    const systemPrompts: string[] = [];

    const result = await executeLambdaRlmTool(
      { contextPath: "context.txt", question: "What?" },
      {
        cwd,
        leafProcessRunner: async (invocation) => {
          const index = invocation.args.indexOf("--system-prompt");
          systemPrompts.push(index === -1 ? "" : (invocation.args[index + 1] ?? ""));
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@")
            ? await readFile(promptFile.slice(1), "utf-8")
            : "";
          return {
            exitCode: 0,
            stderr: "",
            stdout: prompt.includes("Single digit:") ? "2\n" : "formal answer\n",
          };
        },
      },
    );

    expect(result.details).toMatchObject({ ok: true });
    expect(systemPrompts).toContain("PROJECT FORMAL LEAF SYSTEM");
  });

  it("fails prompt overlay validation before bridge or leaf execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lambda-rlm-bad-prompt-"));
    await mkdir(join(cwd, ".pi", "lambda-rlm", "prompts", "tasks"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "lambda-rlm", "prompts", "tasks", "qa.md"),
      "Bad <<text>> <<typo>>",
      "utf-8",
    );
    const contextPath = join(cwd, "context.txt");
    await writeFile(contextPath, "context", "utf-8");
    let leafStarted = false;

    const result = await executeLambdaRlmTool(
      { contextPath: "context.txt", question: "What?" },
      {
        cwd,
        leafProcessRunner: () => {
          leafStarted = true;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(leafStarted).toBeFalsy();
    expect(result.details).toMatchObject({
      error: { code: "unknown_prompt_placeholder", field: "tasks/qa.md", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
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
      const prompt = promptFile?.startsWith("@")
        ? await readFile(promptFile.slice(1), "utf-8")
        : "";
      starts.push(prompt);
      if (starts.length === 1) {
        await releaseFirst.promise;
      }
      const answer = prompt.includes("run A") ? "answer A" : "answer B";
      return { exitCode: 0, stderr: "", stdout: `${answer}\n` };
    };

    const runA = executeLambdaRlmTool(
      { contextPath, question: "run A" },
      { bridgePath, leafProcessRunner: sharedLeafProcessRunner, modelCallQueue: queue },
    );
    const runB = executeLambdaRlmTool(
      { contextPath, question: "run B" },
      { bridgePath, leafProcessRunner: sharedLeafProcessRunner, modelCallQueue: queue },
    );

    await waitUntil(() => starts.length === 1 && queue.snapshot().queued === 1);
    expect(starts).toHaveLength(1);
    expect(queue.snapshot()).toStrictEqual({ active: 1, concurrency: 1, queued: 1 });

    releaseFirst.resolve();
    const [resultA, resultB] = await Promise.all([runA, runB]);
    expect(resultA.details).toMatchObject({ ok: true });
    expect(resultB.details).toMatchObject({ ok: true });
    expect(starts).toStrictEqual(
      expect.arrayContaining([expect.stringContaining("run A"), expect.stringContaining("run B")]),
    );
    expect(queue.snapshot()).toStrictEqual({ active: 0, concurrency: 1, queued: 0 });
  });

  it("returns a structured runtime failure with child process diagnostics when the constrained leaf process exits non-zero", async () => {
    const contextPath = await tempContextFile("context that is read internally");

    const result = await executeLambdaRlmTool(
      { contextPath, question: "What fails?" },
      {
        leafModel: "google/gemini-test",
        leafProcessRunner: () => ({
          exitCode: 7,
          signal: null,
          stderr: "leaf stderr auth failure",
          stdout: "leaf stdout before failure",
        }),
      },
    );

    expect(firstContentText(result)).toContain("No authoritative answer is available");
    expect(result.details).toMatchObject({
      answer: null,
      authoritativeAnswerAvailable: false,
      error: {
        code: "model_callback_failed",
        message: expect.stringContaining("Child pi leaf process exited with code 7"),
        type: "runtime",
      },
      ok: false,
      partialRun: {
        executionStarted: true,
        failedRunResult: {
          error: { code: "model_callback_failed", type: "model_callback_failure" },
          modelCallFailure: {
            diagnostics: {
              exitCode: 7,
              signal: null,
              stderr: "",
              stderrBytes: Buffer.byteLength("leaf stderr auth failure", "utf-8"),
              stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              stdout: "",
              stdoutBytes: Buffer.byteLength("leaf stdout before failure", "utf-8"),
              stdoutSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          },
        },
        modelCallResponses: [
          {
            ok: false,
            requestId: "model-call-1",
            error: { type: "child_process", code: "child_exit_nonzero" },
            diagnostics: {
              stdout: "",
              stderr: "",
              stdoutBytes: Buffer.byteLength("leaf stdout before failure", "utf-8"),
              stderrBytes: Buffer.byteLength("leaf stderr auth failure", "utf-8"),
              stdoutSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              exitCode: 7,
              signal: null,
            },
          },
        ],
        partialDetailsAvailable: true,
        pythonBridge: true,
      },
      runStatus: "runtime_failed",
    });
  });

  it.each([
    [{}, "missing_context_path"],
    [{ contextPath: "", question: "What?" }, "missing_context_path"],
    [{ contextPath: "file.txt" }, "missing_question"],
    [{ contextPath: "file.txt", question: "" }, "missing_question"],
    [{ context: "inline text", contextPath: "file.txt", question: "What?" }, "unsupported_input"],
    [{ contextPath: "file.txt", prompt: "raw prompt", question: "What?" }, "unsupported_input"],
    [{ contextPath: "file.txt", question: "What?", rawPrompt: "raw prompt" }, "unsupported_input"],
    [
      { contextPath: "file.txt", contextPaths: ["a", "b"], question: "What?" },
      "mixed_context_path_fields",
    ],
    [{ contextPath: "file.txt", path: "other.txt", question: "What?" }, "unsupported_input"],
    [{ contextPath: "file.txt", extra: true, question: "What?" }, "unknown_keys"],
  ])(
    "returns a pre-execution validation failure result for invalid public input shape %#",
    async (params, code) => {
      const result = await executeLambdaRlmTool(params);

      expect(result.details).toMatchObject({
        error: { code, type: "validation" },
        execution: { executionStarted: false, partialDetailsAvailable: false },
        ok: false,
        runStatus: "validation_failed",
      });
      expect(result.details).not.toHaveProperty("partialRun");
    },
  );

  it("fails before execution with structured validation details when the context file is missing", async () => {
    const result = await executeLambdaRlmTool({
      contextPath: "/definitely/missing/context.txt",
      question: "What?",
    });

    expect(result.details).toMatchObject({
      error: { code: "missing_context_path_file", field: "contextPath", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
    expect(result.details).not.toHaveProperty("partialRun");
  });

  it("fails before execution with structured validation details when contextPath is not a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-dir-"));
    const childDir = join(dir, "not-a-file");
    await mkdir(childDir);

    const result = await executeLambdaRlmTool({ contextPath: childDir, question: "What?" });

    expect(result.details).toMatchObject({
      error: { code: "unreadable_context_path", field: "contextPath", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
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

    const result = await executeLambdaRlmTool(
      { contextPath, question: "What happened?" },
      { bridgePath },
    );

    expect(firstContentText(result)).toContain("No authoritative answer is available");
    expect(result.details).toMatchObject({
      answer: null,
      authoritativeAnswerAvailable: false,
      error: {
        code: "malformed_stdout_json",
        message: expect.stringContaining("Bridge stdout line was not valid JSON"),
        type: "protocol",
      },
      ok: false,
      partialRun: {
        executionStarted: true,
        partialDetailsAvailable: true,
        protocol: "strict-stdout-stdin-ndjson",
        protocolError: {
          code: "malformed_stdout_json",
          offendingStdoutLine: {
            bytes: Buffer.byteLength("{not json", "utf-8"),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        pythonBridge: true,
        stderrDiagnosticsChars: expect.any(Number),
        stdoutProtocolLines: 1,
      },
      runStatus: "runtime_failed",
    });
    expect(JSON.stringify(result.details)).not.toContain("{not json");
    expect(JSON.stringify(result.details)).not.toContain(
      "bridge diagnostic before malformed stdout",
    );
  });

  it("sanitizes child stdout and stderr in runtime failure details", async () => {
    const contextPath = await tempContextFile("child failure context");
    const rawStdout = "RAW_CHILD_STDOUT_SECRET";
    const rawStderr = "RAW_CHILD_STDERR_SECRET";

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Trigger child failure?" },
      {
        contextWindowChars: 1000,
        leafProcessRunner: () => ({
          exitCode: 17,
          signal: null,
          stderr: rawStderr,
          stdout: rawStdout,
        }),
      },
    );

    const serialized = JSON.stringify(result.details);
    expect(serialized).not.toContain(rawStdout);
    expect(serialized).not.toContain(rawStderr);
    expect(result.details).toMatchObject({
      ok: false,
      partialRun: {
        modelCallResponses: [
          {
            diagnostics: {
              exitCode: 17,
              stderr: "",
              stderrBytes: Buffer.byteLength(rawStderr, "utf-8"),
              stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              stdout: "",
              stdoutBytes: Buffer.byteLength(rawStdout, "utf-8"),
              stdoutSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
            ok: false,
          },
        ],
      },
    });
  });

  it("sanitizes failed bridge payload diagnostics and reports accurate final-result counts", async () => {
    const contextPath = await tempContextFile("failed bridge payload context");
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys
request = json.loads(sys.stdin.readline())
print(json.dumps({"type":"run_result","runId":request["runId"],"ok":False,"error":{"type":"runtime","code":"bridge_failed","message":"failed safely"},"modelCallFailure":{"ok":False,"requestId":"model-call-x","rawPrompt":"RAW_PROMPT_SECRET_SENTINEL","source":"MODEL_RUNNER_SOURCE_SENTINEL","error":{"type":"child_process","code":"child_exit_nonzero","message":"child failed"},"diagnostics":{"stdout":"RAW_FAILED_PAYLOAD_STDOUT","stderr":"RAW_FAILED_PAYLOAD_STDERR","stdoutBytes":999999,"stdoutSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","stderrBytes":888888,"stderrSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","signal":"RAW_SECRET_SENTINEL","exitCode":2}}}), flush=True)
`);

    const result = await executeLambdaRlmTool(
      { contextPath, question: "What happened?" },
      { bridgePath },
    );

    const serialized = JSON.stringify(result.details);
    expect(serialized).not.toContain("RAW_FAILED_PAYLOAD_STDOUT");
    expect(serialized).not.toContain("RAW_FAILED_PAYLOAD_STDERR");
    expect(serialized).not.toContain("RAW_PROMPT_SECRET_SENTINEL");
    expect(serialized).not.toContain("MODEL_RUNNER_SOURCE_SENTINEL");
    expect(serialized).not.toContain("RAW_SECRET_SENTINEL");
    expect(serialized).not.toContain("999999");
    expect(serialized).not.toContain("888888");
    expect(serialized).not.toContain(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(serialized).not.toContain(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(result.details).toMatchObject({
      ok: false,
      partialRun: {
        failedRunResult: {
          modelCallFailure: {
            diagnostics: {
              exitCode: 2,
              stderr: "",
              stderrBytes: Buffer.byteLength("RAW_FAILED_PAYLOAD_STDERR", "utf-8"),
              stderrSha256: diagnosticHash("RAW_FAILED_PAYLOAD_STDERR"),
              stdout: "",
              stdoutBytes: Buffer.byteLength("RAW_FAILED_PAYLOAD_STDOUT", "utf-8"),
              stdoutSha256: diagnosticHash("RAW_FAILED_PAYLOAD_STDOUT"),
            },
            error: { code: "child_exit_nonzero", message: "child failed", type: "child_process" },
            ok: false,
            requestId: "model-call-x",
          },
        },
        finalResults: 1,
      },
    });
    const { modelCallFailure } = (result.details.partialRun as Record<string, unknown>)
      .failedRunResult as {
      modelCallFailure: Record<string, unknown>;
    };
    expect(sortedStrings(Object.keys(modelCallFailure))).toStrictEqual([
      "diagnostics",
      "error",
      "ok",
      "requestId",
    ]);
    expect(
      sortedStrings(Object.keys(modelCallFailure.diagnostics as Record<string, unknown>)),
    ).toStrictEqual([
      "exitCode",
      "stderr",
      "stderrBytes",
      "stderrSha256",
      "stdout",
      "stdoutBytes",
      "stdoutSha256",
    ]);
  });

  it("reports the observed final-result count when a protocol error follows a final result", async () => {
    const contextPath = await tempContextFile("duplicate final result context");
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys
request = json.loads(sys.stdin.readline())
result = {"type":"run_result","runId":request["runId"],"ok":True,"content":"first answer","modelCalls":0}
print(json.dumps(result), flush=True)
print(json.dumps(result), flush=True)
`);

    const result = await executeLambdaRlmTool(
      { contextPath, question: "What happened?" },
      { bridgePath },
    );

    expect(result.details).toMatchObject({
      error: { code: "multiple_final_results", type: "protocol" },
      ok: false,
      partialRun: { finalResults: 1 },
      runStatus: "runtime_failed",
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

    const result = await executeLambdaRlmTool(
      { contextPath, question: "What happened?" },
      { bridgePath },
    );

    expect(result.details).toMatchObject({
      answer: null,
      authoritativeAnswerAvailable: false,
      error: {
        code: "missing_final_result",
        type: "protocol",
      },
      ok: false,
      partialRun: {
        executionStarted: true,
        finalResults: 0,
        partialDetailsAvailable: true,
        pythonBridge: true,
        stdoutProtocolLines: 0,
      },
      runStatus: "runtime_failed",
    });
  });

  it("returns a structured runtime failure without source contents when a large assembled request hits a bridge that exits before reading stdin", async () => {
    const secretContent = `SECRET_LARGE_STDIN_SOURCE_${"x".repeat(256 * 1024)}`;
    const firstPath = await tempContextFile(secretContent);
    const secondPath = await tempContextFile(
      "small second source keeps contextPaths assembly active",
    );
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import sys
sys.stderr.write("bridge exiting before stdin read\\n")
sys.stderr.flush()
sys.exit(0)
`);

    const result = await executeLambdaRlmTool(
      { contextPaths: [firstPath, secondPath], question: "What happened?" },
      { bridgePath },
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("lambda_rlm runtime failed");
    expect(result.details).toMatchObject({
      error: { code: "bridge_stdin_write_failed", type: "runtime" },
      ok: false,
    });
    expect(JSON.stringify(result.details)).not.toContain("SECRET_LARGE_STDIN_SOURCE_");
    expect(text).not.toContain("SECRET_LARGE_STDIN_SOURCE_");
  });

  it("uses the configured Formal Leaf model from Lambda-RLM TOML config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lambda-rlm-leaf-config-"));
    const configPath = join(cwd, ".pi", "lambda-rlm", "config.toml");
    await mkdir(join(cwd, ".pi", "lambda-rlm"), { recursive: true });
    await writeFile(configPath, '[leaf]\nmodel = "local-vllm/qwen"\n', "utf-8");
    const contextPath = join(cwd, "context.txt");
    await writeFile(contextPath, "short source", "utf-8");
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys
request = json.loads(sys.stdin.readline())
run_id = request["runId"]
print(json.dumps({"type":"model_callback_request","runId":run_id,"requestId":"model-call-1","prompt":"leaf prompt","metadata":{"phase":"test"}}), flush=True)
response = json.loads(sys.stdin.readline())
print(json.dumps({"type":"run_result","runId":run_id,"ok":True,"content":response["content"],"modelCalls":1,"metadata":{}}), flush=True)
`);
    const invocations: string[][] = [];

    const result = await executeLambdaRlmToolRaw(
      { contextPath: "context.txt", question: "Which model?" },
      {
        bridgePath,
        cwd,
        homeDir: await mkdtemp(join(tmpdir(), "lambda-rlm-isolated-home-")),
        leafProcessRunner: (invocation) => {
          invocations.push(invocation.args);
          return { exitCode: 0, stderr: "", stdout: "configured leaf answer\n" };
        },
      },
    );

    expect(result.details.ok).toBeTruthy();
    expect(firstContentText(result)).toContain("configured leaf answer");
    expect(invocations[0]).toStrictEqual(expect.arrayContaining(["--model", "local-vllm/qwen"]));
  });

  it("fails before the bridge when no Formal Leaf model is configured", async () => {
    const contextPath = await tempContextFile("short source");
    let bridgeStarted = false;

    const result = await executeLambdaRlmToolRaw(
      { contextPath, question: "What?" },
      {
        homeDir: await mkdtemp(join(tmpdir(), "lambda-rlm-isolated-home-")),
        leafProcessRunner: () => {
          bridgeStarted = true;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(bridgeStarted).toBeFalsy();
    expect(result.details).toMatchObject({
      error: { code: "missing_leaf_model", field: "leaf.model", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
    expect(firstContentText(result)).toContain("[leaf].model");
    expect(firstContentText(result)).toContain("/lambda-rlm-doctor");
  });

  it("points invalid Lambda-RLM config failures toward doctor before execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lambda-rlm-invalid-config-"));
    const configDir = join(cwd, ".pi", "lambda-rlm");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.toml"), '[leaf]\nmodel = ""\n', "utf-8");
    const contextPath = join(cwd, "context.txt");
    await writeFile(contextPath, "short source", "utf-8");

    const result = await executeLambdaRlmTool(
      { contextPath: "context.txt", question: "What?" },
      { cwd },
    );

    expect(result.details).toMatchObject({
      error: { code: "invalid_config_value", field: "leaf.model", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
    expect(firstContentText(result)).toContain("/lambda-rlm-doctor");
  });

  it("enforces resolved max input bytes from TOML config before starting the real bridge path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lambda-rlm-project-config-"));
    const configPath = join(cwd, ".pi", "lambda-rlm", "config.toml");
    await mkdir(join(cwd, ".pi", "lambda-rlm"), { recursive: true });
    await writeFile(configPath, "[run]\nmax_input_bytes = 9\n", "utf-8");
    const contextPath = join(cwd, "context.txt");
    await writeFile(contextPath, "1234567890", "utf-8");
    let bridgeStarted = false;

    const result = await executeLambdaRlmTool(
      { contextPath: "context.txt", question: "Too large?" },
      {
        cwd,
        leafProcessRunner: () => {
          bridgeStarted = true;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(bridgeStarted).toBeFalsy();
    expect(result.details).toMatchObject({
      error: { code: "max_input_bytes_exceeded", field: "contextPath", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
  });

  it("enforces resolved max input bytes before starting the real bridge path", async () => {
    const contextPath = await tempContextFile("1234567890");
    let bridgeStarted = false;

    const result = await executeLambdaRlmTool(
      { contextPath, maxInputBytes: 9, question: "Too large?" },
      {
        leafProcessRunner: () => {
          bridgeStarted = true;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(bridgeStarted).toBeFalsy();
    expect(result.details).toMatchObject({
      error: { code: "max_input_bytes_exceeded", field: "contextPath", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
  });

  it("rejects an oversized contextPath from stat before reading unreadable contents or invoking the bridge", async () => {
    const contextPath = await tempContextFile("1234567890");
    await chmod(contextPath, 0o000);
    let bridgeStarted = false;

    try {
      const result = await executeLambdaRlmTool(
        { contextPath, maxInputBytes: 9, question: "Too large?" },
        {
          leafProcessRunner: () => {
            bridgeStarted = true;
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      );

      expect(bridgeStarted).toBeFalsy();
      expect(result.details).toMatchObject({
        error: { code: "max_input_bytes_exceeded", field: "contextPath", type: "validation" },
        execution: { executionStarted: false, partialDetailsAvailable: false },
        ok: false,
        runStatus: "validation_failed",
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
      { contextPath, outputMaxBytes: 140, outputMaxLines: 3, question: "Produce long output" },
      {
        fullOutputDir,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@")
            ? await readFile(promptFile.slice(1), "utf-8")
            : "";
          return {
            exitCode: 0,
            stderr: "",
            stdout: prompt.includes("Single digit:") ? "2\n" : `${longAnswer}\n`,
          };
        },
      },
    );

    const visibleText = firstContentText(result);
    expect(visibleText).toContain("truncated");
    expect(visibleText.split("\n").length).toBeLessThanOrEqual(3);
    expect(Buffer.byteLength(visibleText, "utf-8")).toBeLessThanOrEqual(140);
    expect(result.details).toMatchObject({
      ok: true,
      output: { maxVisibleBytes: 140, maxVisibleLines: 3, truncated: true },
    });
    await expect(readFile(fullOutputPath(result), "utf-8")).resolves.toContain(longAnswer);
  });

  it("enforces per-run max model calls in the real bridge path before starting an additional leaf process", async () => {
    const contextPath = await tempContextFile("budgeted context");
    const started: string[] = [];

    const result = await executeLambdaRlmTool(
      { contextPath, maxModelCalls: 1, question: "What?" },
      {
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@")
            ? await readFile(promptFile.slice(1), "utf-8")
            : "";
          started.push(prompt);
          return {
            exitCode: 0,
            stderr: "",
            stdout: prompt.includes("Single digit:") ? "2\n" : "unexpected\n",
          };
        },
      },
    );

    expect(started).toHaveLength(1);
    expect(firstContentText(result)).toContain("No authoritative answer is available");
    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: false,
      error: { code: "max_model_calls_exceeded", type: "runtime" },
      ok: false,
      partialRun: {
        childPiLeafCalls: 1,
        modelCallResponses: [
          { ok: true, requestId: "model-call-1" },
          { ok: false, requestId: "model-call-2", error: { code: "max_model_calls_exceeded" } },
        ],
        runControls: { maxModelCalls: 1 },
      },
      runStatus: "runtime_failed",
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

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Timeout?", wholeRunTimeoutMs: 20 },
      { bridgePath },
    );

    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: false,
      error: { code: "whole_run_timeout", type: "runtime" },
      ok: false,
      partialRun: {
        executionStarted: true,
        partialDetailsAvailable: true,
        runControls: { wholeRunTimeoutMs: 20 },
        stderrDiagnosticsChars: expect.any(Number),
      },
      runStatus: "runtime_failed",
    });
  });

  it("writes a compact source-free debug artifact when debug is enabled in config", async () => {
    const root = await mkdtemp(join(tmpdir(), "lambda-rlm-config-debug-"));
    const cwd = join(root, "project");
    const home = join(root, "home");
    const debugLogDir = join(root, "configured-debug-logs");
    await mkdir(join(home, ".pi", "lambda-rlm"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(home, ".pi", "lambda-rlm", "config.toml"),
      ["[debug]", "enabled = true", `log_dir = "${debugLogDir}"`].join("\n"),
      "utf-8",
    );
    const contextPath = await tempContextFile(
      "SECRET_CONFIG_DEBUG_SOURCE_CONTENT should not appear in debug logs.",
    );
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys
request = json.loads(sys.stdin.readline())
print(json.dumps({"type":"run_progress","runId":request["runId"],"phase":"planned","plan":{"taskType":"qa","composeOp":"select_relevant","useFilter":True,"kStar":2,"tauStar":100,"depth":1,"costEstimate":123,"n":456}}), flush=True)
print(json.dumps({"type":"run_result","runId":request["runId"],"ok":True,"content":"configured debug answer","modelCalls":0}), flush=True)
`);

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Configured debug?" },
      { bridgePath, cwd, homeDir: home },
    );

    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: true,
      debugLogPath: expect.stringContaining(debugLogDir),
      ok: true,
      runStatus: "succeeded",
    });
    expect(firstContentText(result)).toContain("Debug log:");

    const { debugLogPath } = result.details;
    if (typeof debugLogPath !== "string") {
      throw new TypeError("Expected debugLogPath to be a string.");
    }
    const debugLogText = await readFile(debugLogPath, "utf-8");
    expect(debugLogText).toContain("Configured debug?".length.toString());
    expect(debugLogText).not.toContain("SECRET_CONFIG_DEBUG_SOURCE_CONTENT");
  });

  it("writes a compact source-free debug artifact when debug mode is enabled for a successful run", async () => {
    const contextPath = await tempContextFile(
      "SECRET_SUCCESS_SOURCE_CONTENT should not appear in debug logs.",
    );
    const debugLogDir = await mkdtemp(join(tmpdir(), "lambda-rlm-debug-success-"));
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys
request = json.loads(sys.stdin.readline())
print(json.dumps({"type":"run_progress","runId":request["runId"],"phase":"planned","plan":{"taskType":"qa","composeOp":"select_relevant","useFilter":True,"kStar":2,"tauStar":100,"depth":1,"costEstimate":123,"n":456}}), flush=True)
print(json.dumps({"type":"run_result","runId":request["runId"],"ok":True,"content":"debug success answer","modelCalls":0,"metadata":{"plan":{"task_type":"qa","compose_op":"select_relevant","use_filter":True,"k_star":2,"tau_star":100,"depth":1,"cost_estimate":123,"n":456}}}), flush=True)
`);

    const result = await executeLambdaRlmTool(
      { contextPath, debug: true, question: "Successful debug?" },
      { bridgePath, debugLogDir },
    );

    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: true,
      debugLogPath: expect.stringContaining(debugLogDir),
      ok: true,
      runStatus: "succeeded",
    });
    expect(JSON.stringify(result.details)).not.toContain("run_progress");
    expect(JSON.stringify(result.details)).not.toContain("model_callback_requested");
    expect(firstContentText(result)).toContain("Debug log:");

    const { debugLogPath } = result.details;
    if (typeof debugLogPath !== "string") {
      throw new TypeError("Expected debugLogPath to be a string.");
    }
    const debugLogText = await readFile(debugLogPath, "utf-8");
    const debugLog = JSON.parse(debugLogText) as Record<string, unknown>;
    expect(debugLog).toMatchObject({
      input: { sourceCount: 1, questionChars: "Successful debug?".length },
      lambdaRlm: { plan: { taskType: "qa", kStar: 2 } },
      modelCalls: { requested: 0, responses: 0 },
      schemaVersion: 1,
      status: "succeeded",
    });
    expect(debugLogText).toContain("run_progress");
    expect(debugLogText).toContain("run_result");
    expect(debugLogText).not.toContain("SECRET_SUCCESS_SOURCE_CONTENT");
  });

  it("writes a compact source-free debug artifact when debug mode is enabled for a timed-out run", async () => {
    const contextPath = await tempContextFile(
      "SECRET_DEBUG_SOURCE_CONTENT should not appear in debug logs.",
    );
    const debugLogDir = await mkdtemp(join(tmpdir(), "lambda-rlm-debug-log-"));
    const bridgePath = await tempPythonBridgeScript(`#!/usr/bin/env python3
import json, sys, time
request = json.loads(sys.stdin.readline())
print(json.dumps({"type":"run_progress","runId":request["runId"],"phase":"planned","plan":{"taskType":"qa","composeOp":"select_relevant","useFilter":True,"kStar":2,"tauStar":100,"depth":1,"costEstimate":123,"n":456}}), flush=True)
print(json.dumps({"type":"model_callback_request","runId":request["runId"],"requestId":"model-call-1","prompt":"SECRET_DEBUG_PROMPT_BODY","metadata":{"phase":"execute_phi","combinator":"leaf","promptChars":24}}), flush=True)
time.sleep(30)
`);

    const result = await executeLambdaRlmTool(
      { contextPath, debug: true, question: "Timeout?", wholeRunTimeoutMs: 30 },
      {
        bridgePath,
        debugLogDir,
        leafProcessRunner: (invocation) =>
          resolveOnAbort(invocation.signal, {
            exitCode: null,
            signal: "SIGTERM",
            stderr: "SECRET_CHILD_STDERR",
            stdout: "SECRET_CHILD_STDOUT",
          }),
      },
    );

    expect(result.details).toMatchObject({
      debugLogPath: expect.stringContaining(debugLogDir),
      error: { code: "whole_run_timeout" },
      ok: false,
      runStatus: "runtime_failed",
    });
    expect(JSON.stringify(result.details)).not.toContain("run_progress");
    expect(JSON.stringify(result.details)).not.toContain("model_callback_requested");
    expect(firstContentText(result)).toContain("Debug log:");

    const { debugLogPath } = result.details;
    if (typeof debugLogPath !== "string") {
      throw new TypeError("Expected debugLogPath to be a string.");
    }
    const debugLogText = await readFile(debugLogPath, "utf-8");
    const debugLog = JSON.parse(debugLogText) as Record<string, unknown>;
    expect(debugLog).toMatchObject({
      error: { code: "whole_run_timeout" },
      input: { sourceCount: 1, questionChars: "Timeout?".length },
      lambdaRlm: { plan: { taskType: "qa", kStar: 2 } },
      runId: expect.stringMatching(/^lambda-rlm-/),
      schemaVersion: 1,
      status: "runtime_failed",
    });
    expect(debugLogText).toContain("model_callback_requested");
    expect(debugLogText).toContain("whole_run_timeout");
    expect(debugLogText).not.toContain("SECRET_DEBUG_SOURCE_CONTENT");
    expect(debugLogText).not.toContain("SECRET_DEBUG_PROMPT_BODY");
    expect(debugLogText).not.toContain("SECRET_CHILD_STDOUT");
    expect(debugLogText).not.toContain("SECRET_CHILD_STDERR");
  });

  it("passes configured per-model-call timeout into the leaf runner and reports cleanup as a runtime failure", async () => {
    const contextPath = await tempContextFile("per call timeout context");
    let observedAbort = false;

    const result = await executeLambdaRlmTool(
      { contextPath, modelCallTimeoutMs: 10, question: "Timeout leaf?" },
      {
        leafProcessRunner: async (invocation) => {
          const processResult = await resolveOnAbort(invocation.signal, {
            exitCode: null,
            signal: "SIGTERM",
            stderr: "leaf timeout",
            stdout: "partial",
          });
          observedAbort = true;
          return processResult;
        },
      },
    );

    expect(observedAbort).toBeTruthy();
    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: false,
      error: { code: "model_callback_failed" },
      ok: false,
      partialRun: {
        modelCallResponses: [
          {
            ok: false,
            error: { code: "per_model_call_timeout" },
            diagnostics: { signal: "SIGTERM" },
          },
        ],
        runControls: { modelCallTimeoutMs: 10 },
      },
    });
  });

  it("accepts contextPaths, assembles ordered source manifest and source-delimited context for one consolidated bridge run without returning source contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-multi-"));
    const firstPath = join(dir, "b.txt");
    const secondPath = join(dir, "a.txt");
    await writeFile(firstPath, "FIRST_SECRET_CONTENT\nfirst fact", "utf-8");
    await writeFile(secondPath, "SECOND_SECRET_CONTENT\nsecond fact", "utf-8");
    const prompts: string[] = [];

    const result = await executeLambdaRlmTool(
      { contextPaths: [firstPath, secondPath], question: "What facts are present?" },
      {
        contextWindowChars: 1000,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@")
            ? await readFile(promptFile.slice(1), "utf-8")
            : "";
          prompts.push(prompt);
          return {
            exitCode: 0,
            stderr: "",
            stdout: prompt.includes("Single digit:") ? "2\n" : "Both facts are present.\n",
          };
        },
      },
    );

    expect(result.details).toMatchObject({
      bridgeRun: { childPiLeafCalls: prompts.length },
      input: {
        source: "files",
        sourceCount: 2,
        sources: [
          {
            sourceNumber: 1,
            path: firstPath,
            bytes: Buffer.byteLength("FIRST_SECRET_CONTENT\nfirst fact", "utf-8"),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          {
            sourceNumber: 2,
            path: secondPath,
            bytes: Buffer.byteLength("SECOND_SECRET_CONTENT\nsecond fact", "utf-8"),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
        totalBytes: Buffer.byteLength(
          "FIRST_SECRET_CONTENT\nfirst factSECOND_SECRET_CONTENT\nsecond fact",
          "utf-8",
        ),
      },
      ok: true,
    });
    const leafPrompt = prompts.find((prompt) =>
      prompt.includes("Using the following context, answer"),
    );
    expect(leafPrompt).toContain(`Sources:\n[1] ${firstPath} (`);
    expect(leafPrompt).toContain(`[2] ${secondPath} (`);
    expect(leafPrompt).toContain(`--- BEGIN SOURCE 1: ${firstPath} ---`);
    expect(leafPrompt).toContain("FIRST_SECRET_CONTENT");
    expect(leafPrompt).toContain(`--- BEGIN SOURCE 2: ${secondPath} ---`);
    expect(leafPrompt).toContain("SECOND_SECRET_CONTENT");
    expect(JSON.stringify(result.details)).not.toContain("FIRST_SECRET_CONTENT");
    expect(JSON.stringify(result.details)).not.toContain("SECOND_SECRET_CONTENT");
    const visibleText = firstContentText(result);
    expect(visibleText).not.toContain("FIRST_SECRET_CONTENT");
    expect(visibleText).not.toContain("SECOND_SECRET_CONTENT");
  });

  it("rejects requests that mix contextPath and contextPaths before execution", async () => {
    const result = await executeLambdaRlmTool({
      contextPath: "one.txt",
      contextPaths: ["two.txt"],
      question: "What?",
    });

    expect(result.details).toMatchObject({
      error: { code: "mixed_context_path_fields", field: "contextPaths", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
  });

  it("fails before execution when one contextPaths entry is missing", async () => {
    const existing = await tempContextFile("exists");

    const result = await executeLambdaRlmTool({
      contextPaths: [existing, "/definitely/missing/multi.txt"],
      question: "What?",
    });

    expect(result.details).toMatchObject({
      error: { code: "missing_context_path_file", field: "contextPaths", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
    expect(result.details).not.toHaveProperty("partialRun");
  });

  it("fails before execution when one contextPaths entry is unreadable", async () => {
    const existing = await tempContextFile("exists");
    const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-multi-unreadable-"));

    const result = await executeLambdaRlmTool({ contextPaths: [existing, dir], question: "What?" });

    expect(result.details).toMatchObject({
      error: { code: "unreadable_context_path", field: "contextPaths", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
  });

  it("enforces max input bytes across all contextPaths before invoking the bridge", async () => {
    const first = await tempContextFile("12345");
    const second = await tempContextFile("67890");
    let bridgeStarted = false;

    const result = await executeLambdaRlmTool(
      { contextPaths: [first, second], maxInputBytes: 9, question: "Too large?" },
      {
        leafProcessRunner: () => {
          bridgeStarted = true;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(bridgeStarted).toBeFalsy();
    expect(result.details).toMatchObject({
      error: { code: "max_input_bytes_exceeded", field: "contextPaths", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
  });

  it("uses one consolidated bridge request for multiple contextPaths", async () => {
    const bridgePath = await tempPythonBridgeScript(
      `#!/usr/bin/env python3\nimport json, sys\nrequest = json.loads(sys.stdin.readline())\ncontext = request["input"].get("context", "")\nassert "--- BEGIN SOURCE 1:" in context and "--- BEGIN SOURCE 2:" in context\nassert request["input"]["question"] == "Consolidated?"\nprint(json.dumps({"type":"model_callback_request","runId":request["runId"],"requestId":"model-call-1","prompt":context,"metadata":{"phase":"leaf"}}), flush=True)\nresponse = json.loads(sys.stdin.readline())\nprint(json.dumps({"type":"run_result","runId":request["runId"],"ok":True,"content":"consolidated answer","modelCalls":1}), flush=True)\n`,
    );
    const first = await tempContextFile("alpha");
    const second = await tempContextFile("beta");
    let leafCalls = 0;

    const result = await executeLambdaRlmTool(
      { contextPaths: [first, second], question: "Consolidated?" },
      {
        bridgePath,
        leafProcessRunner: () => {
          leafCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "ok\n" };
        },
      },
    );

    expect(leafCalls).toBe(1);
    expect(result.details).toMatchObject({
      bridgeRun: { childPiLeafCalls: 1, finalResults: 1 },
      ok: true,
    });
  });

  it("returns structured cancellation failure and aborts the active leaf through the tool boundary", async () => {
    const contextPath = await tempContextFile("cancel context");
    const controller = new AbortController();
    let observedAbort = false;
    const promise = executeLambdaRlmTool(
      { contextPath, question: "Cancel?" },
      {
        leafProcessRunner: async (invocation) => {
          const result = resolveOnAbort(invocation.signal, {
            exitCode: null,
            signal: "SIGTERM",
            stderr: "cancelled",
            stdout: "",
          });
          setTimeout(() => controller.abort(), 0);
          const processResult = await result;
          observedAbort = true;
          return processResult;
        },
        signal: controller.signal,
      },
    );

    const result = await promise;

    expect(observedAbort).toBeTruthy();
    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: false,
      error: { code: "run_cancelled" },
      ok: false,
      partialRun: { executionStarted: true, partialDetailsAvailable: true },
      runStatus: "runtime_failed",
    });
  });

  it("rejects per-run loosening with a structured pre-execution validation failure", async () => {
    const contextPath = await tempContextFile("short source");

    const result = await executeLambdaRlmTool({
      contextPath,
      maxInputBytes: 999_999_999,
      question: "Loosen?",
    });

    expect(result.details).toMatchObject({
      error: { code: "per_run_limit_loosened", field: "maxInputBytes", type: "validation" },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    });
  });

  it("truncates long visible output deterministically, preserves the compact run summary, and writes recoverable full output when configured", async () => {
    const contextPath = await tempContextFile("short source");
    const fullOutputDir = await mkdtemp(join(tmpdir(), "lambda-rlm-full-output-"));
    const longAnswer = `ANSWER-${"x".repeat(500)}`;

    const result = await executeLambdaRlmTool(
      { contextPath, question: "Produce long output" },
      {
        fullOutputDir,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@")
            ? await readFile(promptFile.slice(1), "utf-8")
            : "";
          return {
            exitCode: 0,
            stdout: prompt.includes("Single digit:") ? "2\n" : `${longAnswer}\n`,
            stderr: "",
          };
        },
        outputMaxVisibleChars: 180,
      },
    );

    const visibleText = firstContentText(result);
    expect(visibleText.length).toBeLessThanOrEqual(180);
    expect(visibleText).toContain("truncated");
    expect(visibleText).toContain("Run summary: Real Lambda-RLM completed");
    expect(visibleText).toContain("Model calls:");
    expect(result.details).toMatchObject({
      ok: true,
      output: { maxVisibleChars: 180, truncated: true },
    });
    const outputPath = fullOutputPath(result);
    expect(outputPath).toStrictEqual(expect.stringContaining(fullOutputDir));
    await expect(readFile(outputPath, "utf-8")).resolves.toContain(longAnswer);
  });
});
