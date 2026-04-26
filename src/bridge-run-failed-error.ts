import {
  sanitizeLeafFailureDetails,
  sanitizeLocalLeafFailureDetails,
  summarizeStdoutLines,
  summarizeTextDiagnostic,
} from "./diagnostics.js";
import type { LeafModelCallFailureDetails } from "./leaf-runner.js";
import type {
  BridgeFailedRunResult,
  BridgeProgressEvent,
  BridgeTimelineEvent,
  ModelCallbackResponse,
} from "./bridge-runner.js";

export class BridgeRunFailedError extends Error {
  readonly details: {
    ok: false;
    error: { type: "runtime"; code: string; message: string };
    failedRunResult: BridgeFailedRunResult;
    diagnostics: {
      stderr: ReturnType<typeof summarizeTextDiagnostic>;
      stdout: ReturnType<typeof summarizeStdoutLines>;
    };
    modelCallResponses: ModelCallbackResponse[];
    finalResults: number;
    progressEvents: BridgeProgressEvent[];
    timeline: BridgeTimelineEvent[];
  };

  constructor(
    failedRunResult: BridgeFailedRunResult,
    diagnostics: { stderr: string; stdoutLines: string[] },
    modelCallResponses: ModelCallbackResponse[],
    finalResults = 0,
    telemetry: { progressEvents?: BridgeProgressEvent[]; timeline?: BridgeTimelineEvent[] } = {},
  ) {
    super(failedRunResult.error.message);
    this.name = "BridgeRunFailedError";
    const localFailure = failedRunResult.modelCallFailure
      ? modelCallResponses.find(
          (response): response is LeafModelCallFailureDetails =>
            !response.ok && response.requestId === failedRunResult.modelCallFailure?.requestId,
        )
      : undefined;
    const sanitizedFailedRunResult = {
      ...failedRunResult,
      ...(failedRunResult.modelCallFailure
        ? {
            modelCallFailure:
              localFailure ?? sanitizeLeafFailureDetails(failedRunResult.modelCallFailure),
          }
        : {}),
    };
    this.details = {
      diagnostics: {
        stderr: summarizeTextDiagnostic(diagnostics.stderr),
        stdout: summarizeStdoutLines(diagnostics.stdoutLines),
      },
      error: {
        code: sanitizedFailedRunResult.error.code,
        message: sanitizedFailedRunResult.error.message,
        type: "runtime",
      },
      failedRunResult: sanitizedFailedRunResult,
      finalResults,
      modelCallResponses: modelCallResponses.map((response) =>
        response.ok ? response : sanitizeLocalLeafFailureDetails(response),
      ),
      ok: false,
      progressEvents: telemetry.progressEvents ?? [],
      timeline: telemetry.timeline ?? [],
    };
  }
}
