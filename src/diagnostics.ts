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

export function sanitizeLeafFailureDetails(details: LeafModelCallFailureDetails): LeafModelCallFailureDetails {
  return {
    ...details,
    diagnostics: {
      stdout: "",
      stderr: "",
      exitCode: details.diagnostics.exitCode,
      ...(details.diagnostics.signal !== undefined ? { signal: details.diagnostics.signal } : {}),
      stdoutBytes: typeof (details.diagnostics as Record<string, unknown>).stdoutBytes === "number" ? ((details.diagnostics as Record<string, unknown>).stdoutBytes as number) : Buffer.byteLength(details.diagnostics.stdout, "utf8"),
      stdoutSha256: typeof (details.diagnostics as Record<string, unknown>).stdoutSha256 === "string" ? ((details.diagnostics as Record<string, unknown>).stdoutSha256 as string) : diagnosticHash(details.diagnostics.stdout),
      stderrBytes: typeof (details.diagnostics as Record<string, unknown>).stderrBytes === "number" ? ((details.diagnostics as Record<string, unknown>).stderrBytes as number) : Buffer.byteLength(details.diagnostics.stderr, "utf8"),
      stderrSha256: typeof (details.diagnostics as Record<string, unknown>).stderrSha256 === "string" ? ((details.diagnostics as Record<string, unknown>).stderrSha256 as string) : diagnosticHash(details.diagnostics.stderr),
    } as LeafModelCallFailureDetails["diagnostics"],
  };
}
