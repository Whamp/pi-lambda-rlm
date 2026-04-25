import { describe, expect, it } from "vitest";
import registerLambdaRlmExtension from "../src/extension.js";
import registerLambdaRlmEntrypoint from "../.pi/extensions/lambda-rlm/index.js";

function registeredLambdaRlmTool(register: typeof registerLambdaRlmExtension = registerLambdaRlmExtension) {
  const tools: any[] = [];
  register({ registerTool: (tool: any) => tools.push(tool) } as any);
  return tools.find((candidate) => candidate.name === "lambda_rlm");
}

describe("lambda_rlm Pi extension registration", () => {
  it("registers a lambda_rlm tool with a strict contextPath + question schema", () => {
    const tool = registeredLambdaRlmTool();

    expect(tool).toBeTruthy();
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["contextPath", "question"],
      properties: {
        contextPath: { type: "string" },
        question: { type: "string" },
      },
    });
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["contextPath", "question"]);
  });

  it("executes through the registered public tool path", async () => {
    const tool = registeredLambdaRlmTool();

    const result = await tool.execute("call-1", { contextPath: "CONTEXT.md", question: "What is this project about?" }, undefined, undefined, {
      cwd: process.cwd(),
    });

    expect(result.content[0].text).toContain("Synthetic λ-RLM bridge answer");
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
      fakeRun: { executionStarted: false },
    });
  });

  it("loads the Pi extension entrypoint and registers the lambda_rlm tool", () => {
    const tool = registeredLambdaRlmTool(registerLambdaRlmEntrypoint);

    expect(tool).toBeTruthy();
    expect(tool.name).toBe("lambda_rlm");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["contextPath", "question"]);
  });
});
