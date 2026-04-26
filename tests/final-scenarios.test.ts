import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLambdaRlmTool as executeLambdaRlmToolRaw } from "../src/lambda-rlm-tool.js";

function tempDir(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

function readPromptFromInvocation(invocation: { args: string[] }) {
  const promptFile = invocation.args.at(-1);
  return promptFile?.startsWith("@") ? readFile(promptFile.slice(1), "utf-8") : "";
}

async function writeLeafConfig(cwd: string) {
  await mkdir(join(cwd, ".pi", "lambda-rlm"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "lambda-rlm", "config.toml"),
    '[leaf]\nmodel = "google/gemini-test"\n',
    "utf-8",
  );
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
    ...options,
  });
}

describe("final MVP mock end-to-end scenarios", () => {
  it("covers the primary long-context file QA scenario through the real bridge and fake Formal Leaf runner", async () => {
    const cwd = await tempDir("lambda-rlm-final-qa-");
    await writeLeafConfig(cwd);
    const contextPath = join(cwd, "architecture-notes.md");
    await writeFile(
      contextPath,
      [
        "DO_NOT_ECHO_FULL_QA_FIXTURE",
        "# Architecture notes",
        "The Lambda-RLM MVP is an agent-invoked Pi tool.",
        "Its public contract is path-based: contextPath or contextPaths plus question.",
        "The tool reads source files internally to protect the parent agent context budget.",
      ].join("\n"),
      "utf-8",
    );
    const prompts: string[] = [];

    const result = await executeLambdaRlmTool(
      {
        contextPath: "architecture-notes.md",
        outputMaxBytes: 1400,
        question: "What invariant protects the parent agent context budget?",
      },
      {
        contextWindowChars: 90,
        cwd,
        leafProcessRunner: async (invocation) => {
          const prompt = await readPromptFromInvocation(invocation);
          prompts.push(prompt);
          if (prompt.includes("Single digit:")) {
            return { exitCode: 0, stdout: "2\n", stderr: "" };
          }
          if (prompt.includes("Does this excerpt contain information relevant")) {
            return { exitCode: 0, stdout: "YES\n", stderr: "" };
          }
          if (prompt.includes("Using the following context, answer")) {
            return {
              exitCode: 0,
              stdout:
                "The invariant is Agent Context Avoidance: pass file paths, and let the tool read source contents internally.\n",
              stderr: "",
            };
          }
          if (prompt.includes("Synthesise these partial answers")) {
            return {
              exitCode: 0,
              stdout:
                "Agent Context Avoidance protects the parent context budget: the Pi Agent passes paths while lambda_rlm reads source files internally.\n",
              stderr: "",
            };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected prompt: ${prompt.slice(0, 200)}` };
        },
      },
    );

    const text = result.content[0]?.text ?? "";
    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: true,
      input: { source: "file", sourceCount: 1 },
      ok: true,
      output: { bounded: true },
    });
    expect(text).toContain("Agent Context Avoidance");
    expect(text).toContain("reads source files internally");
    expect(text).toContain("Run summary: Real Lambda-RLM completed");
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(1400);
    expect(text).not.toContain("DO_NOT_ECHO_FULL_QA_FIXTURE");
    expect(JSON.stringify(result.details)).not.toContain("DO_NOT_ECHO_FULL_QA_FIXTURE");
    expect(
      prompts.some((prompt) => prompt.includes("Using the following context, answer")),
    ).toBeTruthy();
  });

  it("covers the secondary long-context synthesis scenario across multiple files with bounded, clear output", async () => {
    const cwd = await tempDir("lambda-rlm-final-synthesis-");
    await writeLeafConfig(cwd);
    await mkdir(join(cwd, "notes"), { recursive: true });
    await writeFile(
      join(cwd, "notes", "one.md"),
      "DO_NOT_ECHO_SYNTHESIS_FIXTURE\nFinding A: path-only input keeps long source text out of parent context.\n",
      "utf-8",
    );
    await writeFile(
      join(cwd, "notes", "two.md"),
      "Finding B: bounded output should include a compact run summary and useful answer.\n",
      "utf-8",
    );
    const prompts: string[] = [];

    const result = await executeLambdaRlmTool(
      {
        contextPaths: ["notes/one.md", "notes/two.md"],
        outputMaxBytes: 1200,
        outputMaxLines: 10,
        question: "Summarize the operational guidance in these notes.",
      },
      {
        contextWindowChars: 85,
        cwd,
        leafProcessRunner: async (invocation) => {
          const prompt = await readPromptFromInvocation(invocation);
          prompts.push(prompt);
          if (prompt.includes("Single digit:")) {
            return { exitCode: 0, stdout: "1\n", stderr: "" };
          }
          if (prompt.includes("Summarize the following text concisely")) {
            return {
              exitCode: 0,
              stdout:
                "Partial summary: Use path-only inputs and return compact, bounded answers.\n",
              stderr: "",
            };
          }
          if (prompt.includes("Merge these partial summaries")) {
            return {
              exitCode: 0,
              stdout:
                "Operational guidance: pass paths instead of inline source text, let lambda_rlm read files internally, and return a concise answer with a compact run summary.\n",
              stderr: "",
            };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected prompt: ${prompt.slice(0, 200)}` };
        },
      },
    );

    const text = result.content[0]?.text ?? "";
    expect(result.details).toMatchObject({
      authoritativeAnswerAvailable: true,
      input: { source: "files", sourceCount: 2 },
      ok: true,
      output: { bounded: true, truncated: false },
    });
    expect(text).toContain("Operational guidance");
    expect(text).toContain("pass paths instead of inline source text");
    expect(text).toContain("compact run summary");
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(1200);
    expect(text.split("\n").length).toBeLessThanOrEqual(10);
    expect(text).not.toContain("DO_NOT_ECHO_SYNTHESIS_FIXTURE");
    expect(JSON.stringify(result.details)).not.toContain("DO_NOT_ECHO_SYNTHESIS_FIXTURE");
    expect(
      prompts.some((prompt) => prompt.includes("Summarize the following text concisely")),
    ).toBeTruthy();
    expect(prompts.some((prompt) => prompt.includes("Merge these partial summaries"))).toBeTruthy();
  });
});
