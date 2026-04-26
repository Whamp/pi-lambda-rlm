import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import registerLambdaRlmExtension from "../src/extension.js";
import registerLambdaRlmEntrypoint from "../.pi/extensions/lambda-rlm/index.js";
import type { ProcessInvocation, ProcessResult } from "../src/leaf-runner.js";

interface ToolContent {
  text: string;
  type?: string;
}

interface ToolUpdate {
  content: ToolContent[];
}

interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}

interface ToolParameters extends Record<string, unknown> {
  properties: Record<string, unknown>;
}

interface RegisteredTool {
  description: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
    ctx?: {
      cwd: string;
      leafProcessRunner?: (invocation: ProcessInvocation) => ProcessResult | Promise<ProcessResult>;
    },
  ) => Promise<ToolResult>;
  name: string;
  parameters: ToolParameters;
  promptGuidelines?: string[];
}

interface RegisteredCommand {
  name: string;
  options: {
    description: string;
    handler: (context: {
      cwd: string;
      leafProcessRunner?: (invocation: ProcessInvocation) => ProcessResult | Promise<ProcessResult>;
      ui?: {
        notify?: (message: string) => void | Promise<void>;
        promptText?: (prompt: string) => string | Promise<string>;
        select?: (
          prompt: string,
          choices: { id: string }[],
          defaultChoiceId?: string,
        ) => string | Promise<string>;
      };
    }) => Promise<ToolResult>;
  };
}

interface RegistrationOptions {
  notify?: (message: string) => void | Promise<void>;
  workspacePath?: string;
}

const FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS = ["oneOf", "anyOf", "allOf", "enum", "not"] as const;
const FORBIDDEN_SCHEMA_COMBINATORS = ["oneOf", "anyOf", "allOf", "not"] as const;

function sortedStrings(values: Iterable<string>) {
  const sorted = [...values];
  // ES2022 target: Array#toSorted is unavailable in this project.
  // oxlint-disable-next-line unicorn/no-array-sort
  return sorted.sort();
}

async function tempConfiguredProject(context = "This project is about Lambda-RLM.") {
  const cwd = await mkdtemp(join(tmpdir(), "lambda-rlm-extension-project-"));
  await mkdir(join(cwd, ".pi", "lambda-rlm"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "lambda-rlm", "config.toml"),
    '[leaf]\nmodel = "google/gemini-test"\n',
    "utf-8",
  );
  await writeFile(join(cwd, "CONTEXT.md"), context, "utf-8");
  return cwd;
}

function firstContentText(result: ToolResult) {
  const [content] = result.content;
  if (!content) {
    throw new Error("Expected tool result to include text content.");
  }
  return content.text;
}

const okDoctorRunner = (invocation: ProcessInvocation): ProcessResult => {
  if (invocation.args.includes("--version")) {
    return { exitCode: 0, stderr: "", stdout: `${invocation.command} test version` };
  }
  return {
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      missing: [],
      ok: true,
      seams: ["LambdaRLM.client", "LambdaPromptRegistry", "completion_with_metadata path"],
    }),
  };
};

function registeredTools(
  register: typeof registerLambdaRlmExtension = registerLambdaRlmExtension,
  options: RegistrationOptions = {},
) {
  const tools: RegisteredTool[] = [];
  register({
    ...(options.notify ? { ui: { notify: options.notify } } : {}),
    ...(options.workspacePath ? { lambdaRlmWorkspacePath: options.workspacePath } : {}),
    registerTool: (tool: Record<string, unknown>) => tools.push(tool as unknown as RegisteredTool),
  });
  return tools;
}

function registeredLambdaRlmTool(
  register: typeof registerLambdaRlmExtension = registerLambdaRlmExtension,
) {
  const tool = registeredTools(register).find((candidate) => candidate.name === "lambda_rlm");
  if (!tool) {
    throw new Error("lambda_rlm tool was not registered");
  }
  return tool;
}

function findForbiddenSchemaCombinators(schema: unknown, path = "$."): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findForbiddenSchemaCombinators(item, `${path}[${index}].`),
    );
  }

  const record = schema as Record<string, unknown>;
  const problems: string[] = [];
  for (const keyword of FORBIDDEN_SCHEMA_COMBINATORS) {
    if (keyword in record) {
      problems.push(`${path}${keyword}`);
    }
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
    problems.push(
      `${tool.name}: top-level schema type must be "object"; got ${JSON.stringify(record.type)}`,
    );
  }
  for (const keyword of FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS) {
    if (keyword in record) {
      problems.push(`${tool.name}: top-level schema must not contain ${keyword}`);
    }
  }
  const combinators = findForbiddenSchemaCombinators(record);
  if (combinators.length > 0) {
    problems.push(
      `${tool.name}: schema must not contain JSON Schema combinators (${combinators.join(", ")})`,
    );
  }
  return problems;
}

function registeredLambdaRlmCommand(
  register: typeof registerLambdaRlmExtension = registerLambdaRlmExtension,
  options: RegistrationOptions = {},
) {
  const commands: RegisteredCommand[] = [];
  register({
    ...(options.notify ? { ui: { notify: options.notify } } : {}),
    ...(options.workspacePath ? { lambdaRlmWorkspacePath: options.workspacePath } : {}),
    registerCommand: (name, commandOptions) =>
      commands.push({ name, options: commandOptions as unknown as RegisteredCommand["options"] }),
    registerTool: () => {
      // Command-only registration test.
    },
  });
  const command = commands.find((candidate) => candidate.name === "lambda-rlm-doctor");
  if (!command) {
    throw new Error("lambda-rlm-doctor command was not registered");
  }
  return command;
}
describe("lambda_rlm Pi extension registration", () => {
  it("scaffolds the Lambda-RLM User Workspace on extension load and emits Scaffold Notification only on first creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lambda-rlm-extension-workspace-"));
    const workspacePath = join(root, ".pi", "lambda-rlm");
    const notifications: string[] = [];

    registeredTools(registerLambdaRlmExtension, {
      workspacePath,
      notify: (message) => {
        notifications.push(message);
      },
    });
    await Promise.resolve();

    await expect(readFile(join(workspacePath, "config.toml"), "utf-8")).resolves.toContain(
      "# model =",
    );
    await expect(readFile(join(workspacePath, "README.md"), "utf-8")).resolves.toContain(
      "Lambda-RLM User Workspace",
    );
    await expect(
      readFile(join(workspacePath, "examples", "single-file-qa", "context.md"), "utf-8"),
    ).resolves.toContain("context budget");
    expect(notifications).toStrictEqual([expect.stringContaining("Lambda-RLM User Workspace")]);

    registeredTools(registerLambdaRlmExtension, {
      workspacePath,
      notify: (message) => {
        notifications.push(message);
      },
    });
    await Promise.resolve();

    expect(notifications).toHaveLength(1);
  });

  it("describes the doctor command as non-destructive workspace-ensuring diagnostics", () => {
    const command = registeredLambdaRlmCommand(registerLambdaRlmExtension);

    expect(command.options.description).toMatch(/non-destructive/i);
    expect(command.options.description).toMatch(/workspace-ensuring/i);
    expect(command.options.description).not.toMatch(/non-mutating/i);
  });

  it("registers a lambda_rlm tool with a strict path-based schema and optional per-run tightening", () => {
    const tool = registeredLambdaRlmTool();

    expect(tool).toBeTruthy();
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        contextPath: { type: "string" },
        contextPaths: { items: { minLength: 1, type: "string" }, minItems: 1, type: "array" },
        maxInputBytes: { minimum: 1, type: "number" },
        maxModelCalls: { minimum: 1, type: "number" },
        modelCallTimeoutMs: { minimum: 1, type: "number" },
        outputMaxBytes: { minimum: 1, type: "number" },
        outputMaxLines: { minimum: 1, type: "number" },
        question: { type: "string" },
        wholeRunTimeoutMs: { minimum: 1, type: "number" },
      },
      required: ["question"],
      type: "object",
    });
    expect(JSON.stringify(tool.parameters)).toContain("exactly one of contextPath or contextPaths");
    expect(sortedStrings(Object.keys(tool.parameters.properties))).toStrictEqual([
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
      {
        source: ".pi/extensions/lambda-rlm/index.ts",
        tools: registeredTools(registerLambdaRlmEntrypoint),
      },
    ];

    const incompatibleSchemas = registrations.flatMap((registration) =>
      registration.tools
        .map((tool) => ({
          name: tool.name,
          problems: schemaCompatibilityProblems(tool),
          source: registration.source,
        }))
        .filter((tool) => tool.problems.length > 0),
    );

    expect(incompatibleSchemas).toStrictEqual([]);
  });

  it("describes the public tool as the real path-based Lambda-RLM integration", async () => {
    const tool = registeredLambdaRlmTool();
    const updates: ToolUpdate[] = [];

    await tool.execute(
      "metadata-check",
      { contextPath: "/definitely/missing/context.txt", question: "What?" },
      undefined,
      (update) => updates.push(update),
      { cwd: process.cwd() },
    );

    const publicMetadataText = JSON.stringify({
      description: tool.description,
      onUpdate: updates.flatMap((update) => update.content.map((content) => content.text)),
      promptGuidelines: tool.promptGuidelines,
    });

    expect(publicMetadataText).not.toMatch(
      /synthetic|fake|tracer|does not run real Lambda-RLM yet/i,
    );
    expect(publicMetadataText).toMatch(/real Lambda-RLM/i);
    expect(publicMetadataText).toMatch(/Formal Leaf/i);
    expect(publicMetadataText).toMatch(/path-based|contextPath/i);
    expect(publicMetadataText).toMatch(/maxModelCalls|wholeRunTimeoutMs|modelCallTimeoutMs/i);
    expect(publicMetadataText).toMatch(/per-run tightening/i);
  });

  it("executes through the registered public tool path", async () => {
    const tool = registeredLambdaRlmTool();

    const cwd = await tempConfiguredProject();

    const result = await tool.execute(
      "call-1",
      { contextPath: "CONTEXT.md", question: "What is this project about?" },
      undefined,
      undefined,
      {
        cwd,
        leafProcessRunner: async (invocation) => {
          const promptFile = invocation.args.at(-1);
          const prompt = promptFile?.startsWith("@")
            ? await readFile(promptFile.slice(1), "utf-8")
            : "";
          return {
            exitCode: 0,
            stderr: "",
            stdout: prompt.includes("Single digit:") ? "2\n" : "synthetic model answer\n",
          };
        },
      },
    );

    const text = firstContentText(result);
    expect(text).toContain("Real Lambda-RLM completed");
    expect(text).toContain("synthetic model answer");
    expect(result.details.ok).toBeTruthy();
    expect(JSON.stringify(result.details)).not.toContain("Path-Based Context Ingestion");
  });

  it("passes public per-run model-call budget controls through the registered execute path", async () => {
    const tool = registeredLambdaRlmTool();
    const started: string[] = [];

    const cwd = await tempConfiguredProject();

    const result = await tool.execute(
      "call-budgeted",
      { contextPath: "CONTEXT.md", maxModelCalls: 1, question: "What is this project about?" },
      undefined,
      undefined,
      {
        cwd,
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
      partialRun: { childPiLeafCalls: 1, runControls: { maxModelCalls: 1 } },
      runStatus: "runtime_failed",
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

    expect(firstContentText(result)).toContain("lambda_rlm validation failed before execution");
    expect(result.details).toMatchObject({
      error: {
        code: "missing_context_path_file",
        field: "contextPath",
        message: expect.stringContaining("Unable to read contextPath before execution"),
        type: "validation",
      },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
    });
  });

  it("registers a non-destructive doctor command with Pi's two-argument command API", () => {
    const command = registeredLambdaRlmCommand();

    expect(command).toBeTruthy();
    expect(command.name).toBe("lambda-rlm-doctor");
    expect(command.name).not.toMatch(/^\//);
    expect(command.options.description).toMatch(/non-destructive/i);
    expect(command.options.description).toMatch(/Python|config|prompts|mock bridge/i);
    expect(command.options.handler).toStrictEqual(expect.any(Function));
  });

  it("surfaces the doctor report through the command handler and notifies when Pi UI is available", async () => {
    const command = registeredLambdaRlmCommand();
    const notifications: string[] = [];

    const result = await command.options.handler({
      cwd: process.cwd(),
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    });

    const text = firstContentText(result);
    expect(text).toMatch(/lambda_rlm doctor (passed|found errors)/);
    expect(text).toContain("Diagnostics:");
    expect(text).toContain("Post-diagnostics action menu");
    const details = result.details as { actions: unknown; checks: { name: string }[] };
    expect(details.checks.map((check) => check.name)).toContain("mock_bridge");
    expect(details.actions).toBeTruthy();
    expect(notifications).toStrictEqual([text.split("\n", 1)[0]]);
  });

  it("runs non-interactive doctor as diagnostic-only output without UI prompts or repair-flow actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "lambda-rlm-extension-noninteractive-"));
    const workspacePath = join(root, ".pi", "lambda-rlm");
    const command = registeredLambdaRlmCommand(registerLambdaRlmExtension, { workspacePath });

    const result = await command.options.handler({ cwd: root });

    const text = firstContentText(result);
    expect(text).toContain("Diagnostic-Only Doctor Mode");
    expect(text).not.toContain("Post-diagnostics action menu");
    expect(text).toContain('[leaf]\nmodel = "<provider>/<model-id>"');
    expect(result.details).toMatchObject({ mode: "diagnostic-only" });
    expect(result.details).not.toHaveProperty("actions");
    await expect(readFile(join(workspacePath, "config.toml"), "utf-8")).resolves.toContain(
      '# model = "<provider>/<model-id>"',
    );
  });

  it("supports in-flow manual Formal Leaf model entry, writes the global config by default, and reruns diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "lambda-rlm-extension-model-flow-"));
    const workspacePath = join(root, ".pi", "lambda-rlm");
    const command = registeredLambdaRlmCommand(registerLambdaRlmExtension, { workspacePath });
    const selections: string[] = [];
    const prompts: string[] = [];

    const result = await command.options.handler({
      cwd: root,
      leafProcessRunner: okDoctorRunner,
      ui: {
        promptText: (prompt) => {
          prompts.push(prompt);
          return "local/qwen";
        },
        select: (prompt, choices, defaultChoiceId) => {
          selections.push(
            `${prompt}:${defaultChoiceId}:${choices.map((choice) => choice.id).join(",")}`,
          );
          return "select_formal_leaf_model";
        },
      },
    });

    const text = firstContentText(result);
    expect(selections[0]).toContain("select_formal_leaf_model");
    expect(prompts[0]).toMatch(/manual Formal Leaf model/i);
    await expect(readFile(join(workspacePath, "config.toml"), "utf-8")).resolves.toContain(
      'model = "local/qwen"',
    );
    expect(text).toContain(
      "Formal Leaf Model Selection wrote local/qwen to Global Tool Configuration",
    );
    expect(text.match(/Diagnostics:/g)).toHaveLength(2);
    expect(result.details).toMatchObject({
      modelWrite: { model: "local/qwen", target: "global" },
      rerun: { ok: true },
    });
  });

  it("loads the Pi extension entrypoint and registers the lambda_rlm tool", () => {
    const tool = registeredLambdaRlmTool(registerLambdaRlmEntrypoint);

    expect(tool).toBeTruthy();
    expect(tool.name).toBe("lambda_rlm");
    expect(sortedStrings(Object.keys(tool.parameters.properties))).toStrictEqual([
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
