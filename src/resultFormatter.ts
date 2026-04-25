import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type TextContent = { type: "text"; text: string };

export type SourceMetadata = {
  path: string;
  resolvedPath: string;
  bytes: number;
  chars: number;
  lines: number;
  sha256: string;
};

export type OutputLimitOptions = {
  /** Deprecated compatibility knob from earlier slices; treated as a byte limit for ASCII output. */
  maxVisibleChars?: number;
  maxVisibleBytes?: number;
  maxVisibleLines?: number;
  fullOutputDir?: string;
  runId?: string;
};

export const DEFAULT_VISIBLE_OUTPUT_LIMIT = 4096;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function utf8ByteLength(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function truncateToBytes(text: string, maxBytes: number) {
  let out = "";
  for (const char of text) {
    const next = out + char;
    if (utf8ByteLength(next) > maxBytes) break;
    out = next;
  }
  return out;
}

function withinVisibleLimits(text: string, maxVisibleBytes: number, maxVisibleLines?: number) {
  return utf8ByteLength(text) <= maxVisibleBytes && (maxVisibleLines === undefined || countLines(text) <= maxVisibleLines);
}

async function boundVisibleOutput(text: string, options: OutputLimitOptions = {}) {
  const maxVisibleBytes = options.maxVisibleBytes ?? options.maxVisibleChars ?? DEFAULT_VISIBLE_OUTPUT_LIMIT;
  const maxVisibleLines = options.maxVisibleLines;
  const compatibilityMaxVisibleChars = options.maxVisibleChars ?? maxVisibleBytes;
  if (withinVisibleLimits(text, maxVisibleBytes, maxVisibleLines)) {
    return { text, truncated: false, maxVisibleChars: compatibilityMaxVisibleChars, maxVisibleBytes, maxVisibleLines, visibleChars: text.length, visibleBytes: utf8ByteLength(text) };
  }

  const suffix = "[Lambda-RLM output truncated; full output path is in details.output.fullOutputPath when configured.]";
  let fullOutputPath: string | undefined;
  if (options.fullOutputDir) {
    await mkdir(options.fullOutputDir, { recursive: true });
    fullOutputPath = join(options.fullOutputDir, `${options.runId ?? "lambda-rlm-output"}.txt`);
    await writeFile(fullOutputPath, text, "utf8");
  }

  const allowedContentLines = maxVisibleLines === undefined ? undefined : Math.max(0, maxVisibleLines - 1);
  const lineLimitedText = allowedContentLines === undefined ? text : text.split("\n").slice(0, allowedContentLines).join("\n");
  const separator = allowedContentLines === 0 ? "" : "\n";
  const suffixWithSeparator = `${separator}${suffix}`;
  const suffixBytes = utf8ByteLength(suffixWithSeparator);
  const contentBudget = Math.max(0, maxVisibleBytes - suffixBytes);
  const boundedContent = truncateToBytes(lineLimitedText, contentBudget);
  const boundedText = truncateToBytes(`${boundedContent}${suffixWithSeparator}`, maxVisibleBytes);
  return {
    text: boundedText,
    truncated: true,
    maxVisibleChars: compatibilityMaxVisibleChars,
    maxVisibleBytes,
    maxVisibleLines,
    visibleChars: boundedText.length,
    visibleBytes: utf8ByteLength(boundedText),
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}

function sourceDetails(source: SourceMetadata) {
  return {
    source: "file",
    contextPath: source.path,
    resolvedContextPath: source.resolvedPath,
    contextChars: source.chars,
    contextBytes: source.bytes,
    contextLines: source.lines,
    sha256: source.sha256,
  };
}

export async function formatSuccessResult(args: {
  answer: string;
  source: SourceMetadata;
  question: string;
  bridgeRun: Record<string, unknown>;
  modelCallSummary: Record<string, unknown>;
  output?: OutputLimitOptions;
}) {
  const rawVisible = [
    `Run summary: Real Lambda-RLM completed; source chars=${args.source.chars}, lines=${args.source.lines}.`,
    `Model calls: ${String(args.modelCallSummary.total ?? 0)}.`,
    "",
    args.answer,
  ].join("\n");
  const bounded = await boundVisibleOutput(rawVisible, args.output);
  return {
    content: [{ type: "text", text: bounded.text }] as TextContent[],
    details: {
      ok: true,
      authoritativeAnswerAvailable: true,
      answerChars: args.answer.length,
      runStatus: "succeeded",
      input: { ...sourceDetails(args.source), questionChars: args.question.length },
      modelCalls: args.modelCallSummary,
      bridgeRun: args.bridgeRun,
      output: {
        bounded: true,
        visibleChars: bounded.visibleChars,
        visibleBytes: bounded.visibleBytes,
        truncated: bounded.truncated,
        maxVisibleChars: bounded.maxVisibleChars,
        maxVisibleBytes: bounded.maxVisibleBytes,
        ...(bounded.maxVisibleLines !== undefined ? { maxVisibleLines: bounded.maxVisibleLines } : {}),
        ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
      },
      warnings: [],
    },
  };
}

export function formatValidationFailure(args: { code: string; message: string; field?: string }) {
  return {
    content: [{ type: "text", text: `lambda_rlm validation failed before execution: ${args.message}` }] as TextContent[],
    details: {
      ok: false,
      runStatus: "validation_failed",
      error: { type: "validation", code: args.code, message: args.message, ...(args.field ? { field: args.field } : {}) },
      execution: { executionStarted: false, partialDetailsAvailable: false },
    },
  };
}

export async function formatRuntimeFailure(args: {
  error: { type: string; code: string; message: string };
  source?: SourceMetadata;
  question?: string;
  partialBridgeRun?: Record<string, unknown>;
  partialAnswer?: string;
  output?: OutputLimitOptions;
}) {
  const visible = [
    `lambda_rlm runtime failed: ${args.error.message}`,
    "No authoritative answer is available from this failed run.",
    args.partialAnswer ? "A partial answer was captured and marked non-authoritative in details.partialAnswer." : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const bounded = await boundVisibleOutput(visible, args.output);
  return {
    content: [{ type: "text", text: bounded.text }] as TextContent[],
    details: {
      ok: false,
      runStatus: "runtime_failed",
      answer: null,
      authoritativeAnswerAvailable: false,
      error: args.error,
      ...(args.partialAnswer ? { partialAnswer: { authoritative: false, text: args.partialAnswer } } : {}),
      ...(args.source ? { input: { ...sourceDetails(args.source), ...(args.question ? { questionChars: args.question.length } : {}) } } : {}),
      ...(args.partialBridgeRun ? { partialRun: args.partialBridgeRun } : {}),
      output: {
        bounded: true,
        visibleChars: bounded.visibleChars,
        visibleBytes: bounded.visibleBytes,
        truncated: bounded.truncated,
        maxVisibleChars: bounded.maxVisibleChars,
        maxVisibleBytes: bounded.maxVisibleBytes,
        ...(bounded.maxVisibleLines !== undefined ? { maxVisibleLines: bounded.maxVisibleLines } : {}),
        ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
      },
    },
  };
}
