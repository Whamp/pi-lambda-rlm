import { createHash } from "node:crypto";
import type { LeafModelCallFailureDetails } from "./leafRunner.js";

export function diagnosticHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function summarizeTextDiagnostic(text: string) {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    chars: text.length,
    sha256: diagnosticHash(text),
  };
}

export function summarizeStdoutLines(lines: string[]) {
  const joined = lines.join("\n");
  return {
    lines: lines.length,
    bytes: Buffer.byteLength(joined, "utf8"),
    sha256: diagnosticHash(joined),
  };
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_SIGNAL = /^[A-Z][A-Z0-9_]{0,31}$/;

function safeNonnegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeSha256(value: unknown, fallbackText: string): string {
  return typeof value === "string" && SHA256_HEX.test(value) ? value : diagnosticHash(fallbackText);
}

function safeSignal(value: unknown): NodeJS.Signals | string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && SAFE_SIGNAL.test(value)) return value;
  return undefined;
}

function safeTextField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= 500 ? value : fallback;
}

function redactRawDiagnostics(message: string, stdout: string, stderr: string): string {
  let redacted = message;
  for (const raw of [stdout, stderr]) {
    if (raw) redacted = redacted.split(raw).join("[redacted child output]");
  }
  return redacted;
}

export function sanitizeLeafFailureDetails(details: LeafModelCallFailureDetails): LeafModelCallFailureDetails {
  const diagnostics = details.diagnostics as Record<string, unknown>;
  const stdout = typeof details.diagnostics.stdout === "string" ? details.diagnostics.stdout : "";
  const stderr = typeof details.diagnostics.stderr === "string" ? details.diagnostics.stderr : "";
  const signal = safeSignal(diagnostics.signal);
  const error = details.error as Record<string, unknown>;
  const message = redactRawDiagnostics(safeTextField(error.message, "Child process failed."), stdout, stderr);

  return {
    ok: false,
    requestId: safeTextField(details.requestId, "unknown"),
    error: {
      type: "child_process",
      code: safeTextField(error.code, "child_process_failed"),
      message,
    },
    diagnostics: {
      stdout: "",
      stderr: "",
      exitCode: typeof diagnostics.exitCode === "number" || diagnostics.exitCode === null ? diagnostics.exitCode : null,
      ...(signal !== undefined ? { signal } : {}),
      stdoutBytes: safeNonnegativeInteger(diagnostics.stdoutBytes, Buffer.byteLength(stdout, "utf8")),
      stdoutSha256: safeSha256(diagnostics.stdoutSha256, stdout),
      stderrBytes: safeNonnegativeInteger(diagnostics.stderrBytes, Buffer.byteLength(stderr, "utf8")),
      stderrSha256: safeSha256(diagnostics.stderrSha256, stderr),
    } as LeafModelCallFailureDetails["diagnostics"],
  };
}
