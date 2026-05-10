/**
 * LiveCodeBench BenchmarkAdapter — clean-room implementation.
 *
 * Self-contained: depends ONLY on public `nexus-agents` types
 * (`BenchmarkAdapter`, `IModelAdapter`, …). No internal-helper imports.
 *
 * v0.1 (this release): model-only baseline. Loads problems from a
 * bundled fixture or a local `.jsonl`, sends each one to the configured
 * `IModelAdapter`, parses out a Python solution. Pass/fail = "did the
 * model produce extractable Python code" — NOT test-based pass/fail.
 *
 * v0.2 follow-up: HuggingFace-fetch loader for the `code_generation_lite`
 * dataset, and a sandboxed Python runner that turns hidden-test execution
 * into the canonical pass/fail.
 *
 * v0.3 follow-up: agentic flow via `ICliAdapter` so the model can
 * iterate on test failures.
 *
 * @module adapter
 */

import type {
  BenchmarkAdapter,
  BenchmarkRunContext,
  BenchmarkRunSummary,
  IModelAdapter,
} from 'nexus-agents';

import { loadLiveCodeBenchInstances } from './runner/instance-loader.js';
import { generatePrediction } from './runner/agent-invoker.js';
import type {
  LiveCodeBenchAdapterConfig,
  LiveCodeBenchEvalResult,
  LiveCodeBenchInstance,
  LiveCodeBenchPrediction,
} from './types.js';

export class LiveCodeBenchAdapter
  implements
    BenchmarkAdapter<LiveCodeBenchInstance, LiveCodeBenchPrediction, LiveCodeBenchEvalResult>
{
  readonly name = 'livecodebench';
  // No `variant` in v1 — only the code_generation task is wired up.
  // Future variants (`self_repair`, `test_output_prediction`, …) would
  // set this to one of those task identifiers.

  private readonly modelAdapter: IModelAdapter;
  private readonly config: LiveCodeBenchAdapterConfig;
  private readonly resultCache = new Map<string, LiveCodeBenchEvalResult>();

  constructor(modelAdapter: IModelAdapter, config: LiveCodeBenchAdapterConfig = {}) {
    this.modelAdapter = modelAdapter;
    this.config = config;
  }

  loadInstances(_runConfig: Record<string, unknown>): Promise<readonly LiveCodeBenchInstance[]> {
    return Promise.resolve(
      loadLiveCodeBenchInstances({
        ...(this.config.source !== undefined && { source: this.config.source }),
        ...(this.config.platforms !== undefined && { platforms: this.config.platforms }),
        ...(this.config.difficulties !== undefined && { difficulties: this.config.difficulties }),
        ...(this.config.minReleaseDate !== undefined && {
          minReleaseDate: this.config.minReleaseDate,
        }),
      })
    );
  }

  async runInstance(
    instance: LiveCodeBenchInstance,
    ctx: BenchmarkRunContext
  ): Promise<LiveCodeBenchPrediction> {
    void ctx;
    const result = await generatePrediction(instance, this.modelAdapter);

    if (!result.ok) {
      const empty: LiveCodeBenchPrediction = {
        instanceId: instance.instanceId,
        code: '',
        modelLabel: this.modelAdapter.modelId,
        durationMs: 0,
      };
      this.resultCache.set(instance.instanceId, {
        instanceId: instance.instanceId,
        platform: instance.platform,
        difficulty: instance.difficulty,
        passed: false,
        reason: result.error.message,
      });
      return empty;
    }

    const codeProduced = result.value.code.length > 0;
    this.resultCache.set(instance.instanceId, {
      instanceId: instance.instanceId,
      platform: instance.platform,
      difficulty: instance.difficulty,
      passed: codeProduced,
      ...(codeProduced ? {} : { reason: 'model returned no extractable Python code' }),
    });
    return result.value;
  }

  evaluate(
    instance: LiveCodeBenchInstance,
    prediction: LiveCodeBenchPrediction
  ): Promise<LiveCodeBenchEvalResult> {
    const cached = this.resultCache.get(instance.instanceId);
    if (cached !== undefined) return Promise.resolve(cached);
    const passed = prediction.code.length > 0;
    return Promise.resolve({
      instanceId: instance.instanceId,
      platform: instance.platform,
      difficulty: instance.difficulty,
      passed,
      ...(passed ? {} : { reason: 'evaluate() called without runInstance' }),
    });
  }

  isPass(result: LiveCodeBenchEvalResult): boolean {
    return result.passed;
  }

  /**
   * Per-platform AND per-difficulty pass-rate breakdowns. LiveCodeBench's
   * headline signals are (a) does the model degrade on harder problems
   * and (b) does it favour one platform's idiomatic style over another.
   */
  summarize(
    results: readonly LiveCodeBenchEvalResult[],
    runTimeMs: number
  ): BenchmarkRunSummary {
    const passed = results.filter((r) => r.passed).length;
    const byPlatform: Record<string, { total: number; passed: number }> = {};
    const byDifficulty: Record<string, { total: number; passed: number }> = {};
    for (const r of results) {
      const pBucket = byPlatform[r.platform] ?? { total: 0, passed: 0 };
      pBucket.total += 1;
      if (r.passed) pBucket.passed += 1;
      byPlatform[r.platform] = pBucket;

      const dBucket = byDifficulty[r.difficulty] ?? { total: 0, passed: 0 };
      dBucket.total += 1;
      if (r.passed) dBucket.passed += 1;
      byDifficulty[r.difficulty] = dBucket;
    }
    return {
      name: this.name,
      variant: 'code_generation',
      total: results.length,
      passed,
      passRate: results.length > 0 ? passed / results.length : 0,
      runTimeMs,
      metadata: {
        byPlatform: withRates(byPlatform),
        byDifficulty: withRates(byDifficulty),
        note: 'pass/fail reflects code generation only. Run hidden tests against the emitted code for test-based resolution (v0.2 follow-up).',
      },
    };
  }
}

function withRates(
  buckets: Record<string, { total: number; passed: number }>
): Record<string, { total: number; passed: number; passRate: number }> {
  return Object.fromEntries(
    Object.entries(buckets).map(([k, v]) => [
      k,
      { ...v, passRate: v.total > 0 ? v.passed / v.total : 0 },
    ])
  );
}
