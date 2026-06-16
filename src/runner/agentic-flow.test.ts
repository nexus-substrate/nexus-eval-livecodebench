/**
 * Tests for the v0.3 agentic-flow runner. Mocks IModelAdapter + spawn.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { ok, type IModelAdapter, type ContentBlock } from 'nexus-agents';

import { runAgenticFlow } from './agentic-flow.js';
import type { SpawnImpl } from './python-runner.js';
import type { LiveCodeBenchInstance } from '../types.js';

const fixtureInstance: LiveCodeBenchInstance = {
  instanceId: 'cf-echo',
  platform: 'codeforces',
  difficulty: 'easy',
  problemStatement: 'Echo the input.',
  publicTests: [{ input: '5\n', expectedOutput: '5' }],
};

interface ScriptedTurn {
  readonly toolCalls: readonly { id: string; name: string; input: Record<string, unknown> }[];
  readonly stop?: 'end_turn' | 'tool_use';
}

function makeScriptedModel(turns: readonly ScriptedTurn[]): IModelAdapter {
  let i = 0;
  const complete = vi.fn(() => {
    const turn = turns[i] ?? turns[turns.length - 1];
    i += 1;
    if (turn === undefined || turn.toolCalls.length === 0) {
      return Promise.resolve(
        ok({
          content: [{ type: 'text', text: 'done' }] as ContentBlock[],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          stopReason: 'end_turn' as const,
          model: 'mock',
        })
      );
    }
    return Promise.resolve(
      ok({
        content: turn.toolCalls.map((t) => ({
          type: 'tool_use' as const,
          id: t.id,
          name: t.name,
          input: t.input,
        })) as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: turn.stop ?? ('tool_use' as const),
        model: 'mock',
      })
    );
  });
  return {
    providerId: 'anthropic',
    modelId: 'claude-mock',
    capabilities: [],
    complete: complete as never,
    stream: (() => (async function* () {})()) as never,
    countTokens: () => Promise.resolve(0),
    validateConfig: () => ({ ok: true as const, value: undefined }),
  };
}

/** Real ChildProcess.stdin is a Writable stream (an EventEmitter); mirror that
 * so the runner's `.on('error', ...)` guard and write-callback work. */
function makeMockStdin(): EventEmitter & {
  write: (s: string, cb?: () => void) => void;
  end: () => void;
} {
  const stdin = new EventEmitter() as EventEmitter & {
    write: (s: string, cb?: () => void) => void;
    end: () => void;
  };
  stdin.write = (_s: string, cb?: () => void) => cb?.();
  stdin.end = () => undefined;
  return stdin;
}

function makeMockSpawn(opts: { exitCode: number; stdout?: string; stderr?: string }): SpawnImpl {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: ReturnType<typeof makeMockStdin>;
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = makeMockStdin();
    child.kill = () => true;
    queueMicrotask(() => {
      if (opts.stdout !== undefined) child.stdout.emit('data', opts.stdout);
      if (opts.stderr !== undefined) child.stderr.emit('data', opts.stderr);
      child.emit('close', opts.exitCode, null);
    });
    return child as never;
  });
}

describe('runAgenticFlow (livecodebench)', () => {
  it('handles read_problem → returns problem statement + public tests', async () => {
    const model = makeScriptedModel([
      { toolCalls: [{ id: 't1', name: 'read_problem', input: {} }] },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 5 });
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('Echo the input');
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('Test 1');
  });

  it('handles write_solution → updates state.code', async () => {
    const model = makeScriptedModel([
      {
        toolCalls: [{ id: 't1', name: 'write_solution', input: { code: 'print(input())' } }],
      },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 5 });
    expect(result.prediction.code).toBe('print(input())');
  });

  it('run_tests refuses when no solution written', async () => {
    const model = makeScriptedModel([
      { toolCalls: [{ id: 't1', name: 'run_tests', input: {} }] },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 5 });
    expect(result.agentRun.turns[0]?.toolResult.isError).toBe(true);
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('write_solution first');
  });

  it('write_solution + run_tests (passing) reports success', async () => {
    const spawnImpl = makeMockSpawn({ exitCode: 0, stdout: '5' });
    const model = makeScriptedModel([
      {
        toolCalls: [{ id: 't1', name: 'write_solution', input: { code: 'print(input())' } }],
      },
      { toolCalls: [{ id: 't2', name: 'run_tests', input: {} }] },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, {
      turnBudget: 5,
      spawnImpl,
    });
    expect(result.testResult?.passed).toBe(true);
    const lastTurn = result.agentRun.turns[result.agentRun.turns.length - 1];
    expect(lastTurn?.toolResult.content).toContain('All 1 public tests passed');
  });

  it('iterate-on-failure: write (wrong) → test (fail) → write (right) → test (pass)', async () => {
    let callCount = 0;
    const spawnImpl: SpawnImpl = vi.fn(() => {
      callCount += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: ReturnType<typeof makeMockStdin>;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = makeMockStdin();
      child.kill = () => true;
      const passing = callCount >= 2;
      queueMicrotask(() => {
        if (passing) child.stdout.emit('data', '5');
        else child.stdout.emit('data', 'wrong');
        child.emit('close', 0, null);
      });
      return child as never;
    });
    const model = makeScriptedModel([
      {
        toolCalls: [{ id: 't1', name: 'write_solution', input: { code: 'print("wrong")' } }],
      },
      { toolCalls: [{ id: 't2', name: 'run_tests', input: {} }] },
      {
        toolCalls: [{ id: 't3', name: 'write_solution', input: { code: 'print(input())' } }],
      },
      { toolCalls: [{ id: 't4', name: 'run_tests', input: {} }] },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 10, spawnImpl });
    expect(result.testResult?.passed).toBe(true);
    expect(result.prediction.code).toBe('print(input())');
  });

  it('refuses unknown tool name with isError', async () => {
    const model = makeScriptedModel([
      { toolCalls: [{ id: 't1', name: 'wave_magic_wand', input: {} }] },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 3 });
    expect(result.agentRun.turns[0]?.toolResult.isError).toBe(true);
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('Unknown tool');
  });

  it('AbortSignal pre-set: cancels immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const model = makeScriptedModel([{ toolCalls: [{ id: 't1', name: 'read_problem', input: {} }] }]);
    const result = await runAgenticFlow(fixtureInstance, model, {
      turnBudget: 5,
      signal: ac.signal,
    });
    expect(result.agentRun.stopReason).toBe('cancelled');
  });
});
