/**
 * Generate one LiveCodeBench prediction by calling an `IModelAdapter`
 * with the problem prompt and parsing out the Python solution.
 *
 * v0.1 scope: model-only baseline, single round-trip. No tool use,
 * no test feedback. v0.2 follow-up adds a sandboxed Python runner so
 * the harness can return test-based pass/fail. v0.3 follow-up adds
 * iterate-on-test-failures via `ICliAdapter`.
 *
 * @module runner/agent-invoker
 */

import { ok, err, type IModelAdapter, type Result } from 'nexus-agents';

import type { LiveCodeBenchInstance, LiveCodeBenchPrediction } from '../types.js';
import { extractPythonCode } from './code-extractor.js';
import { composeUserPrompt, getSystemPrompt } from './prompt-template.js';

export interface GeneratePredictionOptions {
  /** Hard timeout for the model call. Default: 5min. */
  readonly timeoutMs?: number;
  /** Model name recorded in the prediction. Default: adapter.modelId. */
  readonly modelLabel?: string;
}

/**
 * Generate one prediction for a LiveCodeBench problem.
 *
 * Never throws — failures come back via Result.err. Empty solutions
 * (model-couldn't-solve-it) are returned as ok(...) with `code: ''`
 * so the orchestrator can record the attempt.
 */
export async function generatePrediction(
  instance: LiveCodeBenchInstance,
  modelAdapter: IModelAdapter,
  options: GeneratePredictionOptions = {}
): Promise<Result<LiveCodeBenchPrediction, Error>> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const modelLabel = options.modelLabel ?? modelAdapter.modelId;

  const start = Date.now();
  try {
    const completion = await Promise.race([
      modelAdapter.complete({
        messages: [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: composeUserPrompt(instance) },
        ],
      }),
      timeoutAfter<never>(timeoutMs, `model call exceeded ${String(timeoutMs)}ms`),
    ]);

    if (!completion.ok) {
      return err(new Error(completion.error.message));
    }
    const responseText = extractResponseText(completion.value);
    const code = extractPythonCode(responseText);

    return ok({
      instanceId: instance.instanceId,
      code,
      modelLabel,
      durationMs: Date.now() - start,
    });
  } catch (caught: unknown) {
    return err(caught instanceof Error ? caught : new Error(String(caught)));
  }
}

function timeoutAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    handle.unref?.();
  });
}

function extractResponseText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const obj = value as Record<string, unknown>;
  if (typeof obj['content'] === 'string') return obj['content'];
  if (typeof obj['text'] === 'string') return obj['text'];
  if (Array.isArray(obj['choices']) && obj['choices'].length > 0) {
    const first = obj['choices'][0] as { message?: { content?: unknown } } | undefined;
    if (
      first !== undefined &&
      typeof first.message === 'object' &&
      first.message !== null &&
      typeof first.message.content === 'string'
    ) {
      return first.message.content;
    }
  }
  return '';
}
