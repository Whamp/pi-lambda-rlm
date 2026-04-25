import { describe, expect, it } from "vitest";
import registerLambdaRlmExtension from "../src/extension.js";
import registerLambdaRlmEntrypoint from "../.pi/extensions/lambda-rlm/index.js";

type RegisteredTool = {
  name: string;
  parameters: any;
  description: string;
  promptGuidelines?: string[];
  execute: (...args: any[]) => Promise<any>;
};

const FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS = ["oneOf", "anyOf", "allOf", "enum", "not"] as const;
const FORBIDDEN_SCHEMA_COMBINATORS = ["oneOf", "anyOf", "allOf", "not"] as const;

function registeredTools(register: typeof registerLambdaRlmExtension = registerLambdaRlmExtension) {
  const tools: RegisteredTool[] = [];
  register({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as any);
  return tools;
}

function registeredLambdaRlmTool(register: typeof registerLambdaRlmExtension = registerLambdaRlmExtension) {
  const tool = registeredTools(register).find((candidate) => candidate.name === "lambda_rlm");
  if (!tool) throw new Error("lambda_rlm tool was not registered");
  return tool;
}

function findForbiddenSchemaCombinators(schema: unknown, path = "$." ): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) return schema.flatMap((item, index) => findForbiddenSchemaCombinators(item, `${path}[${index}].`));

  const record = schema as Record<string, unknown>;
  const problems: string[] = [];
  for (const keyword of FORBIDDEN_SCHEMA_COMBINATORS) {
    if (keyword in record) problems.push(`${path}${keyword}`);
  }
  for (const [key, value] of Object.entries(record)) {
    problems.push(...findForbiddenSchemaCombinators(value, `${path}${key}.`));
  }
  return problems;
}

function schemaCompatibilityProblems(tool: RegisteredTool): string[] {
  const schema = tool.parameters;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${tool.name}: parameters schema must be an object`];
  }

  const record = schema as Record<string, unknown>;
  const problems: string[] = [];
  if (record.type !== "object") {
    problems.push(`${tool.name}: top-level schema type must be "object"; got ${JSON.stringify(record.type)}`);
  }
  for (const keyword of FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS) {
    if (keyword in record) problems.push(`${tool.name}: top-level schema must not contain ${keyword}`);
  }
  const combinators = findForbiddenSchemaCombinators(record);
  if (combinators.length > 0) {
    problems.push(`${tool.name}: schema must not contain JSON Schema combinators (${combinators.join(", ")})`);
  }
  return problems;
}

function registeredLambdaRlmCommand(register: typeof registerLambdaRlmExtension = registerLambdaRlmExtension) {
  const commands: any[] = [];
  register({ registerTool: () => undefined, registerCommand: (name: string, options: any) => commands.push({ name, options }) } as any);
  return commands.find((candidate) => candidate.name === "lambda-rlm-doctor");
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

  it("registers only provider-compatible tool schemas", () => {
    const registrations = [
      { source: "src/extension.ts", tools: registeredTools(registerLambdaRlmExtension) },
      { source: ".pi/extensions/lambda-rlm/index.ts", tools: registeredTools(registerLambdaRlmEntrypoint) },
    ];

    const incompatibleSchemas = registrations.flatMap((registration) =>
      registration.tools
        .map((tool) => ({ source: registration.source, name: tool.name, problems: schemaCompatibilityProblems(tool) }))
        .filter((tool) => tool.problems.length > 0),
    );

    expect(incompatibleSchemas).toEqual([]);
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

  it("registers a non-mutating doctor command with Pi's two-argument command API", () => {
    const command = registeredLambdaRlmCommand();

    expect(command).toBeTruthy();
    expect(command.name).toBe("lambda-rlm-doctor");
    expect(command.name).not.toMatch(/^\//);
    expect(command.options.description).toMatch(/non-mutating/i);
    expect(command.options.description).toMatch(/Python|config|prompts|mock bridge/i);
    expect(command.options.handler).toEqual(expect.any(Function));
  });

  it("surfaces the doctor report through the command handler and notifies when Pi UI is available", async () => {
    const command = registeredLambdaRlmCommand();
    const notifications: string[] = [];

    const result = await command.options.handler({ cwd: process.cwd(), ui: { notify: (message: string) => notifications.push(message) } });

    expect(result.content[0].text).toMatch(/lambda_rlm doctor (passed|found errors)/);
    expect(result.details.checks.map((check: any) => check.name)).toContain("mock_bridge");
    expect(notifications).toEqual([result.content[0].text]);
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
