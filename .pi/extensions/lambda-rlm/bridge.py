#!/usr/bin/env python3
"""Synthetic Lambda-RLM stdio NDJSON bridge tracer bullet.

stdout is protocol-only newline-delimited JSON. Diagnostics go to stderr.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def emit_stdout(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def error_result(run_id: str | None, code: str, message: str) -> None:
    emit_stdout(
        {
            "type": "run_result",
            "runId": run_id or "unknown",
            "ok": False,
            "error": {"type": "protocol", "code": code, "message": message},
        }
    )


def read_json_line() -> dict[str, Any] | None:
    line = sys.stdin.readline()
    if line == "":
        error_result(None, "missing_run_request", "Expected one run_request line on stdin.")
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        error_result(None, "malformed_stdin_json", f"stdin line was not valid JSON: {exc.msg}")
        return None
    if not isinstance(value, dict):
        error_result(None, "invalid_stdin_message", "stdin message must be a JSON object.")
        return None
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit-malformed-stdout", action="store_true")
    parser.add_argument("--emit-second-callback", action="store_true")
    args = parser.parse_args()

    if args.emit_malformed_stdout:
        sys.stdout.write("this is not json\n")
        sys.stdout.flush()
        return 0

    request = read_json_line()
    if request is None:
        return 0

    if request.get("type") != "run_request":
        error_result(None, "invalid_run_request_type", "Expected a run_request message.")
        return 0
    run_id = request.get("runId")
    input_value = request.get("input")
    if not isinstance(run_id, str) or not isinstance(input_value, dict):
        error_result(run_id if isinstance(run_id, str) else None, "invalid_run_request", "run_request requires runId and input object.")
        return 0

    question = input_value.get("question")
    if not isinstance(question, str) or question == "":
        error_result(run_id, "invalid_run_request", "run_request input.question must be a non-empty string.")
        return 0

    log(f"bridge: received run request {run_id}")
    callback = {
        "type": "model_callback_request",
        "runId": run_id,
        "requestId": "model-call-1",
        "prompt": f"Synthetic Lambda-RLM callback for question: {question}",
        "metadata": {"phase": "synthetic", "promptKey": "synthetic.tracer"},
    }
    emit_stdout(callback)
    if args.emit_second_callback:
        second = dict(callback)
        second["requestId"] = "model-call-2"
        emit_stdout(second)

    response = read_json_line()
    if response is None:
        return 0
    if response.get("type") != "model_callback_response" or response.get("runId") != run_id or response.get("requestId") != "model-call-1":
        error_result(run_id, "invalid_model_callback_response", "Expected model_callback_response for model-call-1.")
        return 0
    if response.get("ok") is False:
        error = response.get("error") if isinstance(response.get("error"), dict) else {}
        message = error.get("message") if isinstance(error, dict) else None
        emit_stdout(
            {
                "type": "run_result",
                "runId": run_id,
                "ok": False,
                "error": {
                    "type": "model_callback_failure",
                    "code": "model_callback_failed",
                    "message": message if isinstance(message, str) else "Model callback failed.",
                },
                "modelCalls": 1,
            }
        )
        return 0
    if response.get("ok") is not True or not isinstance(response.get("content"), str):
        error_result(run_id, "invalid_model_callback_response", "model_callback_response must be ok with string content.")
        return 0

    emit_stdout({"type": "run_result", "runId": run_id, "ok": True, "content": response["content"], "modelCalls": 1})
    log(f"bridge: emitted final run result {run_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
