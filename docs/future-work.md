# Future Work Notes

The MVP proves the Formal Leaf Profile first. The following items are deliberately preserved as future work and are not acceptance dependencies for the MVP hardening slice.

## Agentic Leaf Profiles

A future Leaf Capability Profile may selectively enable Pi capabilities for certain model calls. This must be designed and reviewed separately so tool, extension, skill, and context access does not leak into the Formal Leaf baseline.

## Persistent workers

A long-lived child worker or `pi --mode rpc` style process could reduce process-spawn overhead after correctness and observability are proven. The MVP remains process-per-model-call.

## Direct SDK completion

A direct Pi SDK/model completion path may improve latency or reliability later, but the MVP intentionally routes model calls through constrained child `pi -p` so it uses Pi's existing model/auth system.

## Pi session analysis

Long Pi session `.jsonl` analysis is a desirable future scenario. It should build on path-based context ingestion and bounded results, but the MVP does not include session-specific parsing or compaction replacement.

## Prompt optimization

Prompt tuning and systematic prompt optimization with tools such as DSPy or GEPA should operate by producing reviewed Markdown prompt overlays. Automation is future work; current overlays are operator-owned files.
