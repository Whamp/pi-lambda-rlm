import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FORMAL_LEAF_SYSTEM_PROMPT = [
  "You are the bounded neural subroutine inside Lambda-RLM.",
  "Follow the user prompt exactly.",
  "Return only the requested result.",
  "Do not mention Lambda-RLM unless the prompt asks you to.",
  "Do not describe your process.",
  "Do not ask follow-up questions.",
].join("\n");

export type LeafThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ProcessInvocation = {
  command: string;
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ProcessResult = {
  exitCode: number | null;
  signal?: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
};

export type ProcessRunner = (invocation: ProcessInvocation) => Promise<ProcessResult>;

export type FormalPiLeafCommandOptions = {
  piExecutable?: string;
  promptFilePath: string;
  leafModel: string;
  leafThinking?: LeafThinking;
  systemPrompt?: string;
};

export type FormalLeafRunOptions = {
  piExecutable?: string;
  leafModel: string;
  leafThinking?: LeafThinking;
  systemPrompt?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  processRunner?: ProcessRunner;
};

export type ModelCall = {
  requestId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
};

export type LeafModelCallSuccess = {
  ok: true;
  requestId: string;
  content: string;
  diagnostics: {
    stdoutChars: number;
    stderr: string;
    exitCode: number | null;
  };
};

export type LeafModelCallFailureDetails = {
  ok: false;
  requestId: string;
  error: { type: "child_process"; code: string; message: string };
  diagnostics: { stdout: string; stderr: string; exitCode: number | null; signal?: NodeJS.Signals | string | null };
};

export class LeafProcessFailure extends Error {
  readonly details: LeafModelCallFailureDetails;

  constructor(details: LeafModelCallFailureDetails) {
    super(details.error.message);
    this.name = "LeafProcessFailure";
    this.details = details;
  }
}

export function buildFormalPiLeafCommand(options: FormalPiLeafCommandOptions): { command: string; args: string[] } {
  return {
    command: options.piExecutable ?? "pi",
    args: [
      "--print",
      "--mode",
      "text",
      "--no-session",
      "--model",
      options.leafModel,
      "--thinking",
      options.leafThinking ?? "off",
      "--system-prompt",
      options.systemPrompt ?? FORMAL_LEAF_SYSTEM_PROMPT,
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      `@${options.promptFilePath}`,
    ],
  };
}

export const nodeProcessRunner: ProcessRunner = ({ command, args, timeoutMs, signal }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | undefined;

    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (exitCode, exitSignal) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode, signal: exitSignal, stdout, stderr });
    });
  });
};

function trimOneTrailingNewline(text: string) {
  return text.replace(/\r?\n$/, "");
}

export async function runFormalPiLeafModelCall(call: ModelCall, options: FormalLeafRunOptions): Promise<LeafModelCallSuccess> {
  const processRunner = options.processRunner ?? nodeProcessRunner;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-lambda-rlm-leaf-"));
  const promptFilePath = join(tempDir, "prompt.txt");

  try {
    await writeFile(promptFilePath, call.prompt, "utf8");
    const invocation = buildFormalPiLeafCommand({
      ...(options.piExecutable ? { piExecutable: options.piExecutable } : {}),
      promptFilePath,
      leafModel: options.leafModel,
      ...(options.leafThinking ? { leafThinking: options.leafThinking } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    });
    const result = await processRunner({
      ...invocation,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (result.exitCode !== 0) {
      throw new LeafProcessFailure({
        ok: false,
        requestId: call.requestId,
        error: {
          type: "child_process",
          code: "child_exit_nonzero",
          message: `Child pi leaf process exited with code ${result.exitCode ?? "null"} signal ${result.signal ?? "null"}.`,
        },
        diagnostics: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          ...(result.signal !== undefined ? { signal: result.signal } : {}),
        },
      });
    }

    return {
      ok: true,
      requestId: call.requestId,
      content: trimOneTrailingNewline(result.stdout),
      diagnostics: { stdoutChars: result.stdout.length, stderr: result.stderr, exitCode: result.exitCode },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
