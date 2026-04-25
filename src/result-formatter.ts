import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface TextContent {
  type: "text";
  text: string;
}

export interface SourceMetadata {
  sourceNumber: number;
  path: string;
  resolvedPath: string;
  bytes: number;
  chars: number;
  lines: number;
  sha256: string;
}

export interface OutputLimitOptions {
  /** Deprecated compatibility knob from earlier slices; treated as a byte limit for ASCII output. */
  maxVisibleChars?: number;
  maxVisibleBytes?: number;
  maxVisibleLines?: number;
  fullOutputDir?: string;
  runId?: string;
}

export const DEFAULT_VISIBLE_OUTPUT_LIMIT = 4096;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split("\n").length;
}

function utf8ByteLength(text: string) {
  return Buffer.byteLength(text, "utf-8");
}

function truncateToBytes(text: string, maxBytes: number) {
  let out = "";
  for (const char of text) {
    const next = out + char;
    if (utf8ByteLength(next) > maxBytes) {
      break;
    }
    out = next;
  }
  return out;
}

function withinVisibleLimits(text: string, maxVisibleBytes: number, maxVisibleLines?: number) {
  return (
    utf8ByteLength(text) <= maxVisibleBytes &&
    (maxVisibleLines === undefined || countLines(text) <= maxVisibleLines)
  );
}

async function boundVisibleOutput(text: string, options: OutputLimitOptions = {}) {
  const maxVisibleBytes =
    options.maxVisibleBytes ?? options.maxVisibleChars ?? DEFAULT_VISIBLE_OUTPUT_LIMIT;
  const { maxVisibleLines } = options;
  const compatibilityMaxVisibleChars = options.maxVisibleChars ?? maxVisibleBytes;
  if (withinVisibleLimits(text, maxVisibleBytes, maxVisibleLines)) {
    return {
      maxVisibleBytes,
      maxVisibleChars: compatibilityMaxVisibleChars,
      maxVisibleLines,
      text,
      truncated: false,
      visibleBytes: utf8ByteLength(text),
      visibleChars: text.length,
    };
  }

  const suffix =
    "[Lambda-RLM output truncated; full output path is in details.output.fullOutputPath when configured.]";
  let fullOutputPath: string | undefined;
  if (options.fullOutputDir) {
    await mkdir(options.fullOutputDir, { recursive: true });
    fullOutputPath = join(options.fullOutputDir, `${options.runId ?? "lambda-rlm-output"}.txt`);
    await writeFile(fullOutputPath, text, "utf-8");
  }

  const allowedContentLines =
    maxVisibleLines === undefined ? undefined : Math.max(0, maxVisibleLines - 1);
  const lineLimitedText =
    allowedContentLines === undefined
      ? text
      : text.split("\n").slice(0, allowedContentLines).join("\n");
  const separator = allowedContentLines === 0 ? "" : "\n";
  const suffixWithSeparator = `${separator}${suffix}`;
  const suffixBytes = utf8ByteLength(suffixWithSeparator);
  const contentBudget = Math.max(0, maxVisibleBytes - suffixBytes);
  const boundedContent = truncateToBytes(lineLimitedText, contentBudget);
  const boundedText = truncateToBytes(`${boundedContent}${suffixWithSeparator}`, maxVisibleBytes);
  return {
    maxVisibleBytes,
    maxVisibleChars: compatibilityMaxVisibleChars,
    maxVisibleLines,
    text: boundedText,
    truncated: true,
    visibleBytes: utf8ByteLength(boundedText),
    visibleChars: boundedText.length,
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}

function compactSourceDetails(source: SourceMetadata) {
  return {
    bytes: source.bytes,
    chars: source.chars,
    lines: source.lines,
    path: source.path,
    resolvedPath: source.resolvedPath,
    sha256: source.sha256,
    sourceNumber: source.sourceNumber,
  };
}

function sourceDetails(sources: SourceMetadata[]) {
  if (sources.length === 1) {
    const [source] = sources;
    if (!source) {
      throw new Error("Expected a single source when building source details.");
    }
    return {
      contextBytes: source.bytes,
      contextChars: source.chars,
      contextLines: source.lines,
      contextPath: source.path,
      resolvedContextPath: source.resolvedPath,
      sha256: source.sha256,
      source: "file",
      sourceCount: 1,
      sourceNumber: source.sourceNumber,
      sources: [compactSourceDetails(source)],
      totalBytes: source.bytes,
      totalChars: source.chars,
      totalLines: source.lines,
    };
  }
  return {
    source: "files",
    sourceCount: sources.length,
    sources: sources.map(compactSourceDetails),
    totalBytes: sources.reduce((sum, source) => sum + source.bytes, 0),
    totalChars: sources.reduce((sum, source) => sum + source.chars, 0),
    totalLines: sources.reduce((sum, source) => sum + source.lines, 0),
  };
}

export async function formatSuccessResult(args: {
  answer: string;
  sources: SourceMetadata[];
  question: string;
  bridgeRun: Record<string, unknown>;
  modelCallSummary: Record<string, unknown>;
  output?: OutputLimitOptions;
}) {
  const totalChars = args.sources.reduce((sum, source) => sum + source.chars, 0);
  const totalLines = args.sources.reduce((sum, source) => sum + source.lines, 0);
  const sourceSummary =
    args.sources.length === 1
      ? `source chars=${totalChars}, lines=${totalLines}`
      : `sources=${args.sources.length}, chars=${totalChars}, lines=${totalLines}`;
  const rawVisible = [
    `Run summary: Real Lambda-RLM completed; ${sourceSummary}.`,
    `Model calls: ${String(args.modelCallSummary.total ?? 0)}.`,
    "",
    args.answer,
  ].join("\n");
  const bounded = await boundVisibleOutput(rawVisible, args.output);
  return {
    content: [{ text: bounded.text, type: "text" }] as TextContent[],
    details: {
      answerChars: args.answer.length,
      authoritativeAnswerAvailable: true,
      bridgeRun: args.bridgeRun,
      input: { ...sourceDetails(args.sources), questionChars: args.question.length },
      modelCalls: args.modelCallSummary,
      ok: true,
      output: {
        bounded: true,
        maxVisibleBytes: bounded.maxVisibleBytes,
        maxVisibleChars: bounded.maxVisibleChars,
        truncated: bounded.truncated,
        visibleBytes: bounded.visibleBytes,
        visibleChars: bounded.visibleChars,
        ...(bounded.maxVisibleLines === undefined
          ? {}
          : { maxVisibleLines: bounded.maxVisibleLines }),
        ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
      },
      runStatus: "succeeded",
      warnings: [],
    },
  };
}

export function formatValidationFailure(args: { code: string; message: string; field?: string }) {
  return {
    content: [
      { text: `lambda_rlm validation failed before execution: ${args.message}`, type: "text" },
    ] as TextContent[],
    details: {
      error: {
        code: args.code,
        message: args.message,
        type: "validation",
        ...(args.field ? { field: args.field } : {}),
      },
      execution: { executionStarted: false, partialDetailsAvailable: false },
      ok: false,
      runStatus: "validation_failed",
    },
  };
}

export async function formatRuntimeFailure(args: {
  error: { type: string; code: string; message: string };
  sources?: SourceMetadata[];
  question?: string;
  partialBridgeRun?: Record<string, unknown>;
  partialAnswer?: string;
  output?: OutputLimitOptions;
}) {
  const visible = [
    `lambda_rlm runtime failed: ${args.error.message}`,
    "No authoritative answer is available from this failed run.",
    args.partialAnswer
      ? "A partial answer was captured and marked non-authoritative in details.partialAnswer."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const bounded = await boundVisibleOutput(visible, args.output);
  return {
    content: [{ text: bounded.text, type: "text" }] as TextContent[],
    details: {
      ok: false,
      runStatus: "runtime_failed",
      answer: null,
      authoritativeAnswerAvailable: false,
      error: args.error,
      ...(args.partialAnswer
        ? { partialAnswer: { authoritative: false, text: args.partialAnswer } }
        : {}),
      ...(args.sources
        ? {
            input: {
              ...sourceDetails(args.sources),
              ...(args.question ? { questionChars: args.question.length } : {}),
            },
          }
        : {}),
      ...(args.partialBridgeRun ? { partialRun: args.partialBridgeRun } : {}),
      output: {
        bounded: true,
        maxVisibleBytes: bounded.maxVisibleBytes,
        maxVisibleChars: bounded.maxVisibleChars,
        truncated: bounded.truncated,
        visibleBytes: bounded.visibleBytes,
        visibleChars: bounded.visibleChars,
        ...(bounded.maxVisibleLines === undefined
          ? {}
          : { maxVisibleLines: bounded.maxVisibleLines }),
        ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
      },
    },
  };
}
