import { describe, expect, it } from "vitest";
import registerLambdaRlmExtension from "../src/extension.js";
import registerLambdaRlmEntrypoint from "../.pi/extensions/lambda-rlm/index.js";

function registeredLambdaRlmTool(register: typeof registerLambdaRlmExtension = registerLambdaRlmExtension) {
  const tools: any[] = [];
  register({ registerTool: (tool: any) => tools.push(tool) } as any);
  return tools.find((candidate) => candidate.name === "lambda_rlm");
}

describe("lambda_rlm Pi extension registration", () => {
  it("registers a lambda_rlm tool with a strict path-based schema and optional per-run tightening", () => {
    const tool = registeredLambdaRlmTool();

    expect(tool).toBeTruthy();
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        contextPath: { type: "string" },
        contextPaths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        question: { type: "string" },
        maxInputBytes: { type: "number", minimum: 1 },
        outputMaxBytes: { type: "number", minimum: 1 },
        outputMaxLines: { type: "number", minimum: 1 },
        maxModelCalls: { type: "number", minimum: 1 },
        wholeRunTimeoutMs: { type: "number", minimum: 1 },
        modelCallTimeoutMs: { type: "number", minimum: 1 },
      },
    });
    expect(JSON.stringify(tool.parameters)).toContain("exactly one of contextPath or contextPaths");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual([
      "contextPath",
      "contextPaths",
      "maxInputBytes",
      "maxModelCalls",
      "modelCallTimeoutMs",
      "outputMaxBytes",
      "outputMaxLines",
      "question",
      "wholeRunTimeoutMs",
    ]);
  });

  it("describes the public tool as the real path-based Lambda-RLM integration", async () => {
    const tool = registeredLambdaRlmTool();
    const updates: any[] = [];

    await tool.execute(
      "metadata-check",
      { contextPath: "/definitely/missing/context.txt", question: "What?" },
      undefined,
      (update: any) => updates.push(update),
      { cwd: process.cwd() },
    );

    const publicMetadataText = JSON.stringify({
      description: tool.description,
      promptGuidelines: tool.promptGuidelines,
      onUpdate: updates.flatMap((update) => update.content.map((content: any) => content.text)),
    });

    expect(publicMetadataText).not.toMatch(/synthetic|fake|tracer|does not run real Lambda-RLM yet/i);
    expect(publicMetadataText).toMatch(/real Lambda-RLM/i);
    expect(publicMetadataText).toMatch(/Formal Leaf/i);
    expect(publicMetadataText).toMatch(/path-based|contextPath/i);
    expect(publicMetadataText).toMatch(/maxModelCalls|wholeRunTimeoutMs|modelCallTimeoutMs/i);
    expect(publicMetadataText).toMatch(/per-run tightening/i);
  });

  it("executes through the registered public tool path", async () => {
    const tool = registeredLambdaRlmTool();

    const result = await tool.execute("call-1", { contextPath: "CONTEXT.md", question: "What is this project about?" }, undefined, undefined, {
      cwd: process.cwd(),
      leafProcessRunner: async (invocation: any) => {
        const promptFile = invocation.args.at(-1);
        const prompt = promptFile?.startsWith("@") ? await import("node:fs/promises").then((fs) => fs.readFile(promptFile.slice(1), "utf8")) : "";
        return { exitCode: 0, stdout: prompt.includes("Single digit:") ? "2\n" : "synthetic model answer\n", stderr: "" };
      },
    });

    expect(result.content[0].text).toContain("Real Lambda-RLM completed");
    expect(result.content[0].text).toContain("synthetic model answer");
    expect(result.details.ok).toBe(true);
    expect(JSON.stringify(result.details)).not.toContain("Path-Based Context Ingestion");
  });

  it("passes public per-run model-call budget controls through the registered execute path", async () => {
    const tool = registeredLambdaRlmTool();
    const started: string[] = [];

    const result = await tool.execute(
      "call-budgeted",
      { contextPath: "CONTEXT.md", question: "What is this project about?", maxModelCalls: 1 },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        leafProcessRunner: async (invocation: any) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@") ? await import("node:fs/promises").then((fs) => fs.readFile(promptFile.slice(1), "utf8")) : "";
          started.push(prompt);
          return { exitCode: 0, stdout: prompt.includes("Single digit:") ? "2\n" : "unexpected\n", stderr: "" };
        },
      },
    );

    expect(started).toHaveLength(1);
    expect(result.content[0].text).toContain("No authoritative answer is available");
    expect(result.details).toMatchObject({
      ok: false,
      runStatus: "runtime_failed",
      authoritativeAnswerAvailable: false,
      error: { type: "runtime", code: "max_model_calls_exceeded" },
      partialRun: { childPiLeafCalls: 1, runControls: { maxModelCalls: 1 } },
    });
  });

  it("returns structured validation details from the registered execute path for a missing context file", async () => {
    const tool = registeredLambdaRlmTool();

    const result = await tool.execute(
      "call-missing",
      { contextPath: "/definitely/missing/context.txt", question: "What?" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    expect(result.content[0].text).toContain("lambda_rlm validation failed before execution");
    expect(result.details).toMatchObject({
      ok: false,
      error: {
        type: "validation",
        code: "missing_context_path_file",
        field: "contextPath",
        message: expect.stringContaining("Unable to read contextPath before execution"),
      },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    });
  });

  it("loads the Pi extension entrypoint and registers the lambda_rlm tool", () => {
    const tool = registeredLambdaRlmTool(registerLambdaRlmEntrypoint);

    expect(tool).toBeTruthy();
    expect(tool.name).toBe("lambda_rlm");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual([
      "contextPath",
      "contextPaths",
      "maxInputBytes",
      "maxModelCalls",
      "modelCallTimeoutMs",
      "outputMaxBytes",
      "outputMaxLines",
      "question",
      "wholeRunTimeoutMs",
    ]);
  });
});
