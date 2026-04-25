import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  FORMAL_LEAF_SYSTEM_PROMPT,
  buildFormalPiLeafCommand,
  runFormalPiLeafModelCall,
} from "../src/leaf-runner.js";
import type { ProcessResult, ProcessRunner } from "../src/leaf-runner.js";

function resolveOnAbort(
  signal: AbortSignal | undefined,
  result: ProcessResult,
): Promise<ProcessResult> {
  // AbortSignal is EventTarget-based; a one-shot promise is the clearest test seam.
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(result), { once: true });
  });
}

describe("Formal Pi leaf runner", () => {
  it("constructs a constrained pi -p command for the Formal Leaf Profile", () => {
    const command = buildFormalPiLeafCommand({
      leafModel: "google/gemini-test",
      leafThinking: "off",
      piExecutable: "pi",
      promptFilePath: "/tmp/leaf-prompt.txt",
      systemPrompt: FORMAL_LEAF_SYSTEM_PROMPT,
    });

    expect(command).toStrictEqual({
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
      command: "pi",
    });

    expect(command.args).toContain("--no-tools");
    expect(command.args).toContain("--no-extensions");
    expect(command.args).toContain("--no-skills");
    expect(command.args).toContain("--no-context-files");
    expect(command.args).toContain("--no-prompt-templates");
    expect(command.args).toContain("--no-session");
    expect(command.args).not.toContain("--extension");
    expect(command.args).not.toContain("-e");
    expect(command.args.at(-1)).toBe("@/tmp/leaf-prompt.txt");
  });

  it("services one model callback through a mock process runner and temp prompt file", async () => {
    const calls: { command: string; args: string[]; promptFileContent: string }[] = [];
    const processRunner: ProcessRunner = async (invocation) => {
      const promptFileArg = invocation.args.at(-1);
      if (!promptFileArg?.startsWith("@")) {
        throw new Error("missing @ prompt file arg");
      }
      calls.push({
        args: invocation.args,
        command: invocation.command,
        promptFileContent: await readFile(promptFileArg.slice(1), "utf-8"),
      });
      return { exitCode: 0, stderr: "leaf diagnostics\n", stdout: "leaf answer\n" };
    };

    const result = await runFormalPiLeafModelCall(
      { prompt: "Large rendered Lambda-RLM prompt", requestId: "model-call-1" },
      { leafModel: "google/gemini-test", leafThinking: "low", piExecutable: "pi", processRunner },
    );

    expect(result).toMatchObject({ content: "leaf answer", ok: true, requestId: "model-call-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "pi",
      promptFileContent: "Large rendered Lambda-RLM prompt",
    });
    expect(calls[0]?.args).toStrictEqual(
      expect.arrayContaining([
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
      ]),
    );
  });

  it("returns a structured failure when the child pi process exits non-zero", async () => {
    await expect(
      runFormalPiLeafModelCall(
        { prompt: "prompt", requestId: "model-call-1" },
        {
          leafModel: "google/gemini-test",
          processRunner: () => ({
            exitCode: 2,
            stderr: "bad auth",
            stdout: "partial stdout",
          }),
        },
      ),
    ).rejects.toMatchObject({
      details: {
        diagnostics: {
          exitCode: 2,
          stderr: "",
          stderrBytes: Buffer.byteLength("bad auth", "utf-8"),
          stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          stdout: "",
          stdoutBytes: Buffer.byteLength("partial stdout", "utf-8"),
          stdoutSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        error: {
          code: "child_exit_nonzero",
          message: expect.stringContaining("2"),
          type: "child_process",
        },
        ok: false,
        requestId: "model-call-1",
      },
      name: "LeafProcessFailureError",
    });
  });

  it("aborts a stuck child process on per-model-call timeout and reports a structured timeout failure", async () => {
    let observedAbort = false;
    await expect(
      runFormalPiLeafModelCall(
        { prompt: "prompt", requestId: "model-call-timeout" },
        {
          leafModel: "google/gemini-test",
          processRunner: async (invocation) => {
            const result = await resolveOnAbort(invocation.signal, {
              exitCode: null,
              signal: "SIGTERM",
              stderr: "timed out",
              stdout: "partial stdout",
            });
            observedAbort = true;
            return result;
          },
          timeoutMs: 10,
        },
      ),
    ).rejects.toMatchObject({
      details: {
        diagnostics: {
          exitCode: null,
          signal: "SIGTERM",
          stderr: "",
          stderrBytes: Buffer.byteLength("timed out", "utf-8"),
          stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          stdout: "",
          stdoutBytes: Buffer.byteLength("partial stdout", "utf-8"),
          stdoutSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        error: { code: "per_model_call_timeout", type: "child_process" },
        ok: false,
        requestId: "model-call-timeout",
      },
      name: "LeafProcessFailureError",
    });
    expect(observedAbort).toBeTruthy();
  });
});
