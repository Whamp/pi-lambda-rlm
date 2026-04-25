import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

EXTENSION_DIR = Path(__file__).resolve().parents[2] / ".pi" / "extensions" / "lambda-rlm"
sys.path.insert(0, str(EXTENSION_DIR))

import rlm.lambda_rlm as lambda_rlm_module
from rlm.clients import BaseLM
from rlm.core.types import ModelUsageSummary, UsageSummary
from rlm.lambda_rlm import LambdaRLM

UPSTREAM_COMMIT = "3874d393483dc4299101918cf8e9af670194bd88"


class DeterministicFakeBaseLM(BaseLM):
    def __init__(self):
        super().__init__(model_name="deterministic-fake")
        self.calls = []

    def completion(self, prompt):
        prompt_text = str(prompt)
        self.calls.append(
            {
                "prompt": prompt_text,
                "thread": threading.current_thread().name,
                "category": self._category(prompt_text),
            }
        )
        if "Single digit:" in prompt_text and "select the single most appropriate task type" in prompt_text:
            return "2"
        if "Does this excerpt contain information relevant" in prompt_text:
            return "YES"
        if "Using the following context, answer" in prompt_text:
            return "Partial answer: Ada Lovelace wrote notes about the Analytical Engine."
        if "Synthesise these partial answers" in prompt_text:
            return "Ada Lovelace wrote notes about the Analytical Engine."
        raise AssertionError(f"unexpected prompt: {prompt_text[:200]}")

    async def acompletion(self, prompt):
        return self.completion(prompt)

    def get_usage_summary(self):
        return UsageSummary(
            model_usage_summaries={
                self.model_name: ModelUsageSummary(
                    total_calls=len(self.calls),
                    total_input_tokens=0,
                    total_output_tokens=0,
                    total_cost=None,
                )
            }
        )

    def get_last_usage(self):
        return ModelUsageSummary(
            total_calls=1,
            total_input_tokens=0,
            total_output_tokens=0,
            total_cost=None,
        )

    def categories(self):
        return [call["category"] for call in self.calls]

    @staticmethod
    def _category(prompt):
        if "Single digit:" in prompt:
            return "task"
        if "Does this excerpt contain information relevant" in prompt:
            return "filter"
        if "Using the following context, answer" in prompt:
            return "leaf"
        if "Synthesise these partial answers" in prompt:
            return "reducer"
        return "unknown"


class MetadataAwareFakeBaseLM(BaseLM):
    def __init__(self):
        super().__init__(model_name="metadata-aware-fake")
        self.calls = []

    def completion(self, prompt):
        raise AssertionError("metadata-aware fake must be called via completion_with_metadata")

    def completion_with_metadata(self, prompt, metadata):
        prompt_text = str(prompt)
        self.calls.append(
            {
                "prompt": prompt_text,
                "metadata": dict(metadata),
                "thread": threading.current_thread().name,
            }
        )
        combinator = metadata.get("combinator")
        if combinator == "classifier":
            return "2"
        if combinator == "filter":
            return "YES"
        if combinator == "leaf":
            return "Partial answer from explicit leaf metadata."
        if combinator == "reduce":
            return "Final answer from explicit reducer metadata."
        raise AssertionError(f"unexpected metadata: {metadata!r}")

    async def acompletion(self, prompt):
        return self.completion(prompt)

    def get_usage_summary(self):
        return UsageSummary(
            model_usage_summaries={
                self.model_name: ModelUsageSummary(
                    total_calls=len(self.calls),
                    total_input_tokens=0,
                    total_output_tokens=0,
                    total_cost=None,
                )
            }
        )

    def get_last_usage(self):
        return ModelUsageSummary(
            total_calls=1,
            total_input_tokens=0,
            total_output_tokens=0,
            total_cost=None,
        )


class LambdaRLMInjectedClientTests(unittest.TestCase):
    def test_explicit_metadata_crosses_task_leaf_filter_and_reducer_without_prompt_text_inference(self):
        fake = MetadataAwareFakeBaseLM()
        context = " ".join([f"chunk {i} Ada Lovelace Analytical Engine metadata path." for i in range(20)])
        prompt = f"Context:\n{context}\n\nQuestion: Who is mentioned?\n\nAnswer:"

        with mock.patch.object(lambda_rlm_module, "_TASK_DETECTION_PROMPT", "OVERRIDDEN TASK DETECTION {metadata}"), \
             mock.patch.dict(lambda_rlm_module.TASK_TEMPLATES, {lambda_rlm_module.TaskType.QA: "OVERRIDDEN LEAF PROMPT query={query} text={text}"}), \
             mock.patch.object(lambda_rlm_module, "FILTER_RELEVANCE_TEMPLATE", "OVERRIDDEN FILTER query={query} preview={preview}"), \
             mock.patch.object(lambda_rlm_module, "SELECT_RELEVANT_REDUCER_TEMPLATE", "OVERRIDDEN REDUCER query={query} parts={parts}"):
            result = LambdaRLM(client=fake, context_window_chars=80).completion(prompt)

        self.assertEqual(result.response, "Final answer from explicit reducer metadata.")
        by_combinator = {call["metadata"]["combinator"] for call in fake.calls}
        self.assertGreaterEqual({"classifier", "filter", "leaf", "reduce"}, by_combinator)

        main_thread = threading.current_thread().name
        crossed_socket = {call["metadata"]["combinator"] for call in fake.calls if call["thread"] != main_thread}
        self.assertGreaterEqual({"filter", "leaf", "reduce"}, crossed_socket)

        for call in fake.calls:
            metadata = call["metadata"]
            self.assertEqual(metadata["source"], "lambda_rlm")
            self.assertIn("phase", metadata)
            self.assertIn("combinator", metadata)
            self.assertNotIn("source", call["prompt"])
            self.assertNotIn("combinator", call["prompt"])

        prompt_keys = {call["metadata"].get("promptKey") for call in fake.calls}
        self.assertIn("TASK-DETECTION-PROMPT.md", prompt_keys)
        self.assertIn("tasks/qa.md", prompt_keys)
        self.assertIn("filters/relevance.md", prompt_keys)
        self.assertIn("reducers/select_relevant.md", prompt_keys)

    def test_injected_base_lm_runs_upstream_local_repl_lmhandler_qa_filter_leaf_and_reduce(self):
        fake = DeterministicFakeBaseLM()
        context = " ".join(
            [
                "Ada Lovelace wrote notes about the Analytical Engine.",
                "Grace Hopper worked on compilers and programming languages.",
                "Katherine Johnson calculated trajectories for spaceflight.",
                "Margaret Hamilton led Apollo software engineering work.",
                "The Analytical Engine notes described algorithms and computation.",
            ]
        )
        prompt = f"Context:\n{context}\n\nQuestion: Who wrote notes about the Analytical Engine?\n\nAnswer:"

        result = LambdaRLM(client=fake, context_window_chars=80).completion(prompt)

        self.assertEqual(result.response, "Ada Lovelace wrote notes about the Analytical Engine.")
        categories = fake.categories()
        self.assertIn("task", categories)
        self.assertIn("filter", categories)
        self.assertIn("leaf", categories)
        self.assertIn("reducer", categories)
        self.assertGreater(categories.count("leaf"), 1)

        main_thread = threading.current_thread().name
        lmhandler_categories = {
            call["category"] for call in fake.calls if call["thread"] != main_thread
        }
        self.assertGreaterEqual({"filter", "leaf", "reducer"}, lmhandler_categories)
        self.assertEqual(result.metadata["patchBoundary"]["upstreamCommit"], UPSTREAM_COMMIT)
        self.assertEqual(result.metadata["patchBoundary"]["localPatch"], "optional BaseLM client injection and explicit model-call metadata")

    def test_default_client_path_delegates_to_upstream_factory_when_client_is_omitted(self):
        fake = DeterministicFakeBaseLM()
        with mock.patch.object(lambda_rlm_module, "get_client", return_value=fake) as get_client:
            LambdaRLM(backend="openai", backend_kwargs={"model_name": "gpt-test"}).completion(
                "Context:\nsmall\n\nQuestion: What?\n\nAnswer:"
            )

        get_client.assert_called_once_with("openai", {"model_name": "gpt-test"})

    def test_local_fork_documents_exact_upstream_commit_and_injection_patch_boundary(self):
        self.assertEqual(lambda_rlm_module.UPSTREAM_REFERENCE_COMMIT, UPSTREAM_COMMIT)
        self.assertIn("client: BaseLM | None = None", Path(lambda_rlm_module.__file__).read_text())
        self.assertIn("self.client or get_client(self.backend, self.backend_kwargs)", Path(lambda_rlm_module.__file__).read_text())

    def test_vendored_upstream_mit_license_notice_is_preserved(self):
        rlm_dir = Path(lambda_rlm_module.__file__).resolve().parent
        license_text = (rlm_dir / "LICENSE").read_text()
        local_fork_text = (rlm_dir / "LOCAL_FORK.md").read_text()

        self.assertIn("MIT License", license_text)
        self.assertIn("Copyright (c) 2026 Lambda-RLM Contributors", license_text)
        self.assertIn("Permission is hereby granted, free of charge", license_text)
        self.assertIn("The above copyright notice and this permission notice", license_text)
        self.assertIn("LICENSE", local_fork_text)


if __name__ == "__main__":
    unittest.main()
