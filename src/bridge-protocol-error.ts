import { summarizeStdoutLines, summarizeTextDiagnostic } from "./diagnostics.js";

export class BridgeProtocolError extends Error {
  readonly details: {
    ok: false;
    error: { type: "protocol"; code: string; message: string; line?: string };
    diagnostics: {
      stderr: ReturnType<typeof summarizeTextDiagnostic>;
      stdout: ReturnType<typeof summarizeStdoutLines>;
      offendingLine?: ReturnType<typeof summarizeTextDiagnostic>;
    };
    finalResults?: number;
  };

  constructor(
    code: string,
    message: string,
    diagnostics: { stderr: string; stdoutLines: string[]; line?: string; finalResults?: number },
  ) {
    super(message);
    this.name = "BridgeProtocolError";
    this.details = {
      diagnostics: {
        stderr: summarizeTextDiagnostic(diagnostics.stderr),
        stdout: summarizeStdoutLines(diagnostics.stdoutLines),
        ...(diagnostics.line ? { offendingLine: summarizeTextDiagnostic(diagnostics.line) } : {}),
      },
      error: { code, message, type: "protocol" },
      ok: false,
      ...(diagnostics.finalResults === undefined ? {} : { finalResults: diagnostics.finalResults }),
    };
  }
}
