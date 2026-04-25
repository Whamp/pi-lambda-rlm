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
      required: ["contextPath", "question"],
      properties: {
        contextPath: { type: "string" },
        question: { type: "string" },
        maxInputBytes: { type: "number" },
        outputMaxBytes: { type: "number" },
        outputMaxLines: { type: "number" },
      },
    });
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["contextPath", "maxInputBytes", "outputMaxBytes", "outputMaxLines", "question"]);
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
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["contextPath", "maxInputBytes", "outputMaxBytes", "outputMaxLines", "question"]);
  });
});
