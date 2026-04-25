#!/usr/bin/env python3
"""Lambda-RLM stdio NDJSON bridge.

stdout is protocol-only newline-delimited JSON. Diagnostics go to stderr.
The bridge runs vendored LambdaRLM with an injected BaseLM callback client;
each model request is synchronously serviced by the TypeScript extension over
stdin/stdout using request-identified model_callback_request/response messages.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

from rlm import LambdaRLM
from rlm.clients import BaseLM
from rlm.core.types import ModelUsageSummary, UsageSummary


# LocalREPL temporarily redirects sys.stdout while executing Φ. Protocol messages
# must bypass that capture even when emitted from LMHandler worker threads.
PROTOCOL_STDOUT = sys.stdout


def emit_stdout(message: dict[str, Any]) -> None:
    PROTOCOL_STDOUT.write(json.dumps(message, separators=(",", ":")) + "\n")
    PROTOCOL_STDOUT.flush()


def log(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def error_result(run_id: str | None, code: str, message: str, error_type: str = "protocol", **extra: Any) -> None:
    payload: dict[str, Any] = {
        "type": "run_result",
        "runId": run_id or "unknown",
        "ok": False,
        "error": {"type": error_type, "code": code, "message": message},
    }
    payload.update(extra)
    emit_stdout(payload)


def read_json_line(run_id: str | None = None) -> dict[str, Any] | None:
    line = sys.stdin.readline()
    if line == "":
        error_result(run_id, "missing_stdin_message", "Expected a bridge protocol message on stdin.")
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        error_result(run_id, "malformed_stdin_json", f"stdin line was not valid JSON: {exc.msg}")
        return None
    if not isinstance(value, dict):
        error_result(run_id, "invalid_stdin_message", "stdin message must be a JSON object.")
        return None
    return value


def normalize_prompt(prompt: str | dict[str, Any]) -> str:
    if isinstance(prompt, str):
        return prompt
    return json.dumps(prompt, ensure_ascii=False, sort_keys=True)


def prompt_metadata(prompt: str) -> dict[str, Any]:
    if "Single digit:" in prompt and "select the single most appropriate task type" in prompt:
        return {"phase": "task_detection", "promptKey": "lambda_rlm.task_detection"}
    if "Does this excerpt contain information relevant" in prompt:
        return {"phase": "filter", "promptKey": "lambda_rlm.filter.relevance"}
    if "Using the following context, answer" in prompt:
        return {"phase": "leaf", "promptKey": "lambda_rlm.tasks.qa"}
    if "Synthesise these partial answers" in prompt:
        return {"phase": "reducer", "promptKey": "lambda_rlm.reducers.select_relevant"}
    if "Merge these partial summaries" in prompt:
        return {"phase": "reducer", "promptKey": "lambda_rlm.reducers.merge_summaries"}
    return {"phase": "model_call", "promptKey": "lambda_rlm.unknown"}


class CallbackBaseLM(BaseLM):
    def __init__(self, run_id: str):
        super().__init__(model_name="pi-extension-callback")
        self.run_id = run_id
        self.call_count = 0
        self.last_usage = ModelUsageSummary(total_calls=0, total_input_tokens=0, total_output_tokens=0, total_cost=None)

    def completion(self, prompt: str | dict[str, Any]) -> str:
        prompt_text = normalize_prompt(prompt)
        self.call_count += 1
        request_id = f"model-call-{self.call_count}"
        emit_stdout(
            {
                "type": "model_callback_request",
                "runId": self.run_id,
                "requestId": request_id,
                "prompt": prompt_text,
                "metadata": {**prompt_metadata(prompt_text), "promptChars": len(prompt_text)},
            }
        )
        response = read_json_line(self.run_id)
        if response is None:
            raise RuntimeError("Missing model callback response.")
        if response.get("type") != "model_callback_response" or response.get("runId") != self.run_id or response.get("requestId") != request_id:
            raise RuntimeError(f"Expected model_callback_response for {request_id}.")
        if response.get("ok") is False:
            error = response.get("error") if isinstance(response.get("error"), dict) else {}
            message = error.get("message") if isinstance(error, dict) else None
            raise ModelCallbackFailure(message if isinstance(message, str) else "Model callback failed.", response)
        if response.get("ok") is not True or not isinstance(response.get("content"), str):
            raise RuntimeError("model_callback_response must be ok with string content.")
        content = response["content"]
        self.last_usage = ModelUsageSummary(
            total_calls=1,
            total_input_tokens=0,
            total_output_tokens=0,
            total_cost=None,
        )
        return content

    async def acompletion(self, prompt: str | dict[str, Any]) -> str:
        return self.completion(prompt)

    def get_usage_summary(self) -> UsageSummary:
        return UsageSummary(
            model_usage_summaries={
                self.model_name: ModelUsageSummary(
                    total_calls=self.call_count,
                    total_input_tokens=0,
                    total_output_tokens=0,
                    total_cost=None,
                )
            }
        )

    def get_last_usage(self) -> ModelUsageSummary:
        return self.last_usage


class ModelCallbackFailure(RuntimeError):
    def __init__(self, message: str, response: dict[str, Any]):
        super().__init__(message)
        self.response = response


def bridge_request_to_prompt(request: dict[str, Any]) -> tuple[str, str, int]:
    input_value = request.get("input")
    if not isinstance(input_value, dict):
        raise ValueError("run_request requires input object.")
    context_path = input_value.get("contextPath")
    question = input_value.get("question")
    if not isinstance(context_path, str) or not context_path:
        raise ValueError("run_request input.contextPath must be a non-empty string.")
    if not isinstance(question, str) or not question:
        raise ValueError("run_request input.question must be a non-empty string.")
    inline_context = input_value.get("context")
    context = inline_context if isinstance(inline_context, str) else Path(context_path).read_text(encoding="utf-8")
    prompt = f"Context:\n{context}\n\nQuestion: {question}\n\nAnswer:"
    lambda_rlm = request.get("lambdaRlm") if isinstance(request.get("lambdaRlm"), dict) else {}
    raw_context_window = lambda_rlm.get("contextWindowChars") if isinstance(lambda_rlm, dict) else None
    context_window = raw_context_window if isinstance(raw_context_window, int) and raw_context_window > 0 else 100_000
    return prompt, question, context_window


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit-malformed-stdout", action="store_true")
    parser.add_argument("--emit-second-callback", action="store_true")
    args = parser.parse_args()

    if args.emit_malformed_stdout:
        PROTOCOL_STDOUT.write("this is not json\n")
        PROTOCOL_STDOUT.flush()
        return 0

    request = read_json_line()
    if request is None:
        return 0
    if request.get("type") != "run_request":
        error_result(None, "invalid_run_request_type", "Expected a run_request message.")
        return 0
    run_id = request.get("runId")
    if not isinstance(run_id, str):
        error_result(None, "invalid_run_request", "run_request requires runId.")
        return 0

    if args.emit_second_callback:
        callback = {
            "type": "model_callback_request",
            "runId": run_id,
            "requestId": "model-call-1",
            "prompt": "first callback",
            "metadata": {"phase": "test"},
        }
        emit_stdout(callback)
        second = dict(callback)
        second["requestId"] = "model-call-2"
        emit_stdout(second)
        return 0

    try:
        prompt, question, context_window = bridge_request_to_prompt(request)
        log(f"bridge: received real Lambda-RLM run request {run_id}")
        client = CallbackBaseLM(run_id)
        result = LambdaRLM(client=client, query=question, context_window_chars=context_window).completion(prompt)
        emit_stdout(
            {
                "type": "run_result",
                "runId": run_id,
                "ok": True,
                "content": result.response,
                "modelCalls": client.call_count,
                "metadata": result.metadata or {},
            }
        )
        log(f"bridge: emitted final real Lambda-RLM run result {run_id}")
        return 0
    except ModelCallbackFailure as exc:
        error_result(
            run_id,
            "model_callback_failed",
            str(exc),
            "model_callback_failure",
            modelCalls=None,
            modelCallFailure=exc.response,
        )
        return 0
    except Exception as exc:  # keep stdout structured; diagnostics only on stderr
        log(traceback.format_exc())
        error_result(run_id, "lambda_rlm_failed", str(exc), "runtime")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
