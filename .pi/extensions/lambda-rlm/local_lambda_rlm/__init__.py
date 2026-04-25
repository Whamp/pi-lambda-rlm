"""Local/forked Lambda-RLM compatibility boundary for the Pi extension.

Based on upstream lambda-RLM commit 3874d393483dc4299101918cf8e9af670194bd88.
This package intentionally vendors only the deterministic LambdaRLM planner /
executor surface needed by the Pi integration slice, plus the local patch for
explicit BaseLM client injection.
"""

from .clients import BaseLM, ModelUsageSummary, UsageSummary
from .lambda_rlm import LambdaPlan, LambdaRLM, RLMChatCompletion

__all__ = [
    "BaseLM",
    "LambdaPlan",
    "LambdaRLM",
    "ModelUsageSummary",
    "RLMChatCompletion",
    "UsageSummary",
]
