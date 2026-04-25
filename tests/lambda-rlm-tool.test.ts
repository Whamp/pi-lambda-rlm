import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLambdaRlmTool, LambdaRlmValidationError } from "../src/lambdaRlmTool.js";

async function tempContextFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-test-"));
  const path = join(dir, "context.txt");
  await writeFile(path, content, "utf8");
  return path;
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
      input: {
        source: "file",
        contextPath,
        contextChars: secretContent.length,
        questionChars: "Who wrote notes about the Analytical Engine?".length,
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
    expect(processCalls.length).toBeGreaterThan(1);
    expect(processCalls.some((call) => call.prompt.includes("Single digit:"))).toBe(true);
    expect(processCalls.some((call) => call.prompt.includes("Using the following context, answer"))).toBe(true);
    expect(processCalls[0]?.args).toEqual(
      expect.arrayContaining(["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
    );
  });

  it("returns a structured runtime failure with child process diagnostics when the constrained leaf process exits non-zero", async () => {
    const contextPath = await tempContextFile("context that is read internally");

    await expect(
      executeLambdaRlmTool(
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
      ),
    ).rejects.toMatchObject({
      details: {
        ok: false,
        error: {
          type: "runtime",
          code: "model_callback_failed",
          message: expect.stringContaining("Child pi leaf process exited with code 7"),
        },
        bridgeRun: {
          executionStarted: true,
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
    [{ contextPath: "file.txt", question: "What?", contextPaths: ["a", "b"] }, "unsupported_input"],
    [{ contextPath: "file.txt", question: "What?", path: "other.txt" }, "unsupported_input"],
    [{ contextPath: "file.txt", question: "What?", extra: true }, "unknown_keys"],
  ])("rejects invalid public input shape %#", async (params, code) => {
    await expect(executeLambdaRlmTool(params)).rejects.toMatchObject({
      name: "LambdaRlmValidationError",
      details: {
        ok: false,
        error: { type: "validation", code },
        fakeRun: { executionStarted: false },
      },
    });
  });

  it("fails before execution with structured validation details when the context file is missing", async () => {
    await expect(executeLambdaRlmTool({ contextPath: "/definitely/missing/context.txt", question: "What?" })).rejects.toMatchObject({
      details: {
        ok: false,
        error: { type: "validation", code: "missing_context_path_file", field: "contextPath" },
        fakeRun: { executionStarted: false },
      },
    });
  });

  it("fails before execution with structured validation details when contextPath is not a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-dir-"));
    const childDir = join(dir, "not-a-file");
    await mkdir(childDir);

    await expect(executeLambdaRlmTool({ contextPath: childDir, question: "What?" })).rejects.toMatchObject({
      details: {
        ok: false,
        error: { type: "validation", code: "unreadable_context_path", field: "contextPath" },
        fakeRun: { executionStarted: false },
      },
    });
  });
});
