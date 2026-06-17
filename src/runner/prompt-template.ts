/**
 * Prompt composition for LiveCodeBench code_generation problems.
 *
 * @module runner/prompt-template
 */

import type { LiveCodeBenchInstance } from '../types.js';

const SYSTEM_PROMPT = `You are an expert competitive programmer solving an algorithmic problem.

You will receive:
1. A natural-language problem statement.
2. Public sample I/O pairs you can use to validate your reasoning.
3. Optionally, starter code (a class skeleton or function signature).

Produce a complete, runnable Python 3 solution that passes the public tests AND any reasonable hidden tests for the same problem. The solution must:

- Read from stdin and write to stdout when no starter code is given (Codeforces / AtCoder style).
- Fill in the provided class/function when starter code is given (LeetCode style).
- Use only the Python 3 standard library — no third-party imports.
- Handle the edge cases implied by the problem statement (e.g., empty input, single-element input, integer-overflow patterns).

Wrap the final solution in a single fenced \`\`\`python ... \`\`\` block. No prose after the fence.`;

export function composeUserPrompt(instance: LiveCodeBenchInstance): string {
  const lines: string[] = [
    `Problem: ${instance.instanceId}`,
    `Platform: ${instance.platform} (${instance.difficulty})`,
    '',
    'Problem statement:',
    instance.problemStatement,
  ];

  if (instance.starterCode !== undefined && instance.starterCode.trim().length > 0) {
    lines.push('', 'Starter code (fill this in — do not change the signatures):', '```python', instance.starterCode, '```');
  }

  if (instance.publicTests.length > 0) {
    lines.push('', 'Public tests:');
    instance.publicTests.forEach((t, i) => {
      lines.push(
        '',
        `Test ${String(i + 1)}:`,
        `  Input:           ${formatBlob(t.input)}`,
        `  Expected output: ${formatBlob(t.expectedOutput)}`
      );
    });
  }

  lines.push('', 'Emit your solution now in a single fenced ```python``` block.');
  return lines.join('\n');
}

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

function formatBlob(s: string): string {
  // Multi-line inputs/outputs are common (one int per line, etc.). Render
  // them inline for short blobs, on their own line for long ones.
  // NB: trim trailing whitespace with String.prototype.trimEnd rather than a
  // `/\s+$/` replace — the anchored `\s+$` is polynomial-backtracking
  // (CodeQL js/polynomial-redos) on an adversarial blob of trailing
  // whitespace followed by a non-space, and these blobs are untrusted dataset
  // fields. trimEnd is linear and equivalent here.
  const trimmed = s.trimEnd();
  if (trimmed.length === 0) return '<empty>';
  if (trimmed.includes('\n') || trimmed.length > 60) {
    return `\n    ${trimmed.replace(/\n/g, '\n    ')}`;
  }
  return JSON.stringify(trimmed);
}
