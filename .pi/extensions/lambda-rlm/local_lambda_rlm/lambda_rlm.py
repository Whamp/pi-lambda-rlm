"""Minimal local/forked Lambda-RLM deterministic planner/executor.

Patch boundary: based on lambda-RLM upstream commit
3874d393483dc4299101918cf8e9af670194bd88. The intentionally carried local
integration patch is the optional ``client: BaseLM`` constructor argument. When a
client is supplied, task detection, QA relevance filters, leaf answers, and
LLM-backed reducers all use that exact BaseLM instance. When no client is
supplied, the default ``get_client(backend, backend_kwargs)`` path is still
selected.

This file preserves the real LambdaRLM algorithmic shape needed by the Pi MVP:
classify task -> compute deterministic plan -> split -> optional filter -> map
Phi over chunks -> reduce. It deliberately excludes provider SDK clients and the
research LocalREPL sandbox so tests pass offline and the local/fork boundary is
small and reviewable.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from math import ceil, log, sqrt
import re
import time
from typing import Any

from .clients import BaseLM, UsageSummary, get_client

UPSTREAM_REFERENCE_COMMIT = "3874d393483dc4299101918cf8e9af670194bd88"


class TaskType(str, Enum):
    SUMMARIZATION = "summarization"
    QA = "qa"
    TRANSLATION = "translation"
    CLASSIFICATION = "classification"
    EXTRACTION = "extraction"
    ANALYSIS = "analysis"
    GENERAL = "general"


class ComposeOp(str, Enum):
    MERGE_SUMMARIES = "merge_summaries"
    SELECT_RELEVANT = "select_relevant"
    CONCATENATE = "concatenate"
    MAJORITY_VOTE = "majority_vote"
    MERGE_EXTRACTIONS = "merge_extractions"
    COMBINE_ANALYSIS = "combine_analysis"


@dataclass
class LambdaPlan:
    task_type: TaskType
    compose_op: ComposeOp
    pipeline: list[str]
    k_star: int
    tau_star: int
    depth: int
    cost_estimate: float
    n: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_type": self.task_type.value,
            "compose_op": self.compose_op.value,
            "pipeline": self.pipeline,
            "k_star": self.k_star,
            "tau_star": self.tau_star,
            "depth": self.depth,
            "cost_estimate": self.cost_estimate,
            "n": self.n,
        }


@dataclass
class RLMChatCompletion:
    root_model: str
    prompt: str | dict[str, Any]
    response: str
    usage_summary: UsageSummary
    execution_time: float
    metadata: dict[str, Any] | None = None


_TASK_DIGIT_MAP = {
    "1": TaskType.SUMMARIZATION,
    "2": TaskType.QA,
    "3": TaskType.TRANSLATION,
    "4": TaskType.CLASSIFICATION,
    "5": TaskType.EXTRACTION,
    "6": TaskType.ANALYSIS,
    "7": TaskType.GENERAL,
}

_COMPOSE_FOR_TASK = {
    TaskType.SUMMARIZATION: ComposeOp.MERGE_SUMMARIES,
    TaskType.QA: ComposeOp.SELECT_RELEVANT,
    TaskType.TRANSLATION: ComposeOp.CONCATENATE,
    TaskType.CLASSIFICATION: ComposeOp.MAJORITY_VOTE,
    TaskType.EXTRACTION: ComposeOp.MERGE_EXTRACTIONS,
    TaskType.ANALYSIS: ComposeOp.COMBINE_ANALYSIS,
    TaskType.GENERAL: ComposeOp.MERGE_SUMMARIES,
}

_C_COMPOSE = {
    ComposeOp.MERGE_SUMMARIES: 0.25,
    ComposeOp.SELECT_RELEVANT: 0.25,
    ComposeOp.CONCATENATE: 0.0,
    ComposeOp.MAJORITY_VOTE: 0.0,
    ComposeOp.MERGE_EXTRACTIONS: 0.05,
    ComposeOp.COMBINE_ANALYSIS: 0.25,
}

_TASK_DETECTION_PROMPT = """Classify the task for Lambda-RLM.
Return exactly one digit:
1 summarization
2 qa
3 translation
4 classification
5 extraction
6 analysis
7 general

Metadata:
{metadata}
"""


class LambdaRLM:
    def __init__(
        self,
        backend: str = "openai",
        backend_kwargs: dict[str, Any] | None = None,
        environment: str = "local",
        environment_kwargs: dict[str, Any] | None = None,
        context_window_chars: int = 100_000,
        accuracy_target: float = 0.80,
        a_leaf: float = 0.95,
        a_compose: float = 0.90,
        query: str | None = None,
        verbose: bool = False,
        logger: Any | None = None,
        client: BaseLM | None = None,
    ) -> None:
        self.backend = backend
        self.backend_kwargs = backend_kwargs or {}
        self.environment = environment
        self.environment_kwargs = environment_kwargs or {}
        self.context_window_chars = context_window_chars
        self.accuracy_target = accuracy_target
        self.a_leaf = a_leaf
        self.a_compose = a_compose
        self.query = query
        self.verbose = verbose
        self.logger = logger
        self.client = client
        self.model_call_counts = {"task": 0, "filter": 0, "leaf": 0, "reducer": 0}

    def completion(self, prompt: str) -> RLMChatCompletion:
        if not isinstance(prompt, str):
            raise TypeError("LambdaRLM.completion prompt must be a string")
        start = time.monotonic()
        client = self.client if self.client is not None else get_client(self.backend, self.backend_kwargs)
        context_text, effective_query = self._parse_prompt(prompt)
        task_type = self._detect_task(client, context_text, effective_query)
        plan = self._plan(task_type, len(context_text), bool(effective_query))
        response = self._phi(client, context_text, effective_query, plan)
        return RLMChatCompletion(
            root_model=self.backend,
            prompt=prompt,
            response=response,
            usage_summary=client.get_usage_summary(),
            execution_time=time.monotonic() - start,
            metadata={
                "plan": plan.to_dict(),
                "model_calls": dict(self.model_call_counts),
                "patchBoundary": {
                    "package": "local_lambda_rlm",
                    "upstreamCommit": UPSTREAM_REFERENCE_COMMIT,
                    "localPatch": "optional BaseLM client injection; provider clients intentionally not vendored",
                },
            },
        )

    def _parse_prompt(self, prompt: str) -> tuple[str, str | None]:
        if self.query is not None:
            return prompt, self.query
        match = re.search(r"Context:\s*(.*?)\s*Question:\s*(.*?)\s*Answer:\s*$", prompt, re.S | re.I)
        if not match:
            return prompt, None
        return match.group(1).strip(), match.group(2).strip()

    def _detect_task(self, client: BaseLM, context_text: str, query: str | None) -> TaskType:
        metadata = f"total_chars={len(context_text)}\nquery={query or ''}\npreview={context_text[:500]}"
        self.model_call_counts["task"] += 1
        result = client.completion(_TASK_DETECTION_PROMPT.format(metadata=metadata))
        for char in str(result):
            if char in _TASK_DIGIT_MAP:
                return _TASK_DIGIT_MAP[char]
        return TaskType.GENERAL

    def _plan(self, task_type: TaskType, n: int, has_query: bool) -> LambdaPlan:
        compose_op = _COMPOSE_FOR_TASK[task_type]
        pipeline = ["split"]
        if task_type in (TaskType.QA, TaskType.EXTRACTION) and has_query:
            pipeline.append("filter")
        pipeline.extend(["map", "reduce"])
        k = self.context_window_chars
        if n <= k:
            return LambdaPlan(task_type, compose_op, pipeline, 1, n, 0, n + 500, n)
        c_compose = _C_COMPOSE[compose_op]
        if c_compose > 0.1:
            k_star = min(20, max(2, ceil(sqrt(n / c_compose))))
        else:
            k_star = min(20, max(2, ceil(n / k)))
        depth = max(1, ceil(log(n / k) / log(k_star)))
        max_k = max(k_star, n // max(k, 1))
        while (self.a_leaf ** depth) * (self.a_compose ** depth) < self.accuracy_target and k_star < max_k:
            k_star += 1
            depth = max(1, ceil(log(n / k) / log(k_star)))
        tau_star = min(k, max(1, n // k_star))
        cost = (k_star**depth) * tau_star + depth * c_compose * k_star + 500
        return LambdaPlan(task_type, compose_op, pipeline, k_star, tau_star, depth, cost, n)

    def _phi(self, client: BaseLM, text: str, query: str | None, plan: LambdaPlan) -> str:
        if len(text) <= plan.tau_star:
            return self._leaf(client, text, query, plan.task_type)
        chunks = self._split(text, plan.k_star)
        if "filter" in plan.pipeline and query:
            chunks = self._filter_relevant(client, query, chunks)
        return self._reduce(client, [self._phi(client, chunk, query, plan) for chunk in chunks], plan.compose_op, query)

    def _split(self, text: str, k: int) -> list[str]:
        if k <= 1 or len(text) <= 1:
            return [text]
        chunk_size = max(1, ceil(len(text) / k))
        chunks = []
        start = 0
        while start < len(text):
            end = min(len(text), start + chunk_size)
            if end < len(text):
                snap = text.rfind(" ", start + max(1, chunk_size // 2), end + 1)
                if snap > start:
                    end = snap
            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)
            start = max(end + 1, start + 1)
        return chunks

    def _filter_relevant(self, client: BaseLM, query: str, chunks: list[str]) -> list[str]:
        relevant = []
        for chunk in chunks:
            self.model_call_counts["filter"] += 1
            answer = client.completion(
                "Is the following text relevant to the question? Answer YES or NO.\n"
                f"Question: {query}\nText preview: {chunk[:700]}"
            )
            if "YES" in str(answer).upper():
                relevant.append(chunk)
        return relevant or chunks

    def _leaf(self, client: BaseLM, text: str, query: str | None, task_type: TaskType) -> str:
        self.model_call_counts["leaf"] += 1
        if task_type is TaskType.QA and query:
            prompt = f"Answer the question using only this text chunk.\nQuestion: {query}\nText:\n{text}"
        elif task_type is TaskType.SUMMARIZATION:
            prompt = f"Summarize this text chunk:\n{text}"
        else:
            prompt = f"Process this text chunk for task {task_type.value}:\n{text}"
        return str(client.completion(prompt))

    def _reduce(self, client: BaseLM, parts: list[str], compose_op: ComposeOp, query: str | None) -> str:
        if not parts:
            return ""
        if len(parts) == 1:
            return parts[0]
        if compose_op is ComposeOp.CONCATENATE:
            return "\n".join(parts)
        if compose_op is ComposeOp.MAJORITY_VOTE:
            return max(set(parts), key=parts.count)
        if compose_op is ComposeOp.MERGE_EXTRACTIONS:
            seen = set()
            lines = []
            for part in parts:
                for line in part.splitlines():
                    normalized = line.strip().lower()
                    if normalized and normalized not in seen:
                        seen.add(normalized)
                        lines.append(line)
            return "\n".join(lines)
        self.model_call_counts["reducer"] += 1
        if compose_op is ComposeOp.SELECT_RELEVANT:
            useful = [part for part in parts if "no answer" not in part.lower() and "not found" not in part.lower()]
            if not useful:
                useful = parts
            return str(client.completion(
                "Synthesize the relevant partial answers into one answer.\n"
                f"Question: {query or ''}\nPartial answers:\n" + "\n---\n".join(useful)
            ))
        if compose_op is ComposeOp.COMBINE_ANALYSIS:
            return str(client.completion("Combine these partial analyses:\n" + "\n---\n".join(parts)))
        return str(client.completion("Merge these partial summaries:\n" + "\n---\n".join(parts)))
