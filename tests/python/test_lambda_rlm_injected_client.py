import sys
import unittest
from pathlib import Path

EXTENSION_DIR = Path(__file__).resolve().parents[2] / ".pi" / "extensions" / "lambda-rlm"
sys.path.insert(0, str(EXTENSION_DIR))

from local_lambda_rlm import LambdaRLM
from local_lambda_rlm.clients import BaseLM


class DeterministicFakeBaseLM(BaseLM):
    def __init__(self):
        self.prompts = []

    def completion(self, prompt):
        self.prompts.append(prompt)
        prompt_text = str(prompt)
        if "Classify the task" in prompt_text:
            return "2"
        if "Is the following text relevant" in prompt_text:
            return "YES"
        if "Answer the question using only this text chunk" in prompt_text:
            if "Ada Lovelace" in prompt_text:
                return "Ada Lovelace wrote notes about the Analytical Engine."
            return "No answer found in this chunk."
        if "Synthesize the relevant partial answers" in prompt_text:
            return "Ada Lovelace wrote notes about the Analytical Engine."
        self.fail(f"unexpected prompt: {prompt_text[:100]}")


class LambdaRLMInjectedClientTests(unittest.TestCase):
    def test_injected_base_lm_drives_real_lambda_rlm_qa_planning_filter_leaf_and_reduce(self):
        fake = DeterministicFakeBaseLM()
        context = " ".join([
            "Ada Lovelace wrote notes about the Analytical Engine.",
            "Grace Hopper worked on compilers.",
            "Katherine Johnson calculated trajectories.",
            "Margaret Hamilton led Apollo software.",
        ])
        prompt = f"Context:\n{context}\n\nQuestion: Who wrote notes about the Analytical Engine?\n\nAnswer:"

        result = LambdaRLM(client=fake, context_window_chars=80).completion(prompt)

        self.assertEqual(result.response, "Ada Lovelace wrote notes about the Analytical Engine.")
        prompts = "\n---\n".join(fake.prompts)
        self.assertGreaterEqual(len(fake.prompts), 4)
        self.assertIn("Classify the task", prompts)
        self.assertIn("Is the following text relevant", prompts)
        self.assertIn("Answer the question using only this text chunk", prompts)
        self.assertIn("Synthesize the relevant partial answers", prompts)
        self.assertEqual(result.metadata["patchBoundary"]["upstreamCommit"], "3874d393483dc4299101918cf8e9af670194bd88")
        self.assertEqual(result.metadata["plan"]["task_type"], "qa")
        self.assertGreater(result.metadata["model_calls"]["leaf"], 1)

    def test_default_client_path_remains_available_without_injected_client(self):
        with self.assertRaisesRegex(RuntimeError, "Default Lambda-RLM client path selected"):
            LambdaRLM(backend="openai", backend_kwargs={}).completion("Context:\nsmall\n\nQuestion: What?\n\nAnswer:")


if __name__ == "__main__":
    unittest.main()
