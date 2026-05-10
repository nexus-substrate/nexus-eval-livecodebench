# nexus-eval-livecodebench

LiveCodeBench evaluation harness for [nexus-agents](https://github.com/williamzujkowski/nexus-agents) — implements the `BenchmarkAdapter` contract from nexus-agents ≥ 2.33.1.

> **Status**: v0.1 model-only baseline. Bundled four-problem smoke fixture, Python-solution prompt template, fenced-code extractor, IModelAdapter-driven runner. HuggingFace loader is the v0.2 follow-up; sandboxed Python runner for true test-based pass/fail is also v0.2.

## Why LiveCodeBench

[LiveCodeBench](https://livecodebench.github.io/) is a holistic, contamination-resistant code-generation benchmark from UC Berkeley. Distinguishing properties:

- **Rolling, dated problem set** — collected continuously from LeetCode, AtCoder, and Codeforces. Operators routinely slice runs by `min-release-date >= <model_cutoff>` to evaluate on problems the model couldn't have memorised.
- **Multi-platform** — three problem styles: LeetCode (function-fill), AtCoder (stdin/stdout), Codeforces (stdin/stdout, contest-graded). Catches platform-idiom blind spots that single-source benchmarks hide.
- **Three-bucket difficulty normalised across platforms** — easy/medium/hard. Lets summaries surface "does this model degrade on hard problems".
- **Deterministic hidden tests** — every problem has a fixed test set, so pass/fail is mechanical (no LLM-judge, no human eval).
- **Standard reference number** — Anthropic and OpenAI both publish LiveCodeBench scores routinely, so operators have a calibration target for routing decisions.

This repo is the dedicated harness for running LiveCodeBench through nexus-agents' orchestration. Per the [nexus-agents harness-extraction policy](https://github.com/williamzujkowski/nexus-agents/issues/2514), benchmarks live in standalone `nexus-eval-*` repos so they evolve independently of the core.

## Install

```sh
npm install nexus-eval-livecodebench nexus-agents
```

`nexus-agents` is a peer dependency.

## Quick start (CLI)

```sh
# Set the OpenAI-compat endpoint
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://your-gateway/v1   # optional
export MODEL_ID=anthropic/claude-sonnet-4-6      # optional

# Smoke test against the bundled four-problem fixture (no network)
npx nexus-eval-livecodebench --source fixture

# Run against a local .jsonl matching code_generation_lite schema
npx nexus-eval-livecodebench --source ./code_generation_lite.jsonl --limit 25

# Filter to LeetCode + Codeforces, hard only
npx nexus-eval-livecodebench --source fixture \
  --platforms leetcode,codeforces --difficulties hard

# Contamination guard — only problems released after the model's training cutoff
npx nexus-eval-livecodebench --source ./code_generation_lite.jsonl \
  --min-release-date 2024-08-01

# JSON summary for piping
npx nexus-eval-livecodebench --json --source fixture > run.json
```

## Library usage

```ts
import { runBenchmark, createOpenAIAdapter } from 'nexus-agents';
import { LiveCodeBenchAdapter } from 'nexus-eval-livecodebench';

const modelAdapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  modelId: 'gpt-4o',
});

const adapter = new LiveCodeBenchAdapter(modelAdapter, {
  source: 'fixture',
  difficulties: ['medium', 'hard'],
});
const summary = await runBenchmark(adapter, {}, { concurrency: 4 });

console.log(
  `Produced solutions for ${summary.passed}/${summary.total} ` +
    `(${(summary.passRate * 100).toFixed(1)}%)`
);

const meta = summary.metadata as {
  byPlatform: Record<string, { total: number; passed: number; passRate: number }>;
  byDifficulty: Record<string, { total: number; passed: number; passRate: number }>;
};
for (const [name, stats] of Object.entries(meta.byDifficulty)) {
  console.log(`  ${name}: ${stats.passed}/${stats.total} (${(stats.passRate * 100).toFixed(1)}%)`);
}
```

Operators with their own `IModelAdapter` (Claude API, Ollama, anything implementing the contract) can substitute it for `createOpenAIAdapter` without changing anything else.

## What v0.1 actually does

- Loads problems from the bundled four-problem fixture (one each across LeetCode/AtCoder/Codeforces × easy/medium/hard combinations) or from a local `.jsonl` matching the upstream `livecodebench/code_generation_lite` schema.
- Composes a competitive-programming prompt that lists problem statement, public tests, and (optional) starter code, and asks for a single fenced ` ```python ``` ` block.
- Parses the response: prefers the last `python`-tagged fence, falls back to the last untagged fence, falls back to "looks like raw Python" heuristic, otherwise empty.
- Reports pass/fail = "did the model produce extractable code", with per-platform AND per-difficulty breakdowns.

## What v0.1 does NOT do

- Run the hidden tests against the emitted code. Pass/fail is "code produced", not "code passes tests" — that's the v0.2 follow-up.
- Fetch problems from `livecodebench/code_generation_lite` directly. Use `--source <local.jsonl>` for now (the loader handles the upstream schema).
- Drive multi-turn agentic flows. Single round-trip only.

## Roadmap

| Issue | Scope                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TBD   | **v0.2 — HuggingFace-fetch loader**. Pull from `livecodebench/code_generation_lite` directly with on-disk caching + release-date filtering.            |
| TBD   | **v0.2 — Sandboxed Python runner**. Execute hidden tests in a process-isolated subprocess; turn that into the canonical pass/fail.                     |
| TBD   | **v0.3 — Other tasks**. Add `self_repair`, `test_output_prediction`, `code_execution` as adapter variants — each is a separate row in the same dataset family. |
| TBD   | **v0.3 — Agentic flow** via `ICliAdapter` so the model can iterate when initial tests fail.                                                            |

Cross-repo tracking lives at [nexus-agents #2519](https://github.com/williamzujkowski/nexus-agents/issues/2519) (Tier 2 prioritisation).

## The contract

`BenchmarkAdapter` from nexus-agents:

```ts
interface BenchmarkAdapter<TInstance, TPrediction, TEvalResult> {
  readonly name: string;
  readonly variant?: string;
  loadInstances(config): Promise<readonly TInstance[]>;
  runInstance(instance, ctx): Promise<TPrediction>;
  evaluate(instance, prediction): Promise<TEvalResult>;
  isPass(result): boolean;
  summarize(results, runTimeMs): BenchmarkRunSummary;
}
```

The orchestrator (`runBenchmark` in nexus-agents) handles concurrency, timeouts, progress, and partial failure — this repo doesn't reimplement the harness.

## License

MIT.
