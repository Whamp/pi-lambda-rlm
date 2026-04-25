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
  signal?: AbortSignal;
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
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let timeout: NodeJS.Timeout | undefined;
  const sourceSignal = call.signal ?? options.signal;
  const onAbort = () => {
    cancelled = true;
    controller.abort();
  };
  sourceSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  }

  const failure = (code: string, message: string, result: ProcessResult = { exitCode: null, stdout: "", stderr: "" }) =>
    new LeafProcessFailure({
      ok: false,
      requestId: call.requestId,
      error: { type: "child_process", code, message },
      diagnostics: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...(result.signal !== undefined ? { signal: result.signal } : {}),
      },
    });

  try {
    await writeFile(promptFilePath, call.prompt, "utf8");
    const invocation = buildFormalPiLeafCommand({
      ...(options.piExecutable ? { piExecutable: options.piExecutable } : {}),
      promptFilePath,
      leafModel: options.leafModel,
      ...(options.leafThinking ? { leafThinking: options.leafThinking } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    });
    let result: ProcessResult;
    try {
      result = await processRunner({
        ...invocation,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) throw failure("per_model_call_timeout", `Child pi leaf process exceeded per-model-call timeout of ${options.timeoutMs}ms.`);
      if (cancelled || controller.signal.aborted) throw failure("model_call_cancelled", "Child pi leaf process was cancelled.");
      throw error;
    }

    if (result.exitCode !== 0) {
      const code = timedOut ? "per_model_call_timeout" : cancelled ? "model_call_cancelled" : "child_exit_nonzero";
      const message =
        code === "per_model_call_timeout"
          ? `Child pi leaf process exceeded per-model-call timeout of ${options.timeoutMs}ms.`
          : code === "model_call_cancelled"
            ? "Child pi leaf process was cancelled."
            : `Child pi leaf process exited with code ${result.exitCode ?? "null"} signal ${result.signal ?? "null"}.`;
      throw failure(code, message, result);
    }

    return {
      ok: true,
      requestId: call.requestId,
      content: trimOneTrailingNewline(result.stdout),
      diagnostics: { stdoutChars: result.stdout.length, stderr: result.stderr, exitCode: result.exitCode },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", onAbort);
    await rm(tempDir, { recursive: true, force: true });
  }
}
