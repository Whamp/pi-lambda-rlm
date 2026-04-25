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

describe("synthetic bridge lambda_rlm tool execution", () => {
  it("reads contextPath internally, services the synthetic bridge callback through a constrained leaf runner, and returns a bounded result without dumping source content", async () => {
    const secretContent = "SECRET_SOURCE_CONTENT_SHOULD_NOT_BE_RETURNED\n".repeat(20);
    const contextPath = await tempContextFile(secretContent);
    const processCalls: Array<{ args: string[]; prompt: string }> = [];

    const result = await executeLambdaRlmTool(
      { contextPath, question: "What is this file about?" },
      {
        leafModel: "google/gemini-test",
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          processCalls.push({
            args: invocation.args,
            prompt: promptFile?.startsWith("@") ? await readFile(promptFile.slice(1), "utf8") : "",
          });
          return { exitCode: 0, stdout: "synthetic model answer\n", stderr: "" };
        },
      },
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Synthetic λ-RLM bridge answer");
    expect(text).toContain("synthetic model answer");
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).not.toContain("SECRET_SOURCE_CONTENT_SHOULD_NOT_BE_RETURNED");
    expect(JSON.stringify(result.details)).not.toContain("SECRET_SOURCE_CONTENT_SHOULD_NOT_BE_RETURNED");
    expect(result.details).toMatchObject({
      ok: true,
      input: {
        source: "file",
        contextPath,
        contextChars: secretContent.length,
        questionChars: "What is this file about?".length,
      },
      bridgeRun: {
        executionStarted: true,
        pythonBridge: true,
        protocol: "strict-stdout-stdin-ndjson",
        stdoutProtocolLines: 2,
        finalResults: 1,
        realLambdaRlm: false,
        childPiLeafCalls: 1,
        leafProfile: "formal_pi_print",
        leafModel: "google/gemini-test",
      },
      fakeRun: {
        engine: "synthetic-python-ndjson-bridge",
        executionStarted: true,
        childPiLeafCalls: 1,
      },
      output: {
        bounded: true,
        truncated: false,
      },
    });
    expect(processCalls).toHaveLength(1);
    expect(processCalls[0]?.prompt).toContain("What is this file about?");
    expect(processCalls[0]?.args).toEqual(
      expect.arrayContaining(["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
    );
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
