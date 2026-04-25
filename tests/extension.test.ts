import { describe, expect, it } from "vitest";
import registerLambdaRlmExtension from "../src/extension.js";

describe("lambda_rlm Pi extension registration", () => {
  it("registers a lambda_rlm tool with a strict contextPath + question schema", () => {
    const tools: any[] = [];
    registerLambdaRlmExtension({ registerTool: (tool: any) => tools.push(tool) } as any);

    const tool = tools.find((candidate) => candidate.name === "lambda_rlm");
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
    const tools: any[] = [];
    registerLambdaRlmExtension({ registerTool: (tool: any) => tools.push(tool) } as any);
    const tool = tools.find((candidate) => candidate.name === "lambda_rlm");

    const result = await tool.execute("call-1", { contextPath: "CONTEXT.md", question: "What is this project about?" }, undefined, undefined, {
      cwd: process.cwd(),
    });

    expect(result.content[0].text).toContain("Fake λ-RLM answer");
    expect(result.details.ok).toBe(true);
    expect(JSON.stringify(result.details)).not.toContain("Path-Based Context Ingestion");
  });
});
