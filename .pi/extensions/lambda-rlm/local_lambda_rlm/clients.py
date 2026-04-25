"""Local/forked Lambda-RLM client seam.

Patch boundary: this minimal compatibility package is based on the Lambda-RLM
reference inspected at upstream commit 3874d393483dc4299101918cf8e9af670194bd88.
The intentional local patch is explicit BaseLM client injection in LambdaRLM.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ModelUsageSummary:
    total_calls: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cost: float | None = None


@dataclass
class UsageSummary:
    model_usage_summaries: dict[str, ModelUsageSummary] = field(default_factory=dict)


class BaseLM:
    """Subset of upstream Lambda-RLM's BaseLM interface used by LambdaRLM."""

    def completion(self, prompt: str | list[dict[str, Any]] | dict[str, Any]) -> str:
        raise NotImplementedError

    async def acompletion(self, prompt: str | list[dict[str, Any]] | dict[str, Any]) -> str:
        return self.completion(prompt)

    def get_usage_summary(self) -> UsageSummary:
        return UsageSummary()

    def get_last_usage(self) -> ModelUsageSummary:
        return ModelUsageSummary()


def get_client(backend: str, backend_kwargs: dict[str, Any] | None = None) -> BaseLM:
    """Preserve the upstream default-client selection path.

    The full provider clients are intentionally not vendored in this minimal local
    fork, so selecting the default path fails at provider configuration time
    rather than because injected-client support removed the path.
    """
    raise RuntimeError(
        "Default Lambda-RLM client path selected for backend "
        f"{backend!r}, but provider clients are not installed in this minimal "
        "local/forked compatibility package. Supply an injected BaseLM client "
        "for offline tests or install the full Lambda-RLM provider stack."
    )
