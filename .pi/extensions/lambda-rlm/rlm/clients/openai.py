import os
from collections import defaultdict
from typing import Any

import openai
from dotenv import load_dotenv

from rlm.clients.base_lm import BaseLM
from rlm.core.types import ModelUsageSummary, UsageSummary

load_dotenv()

# Load API keys from environment variables
DEFAULT_OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
DEFAULT_OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
DEFAULT_VERCEL_API_KEY = os.getenv("AI_GATEWAY_API_KEY")
DEFAULT_PRIME_API_KEY = os.getenv("PRIME_API_KEY")
DEFAULT_NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY")
DEFAULT_PRIME_INTELLECT_BASE_URL = "https://api.pinference.ai/api/v1/"
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"

# Kwargs that belong on chat.completions.create(), not on the OpenAI() constructor.
_COMPLETION_CALL_KWARGS = frozenset({"temperature", "top_p", "max_tokens", "stream"})


class OpenAIClient(BaseLM):
    """
    LM Client for running models with the OpenAI API. Works with vLLM, NVIDIA NIM,
    OpenRouter, and any OpenAI-compatible endpoint.

    Completion-time parameters (temperature, top_p, max_tokens, stream) can be
    passed as constructor kwargs and are forwarded to chat.completions.create().
    All other additional kwargs are forwarded to the openai.OpenAI() constructor.

    Streaming mode (stream=True):
      Responses are collected chunk-by-chunk. For thinking models that emit a
      `reasoning_content` field (e.g. NVIDIA qwen3-thinking), reasoning tokens are
      silently discarded and only the final answer content is returned.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model_name: str | None = None,
        base_url: str | None = None,
        **kwargs,
    ):
        super().__init__(model_name=model_name, **kwargs)

        if api_key is None:
            if base_url == "https://api.openai.com/v1" or base_url is None:
                api_key = DEFAULT_OPENAI_API_KEY
            elif base_url == "https://openrouter.ai/api/v1":
                api_key = DEFAULT_OPENROUTER_API_KEY
            elif base_url == "https://ai-gateway.vercel.sh/v1":
                api_key = DEFAULT_VERCEL_API_KEY
            elif base_url == DEFAULT_PRIME_INTELLECT_BASE_URL:
                api_key = DEFAULT_PRIME_API_KEY
            elif base_url == NVIDIA_BASE_URL:
                api_key = DEFAULT_NVIDIA_API_KEY

        # Split kwargs: completion-call params vs OpenAI-constructor params.
        self._completion_kwargs: dict[str, Any] = {
            k: v for k, v in self.kwargs.items() if k in _COMPLETION_CALL_KWARGS
        }
        constructor_kwargs = {
            k: v for k, v in self.kwargs.items()
            if k not in _COMPLETION_CALL_KWARGS and k != "model_name"
        }

        client_kwargs = {
            "api_key": api_key,
            "base_url": base_url,
            "timeout": self.timeout,
            **constructor_kwargs,
        }
        self.client = openai.OpenAI(**client_kwargs)
        self.async_client = openai.AsyncOpenAI(**client_kwargs)
        self.model_name = model_name
        self.base_url = base_url  # Track for cost extraction

        # Per-model usage tracking
        self.model_call_counts: dict[str, int] = defaultdict(int)
        self.model_input_tokens: dict[str, int] = defaultdict(int)
        self.model_output_tokens: dict[str, int] = defaultdict(int)
        self.model_total_tokens: dict[str, int] = defaultdict(int)
        self.model_costs: dict[str, float] = defaultdict(float)  # Cost in USD

    def completion(self, prompt: str | list[dict[str, Any]], model: str | None = None) -> str:
        if isinstance(prompt, str):
            messages = [{"role": "user", "content": prompt}]
        elif isinstance(prompt, list) and all(isinstance(item, dict) for item in prompt):
            messages = prompt
        else:
            raise ValueError(f"Invalid prompt type: {type(prompt)}")

        model = model or self.model_name
        if not model:
            raise ValueError("Model name is required for OpenAI client.")

        extra_body = {}
        if self.client.base_url == DEFAULT_PRIME_INTELLECT_BASE_URL:
            extra_body["usage"] = {"include": True}

        use_stream = self._completion_kwargs.get("stream", False)
        call_kwargs = {k: v for k, v in self._completion_kwargs.items() if k != "stream"}

        if use_stream:
            return self._completion_streaming(model, messages, extra_body, call_kwargs)

        response = self.client.chat.completions.create(
            model=model, messages=messages, extra_body=extra_body, **call_kwargs
        )
        self._track_cost(response, model)
        return response.choices[0].message.content

    def _completion_streaming(
        self,
        model: str,
        messages: list[dict[str, Any]],
        extra_body: dict,
        call_kwargs: dict,
    ) -> str:
        """Collect a streaming response, skipping reasoning_content tokens."""
        content_parts: list[str] = []
        prompt_tokens = 0
        completion_tokens = 0

        stream = self.client.chat.completions.create(
            model=model, messages=messages, extra_body=extra_body,
            stream=True, **call_kwargs
        )
        for chunk in stream:
            if not chunk.choices:
                # Last chunk may carry usage data
                usage = getattr(chunk, "usage", None)
                if usage:
                    prompt_tokens     = getattr(usage, "prompt_tokens", 0)
                    completion_tokens = getattr(usage, "completion_tokens", 0)
                continue
            delta = chunk.choices[0].delta
            # Collect only the final answer content; skip reasoning_content.
            if delta.content:
                content_parts.append(delta.content)
            # Capture usage from the last content chunk if present.
            usage = getattr(chunk, "usage", None)
            if usage:
                prompt_tokens     = getattr(usage, "prompt_tokens", 0) or prompt_tokens
                completion_tokens = getattr(usage, "completion_tokens", 0) or completion_tokens

        self._track_usage(model, prompt_tokens, completion_tokens)
        return "".join(content_parts)

    async def acompletion(
        self, prompt: str | list[dict[str, Any]], model: str | None = None
    ) -> str:
        if isinstance(prompt, str):
            messages = [{"role": "user", "content": prompt}]
        elif isinstance(prompt, list) and all(isinstance(item, dict) for item in prompt):
            messages = prompt
        else:
            raise ValueError(f"Invalid prompt type: {type(prompt)}")

        model = model or self.model_name
        if not model:
            raise ValueError("Model name is required for OpenAI client.")

        extra_body = {}
        if self.client.base_url == DEFAULT_PRIME_INTELLECT_BASE_URL:
            extra_body["usage"] = {"include": True}

        call_kwargs = {k: v for k, v in self._completion_kwargs.items() if k != "stream"}

        response = await self.async_client.chat.completions.create(
            model=model, messages=messages, extra_body=extra_body, **call_kwargs
        )
        self._track_cost(response, model)
        return response.choices[0].message.content

    def _track_usage(self, model: str, prompt_tokens: int, completion_tokens: int) -> None:
        """Track usage when only raw token counts are available (streaming)."""
        self.model_call_counts[model] += 1
        self.model_input_tokens[model]  += prompt_tokens
        self.model_output_tokens[model] += completion_tokens
        self.model_total_tokens[model]  += prompt_tokens + completion_tokens
        self.last_prompt_tokens     = prompt_tokens
        self.last_completion_tokens = completion_tokens
        self.last_cost: float | None = None

    def _track_cost(self, response: openai.ChatCompletion, model: str):
        self.model_call_counts[model] += 1

        usage = getattr(response, "usage", None)
        if usage is None:
            raise ValueError("No usage data received. Tracking tokens not possible.")

        self.model_input_tokens[model] += usage.prompt_tokens
        self.model_output_tokens[model] += usage.completion_tokens
        self.model_total_tokens[model] += usage.total_tokens

        # Track last call for handler to read
        self.last_prompt_tokens = usage.prompt_tokens
        self.last_completion_tokens = usage.completion_tokens

        # Extract cost from OpenRouter responses (cost is in USD)
        # OpenRouter returns cost in usage.model_extra for pydantic models
        self.last_cost: float | None = None
        cost = None

        # Try direct attribute first
        if hasattr(usage, "cost") and usage.cost:
            cost = usage.cost
        # Then try model_extra (OpenRouter uses this)
        elif hasattr(usage, "model_extra") and usage.model_extra:
            extra = usage.model_extra
            # Primary cost field (may be 0 for BYOK)
            if extra.get("cost"):
                cost = extra["cost"]
            # Fallback to upstream cost details
            elif extra.get("cost_details", {}).get("upstream_inference_cost"):
                cost = extra["cost_details"]["upstream_inference_cost"]

        if cost is not None and cost > 0:
            self.last_cost = float(cost)
            self.model_costs[model] += self.last_cost

    def get_usage_summary(self) -> UsageSummary:
        model_summaries = {}
        for model in self.model_call_counts:
            cost = self.model_costs.get(model)
            model_summaries[model] = ModelUsageSummary(
                total_calls=self.model_call_counts[model],
                total_input_tokens=self.model_input_tokens[model],
                total_output_tokens=self.model_output_tokens[model],
                total_cost=cost if cost else None,
            )
        return UsageSummary(model_usage_summaries=model_summaries)

    def get_last_usage(self) -> ModelUsageSummary:
        return ModelUsageSummary(
            total_calls=1,
            total_input_tokens=self.last_prompt_tokens,
            total_output_tokens=self.last_completion_tokens,
            total_cost=getattr(self, "last_cost", None),
        )
