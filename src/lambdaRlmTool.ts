import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const ALLOWED_KEYS = new Set(["contextPath", "question"]);
const VISIBLE_OUTPUT_LIMIT = 4096;

export type LambdaRlmParams = {
  contextPath: string;
  question: string;
};

type TextContent = { type: "text"; text: string };

export type LambdaRlmToolResult = {
  content: TextContent[];
  details: Record<string, unknown>;
};

export class LambdaRlmValidationError extends Error {
  readonly details: {
    ok: false;
    error: {
      type: "validation";
      code: string;
      message: string;
      field?: string;
    };
    fakeRun: { executionStarted: false };
  };

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "LambdaRlmValidationError";
    this.details = {
      ok: false,
      error: { type: "validation", code, message, ...(field ? { field } : {}) },
      fakeRun: { executionStarted: false },
    };
  }
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LambdaRlmValidationError("invalid_params", "lambda_rlm parameters must be an object.");
  }
}

export function validateLambdaRlmParams(value: unknown): LambdaRlmParams {
  assertPlainObject(value);

  const extraKeys = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (extraKeys.length > 0) {
    const ambiguous = extraKeys.some((key) => ["context", "prompt", "rawPrompt", "contextPaths", "path", "paths"].includes(key));
    throw new LambdaRlmValidationError(
      ambiguous ? "unsupported_input" : "unknown_keys",
      `lambda_rlm only accepts contextPath and question. Rejected key(s): ${extraKeys.join(", ")}.`,
    );
  }

  const contextPath = typeof value.contextPath === "string" ? value.contextPath.trim() : "";
  if (!contextPath) {
    throw new LambdaRlmValidationError("missing_context_path", "contextPath is required and must be a non-empty string.", "contextPath");
  }

  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question) {
    throw new LambdaRlmValidationError("missing_question", "question is required and must be a non-empty string.", "question");
  }

  return { contextPath, question };
}

async function loadContextFile(contextPath: string, cwd: string) {
  const normalizedPath = contextPath.startsWith("@") ? contextPath.slice(1) : contextPath;
  const resolvedPath = resolve(cwd, normalizedPath);

  try {
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      throw new LambdaRlmValidationError("unreadable_context_path", `contextPath is not a readable file: ${contextPath}`, "contextPath");
    }

    const content = await readFile(resolvedPath, "utf8");
    return { resolvedPath, content, bytes: fileStat.size };
  } catch (error) {
    if (error instanceof LambdaRlmValidationError) throw error;
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_context_path_file" : "unreadable_context_path";
    throw new LambdaRlmValidationError(code, `Unable to read contextPath before execution: ${contextPath}`, "contextPath");
  }
}

function boundedText(text: string) {
  if (text.length <= VISIBLE_OUTPUT_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, VISIBLE_OUTPUT_LIMIT - 80) + "\n[Fake λ-RLM output truncated to stay within tool bounds.]", truncated: true };
}

function countLines(text: string) {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

export async function executeLambdaRlmTool(params: unknown, options: { cwd?: string } = {}): Promise<LambdaRlmToolResult> {
  const validated = validateLambdaRlmParams(params);
  const cwd = options.cwd ?? process.cwd();
  const loaded = await loadContextFile(validated.contextPath, cwd);

  const rawAnswer = [
    "Fake λ-RLM answer",
    "",
    `Question: ${validated.question}`,
    "",
    `I read the referenced file internally (${loaded.content.length} characters, ${countLines(loaded.content)} lines) and would run Lambda-RLM here in a later slice.`,
    "This fake slice intentionally returns metadata only and does not expose source contents, raw prompts, Python bridge calls, or child Pi leaf calls.",
  ].join("\n");
  const answer = boundedText(rawAnswer);

  return {
    content: [{ type: "text", text: answer.text }],
    details: {
      ok: true,
      input: {
        source: "file",
        contextPath: validated.contextPath,
        resolvedContextPath: loaded.resolvedPath,
        contextChars: loaded.content.length,
        contextBytes: loaded.bytes,
        contextLines: countLines(loaded.content),
        questionChars: validated.question.length,
      },
      fakeRun: {
        engine: "fake-single-file-lambda-rlm",
        executionStarted: true,
        pythonBridge: false,
        realLambdaRlm: false,
        childPiLeafCalls: 0,
      },
      output: {
        bounded: true,
        visibleChars: answer.text.length,
        truncated: answer.truncated,
        maxVisibleChars: VISIBLE_OUTPUT_LIMIT,
      },
      warnings: ["Fake implementation for schema and context-budget validation only."],
    },
  };
}
