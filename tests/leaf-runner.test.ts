import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  FORMAL_LEAF_SYSTEM_PROMPT,
  LeafProcessFailure,
  buildFormalPiLeafCommand,
  runFormalPiLeafModelCall,
  type ProcessRunner,
} from "../src/leafRunner.js";

describe("Formal Pi leaf runner", () => {
  it("constructs a constrained pi -p command for the Formal Leaf Profile", () => {
    const command = buildFormalPiLeafCommand({
      piExecutable: "pi",
      promptFilePath: "/tmp/leaf-prompt.txt",
      leafModel: "google/gemini-test",
      leafThinking: "off",
      systemPrompt: FORMAL_LEAF_SYSTEM_PROMPT,
    });

    expect(command).toEqual({
      command: "pi",
      args: [
        "--print",
        "--mode",
        "text",
        "--no-session",
        "--model",
        "google/gemini-test",
        "--thinking",
        "off",
        "--system-prompt",
        FORMAL_LEAF_SYSTEM_PROMPT,
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "@/tmp/leaf-prompt.txt",
      ],
    });

    expect(command.args).toContain("--no-tools");
    expect(command.args).toContain("--no-extensions");
    expect(command.args).toContain("--no-skills");
    expect(command.args).toContain("--no-context-files");
    expect(command.args).toContain("--no-prompt-templates");
    expect(command.args).toContain("--no-session");
    expect(command.args).not.toContain("--extension");
    expect(command.args).not.toContain("-e");
    expect(command.args.at(-1)).toEqual("@/tmp/leaf-prompt.txt");
  });

  it("services one model callback through a mock process runner and temp prompt file", async () => {
    const calls: Array<{ command: string; args: string[]; promptFileContent: string }> = [];
    const processRunner: ProcessRunner = async (invocation) => {
      const promptFileArg = invocation.args.at(-1);
      if (!promptFileArg?.startsWith("@")) throw new Error("missing @ prompt file arg");
      calls.push({
        command: invocation.command,
        args: invocation.args,
        promptFileContent: await readFile(promptFileArg.slice(1), "utf8"),
      });
      return { exitCode: 0, stdout: "leaf answer\n", stderr: "leaf diagnostics\n" };
    };

    const result = await runFormalPiLeafModelCall(
      { requestId: "model-call-1", prompt: "Large rendered Lambda-RLM prompt" },
      { leafModel: "google/gemini-test", leafThinking: "low", piExecutable: "pi", processRunner },
    );

    expect(result).toMatchObject({ ok: true, requestId: "model-call-1", content: "leaf answer" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "pi", promptFileContent: "Large rendered Lambda-RLM prompt" });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"]));
  });

  it("returns a structured failure when the child pi process exits non-zero", async () => {
    await expect(
      runFormalPiLeafModelCall(
        { requestId: "model-call-1", prompt: "prompt" },
        {
          leafModel: "google/gemini-test",
          processRunner: async () => ({ exitCode: 2, stdout: "partial stdout", stderr: "bad auth" }),
        },
      ),
    ).rejects.toMatchObject({
      name: "LeafProcessFailure",
      details: {
        ok: false,
        requestId: "model-call-1",
        error: { type: "child_process", code: "child_exit_nonzero", message: expect.stringContaining("2") },
        diagnostics: { stdout: "partial stdout", stderr: "bad auth", exitCode: 2 },
      },
    } satisfies Partial<LeafProcessFailure>);
  });

  it("aborts a stuck child process on per-model-call timeout and reports a structured timeout failure", async () => {
    let observedAbort = false;
    await expect(
      runFormalPiLeafModelCall(
        { requestId: "model-call-timeout", prompt: "prompt" },
        {
          leafModel: "google/gemini-test",
          timeoutMs: 10,
          processRunner: (invocation) =>
            new Promise((resolve) => {
              invocation.signal?.addEventListener("abort", () => {
                observedAbort = true;
                resolve({ exitCode: null, signal: "SIGTERM", stdout: "partial stdout", stderr: "timed out" });
              });
            }),
        },
      ),
    ).rejects.toMatchObject({
      name: "LeafProcessFailure",
      details: {
        ok: false,
        requestId: "model-call-timeout",
        error: { type: "child_process", code: "per_model_call_timeout" },
        diagnostics: { stdout: "partial stdout", stderr: "timed out", exitCode: null, signal: "SIGTERM" },
      },
    });
    expect(observedAbort).toBe(true);
  });
});
