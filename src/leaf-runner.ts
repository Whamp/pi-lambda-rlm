import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticHash } from "./diagnostics.js";

export const FORMAL_LEAF_SYSTEM_PROMPT = [
  "You are the bounded neural subroutine inside Lambda-RLM.",
  "Follow the user prompt exactly.",
  "Return only the requested result.",
  "Do not mention Lambda-RLM unless the prompt asks you to.",
  "Do not describe your process.",
  "Do not ask follow-up questions.",
].join("\n");

export const FORMAL_LEAF_READ_ONLY_TOOLS = "read,grep,find,ls";

export type LeafThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ProcessInvocation {
  command: string;
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  signal?: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
}

export type Awaitable<T> = T | Promise<T>;

export type ProcessRunner = (invocation: ProcessInvocation) => Awaitable<ProcessResult>;

export interface FormalPiLeafCommandOptions {
  piExecutable?: string;
  promptFilePath: string;
  leafModel: string;
  leafThinking?: LeafThinking;
  systemPrompt?: string;
}

export interface FormalLeafRunOptions {
  piExecutable?: string;
  leafModel: string;
  leafThinking?: LeafThinking;
  systemPrompt?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  processRunner?: ProcessRunner;
}

export interface ModelCall {
  requestId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LeafModelCallSuccess {
  ok: true;
  requestId: string;
  content: string;
  diagnostics: {
    stdoutChars: number;
    stderr: string;
    exitCode: number | null;
  };
}

export interface LeafModelCallFailureDetails {
  ok: false;
  requestId: string;
  error: { type: "child_process"; code: string; message: string };
  diagnostics: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal?: NodeJS.Signals | string | null;
  };
}

export class LeafProcessFailureError extends Error {
  readonly details: LeafModelCallFailureDetails;

  constructor(details: LeafModelCallFailureDetails) {
    super(details.error.message);
    this.name = "LeafProcessFailureError";
    this.details = details;
  }
}

export { LeafProcessFailureError as LeafProcessFailure };

export function buildFormalPiLeafCommand(options: FormalPiLeafCommandOptions): {
  command: string;
  args: string[];
} {
  return {
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
      "--tools",
      FORMAL_LEAF_READ_ONLY_TOOLS,
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      `@${options.promptFilePath}`,
    ],
    command: options.piExecutable ?? "pi",
  };
}

export const nodeProcessRunner: ProcessRunner = ({ command, args, timeoutMs, signal }) =>
  // Wrapping child_process events requires constructing one boundary promise.
  // oxlint-disable-next-line promise/avoid-new
  new Promise((resolve, reject) => {
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
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.on("exit", (exitCode, exitSignal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ exitCode, signal: exitSignal, stdout, stderr });
    });
  });

function trimOneTrailingNewline(text: string) {
  return text.replace(/\r?\n$/, "");
}

type LeafProcessFailureCode =
  | "child_exit_nonzero"
  | "model_call_cancelled"
  | "per_model_call_timeout";

function leafProcessFailureCode(state: { cancelled: boolean; timedOut: boolean }) {
  if (state.timedOut) {
    return "per_model_call_timeout";
  }
  if (state.cancelled) {
    return "model_call_cancelled";
  }
  return "child_exit_nonzero";
}

function leafProcessFailureMessage(
  code: LeafProcessFailureCode,
  timeoutMs: number | undefined,
  result?: ProcessResult,
) {
  if (code === "per_model_call_timeout") {
    return `Child pi leaf process exceeded per-model-call timeout of ${timeoutMs}ms.`;
  }
  if (code === "model_call_cancelled") {
    return "Child pi leaf process was cancelled.";
  }
  return `Child pi leaf process exited with code ${result?.exitCode ?? "null"} signal ${result?.signal ?? "null"}.`;
}

export async function runFormalPiLeafModelCall(
  call: ModelCall,
  options: FormalLeafRunOptions,
): Promise<LeafModelCallSuccess> {
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

  const failure = (code: string, message: string, result?: ProcessResult) => {
    const processResult = result ?? { exitCode: null, stderr: "", stdout: "" };
    return new LeafProcessFailureError({
      diagnostics: {
        stdout: "",
        stderr: "",
        exitCode: processResult.exitCode,
        ...(processResult.signal === undefined ? {} : { signal: processResult.signal }),
        stdoutBytes: Buffer.byteLength(processResult.stdout, "utf-8"),
        stdoutSha256: diagnosticHash(processResult.stdout),
        stderrBytes: Buffer.byteLength(processResult.stderr, "utf-8"),
        stderrSha256: diagnosticHash(processResult.stderr),
      } as LeafModelCallFailureDetails["diagnostics"],
      error: { code, message, type: "child_process" },
      ok: false,
      requestId: call.requestId,
    });
  };

  try {
    await writeFile(promptFilePath, call.prompt, "utf-8");
    const invocation = buildFormalPiLeafCommand({
      ...(options.piExecutable ? { piExecutable: options.piExecutable } : {}),
      leafModel: options.leafModel,
      promptFilePath,
      ...(options.leafThinking ? { leafThinking: options.leafThinking } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    });
    let result: ProcessResult;
    try {
      result = await processRunner({
        ...invocation,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut || cancelled || controller.signal.aborted) {
        const code = leafProcessFailureCode({
          cancelled: cancelled || controller.signal.aborted,
          timedOut,
        });
        throw failure(code, leafProcessFailureMessage(code, options.timeoutMs));
      }
      throw error;
    }

    if (result.exitCode !== 0) {
      const code = leafProcessFailureCode({ cancelled, timedOut });
      throw failure(code, leafProcessFailureMessage(code, options.timeoutMs, result), result);
    }

    return {
      content: trimOneTrailingNewline(result.stdout),
      diagnostics: {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdoutChars: result.stdout.length,
      },
      ok: true,
      requestId: call.requestId,
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    sourceSignal?.removeEventListener("abort", onAbort);
    await rm(tempDir, { force: true, recursive: true });
  }
}
