/**
 * Tests for the model-output extractors.
 *
 * Covers normal extraction behaviour plus ReDoS regression guards: the
 * fenced-block / raw-Python / trailing-whitespace regexes parse UNTRUSTED
 * model output and dataset blobs, so an adversarial input must not drive
 * polynomial backtracking (CodeQL js/polynomial-redos).
 */
import { describe, it, expect } from 'vitest';

import { extractPythonCode } from './code-extractor.js';
import { composeUserPrompt } from './prompt-template.js';
import type { LiveCodeBenchInstance } from '../types.js';

describe('extractPythonCode', () => {
  it('returns the last python-tagged fenced block', () => {
    const response = [
      'Here is a first attempt:',
      '```python',
      'print("draft")',
      '```',
      'and the refined answer:',
      '```python',
      'def solve():\n    return 42',
      '```',
    ].join('\n');
    expect(extractPythonCode(response)).toBe('def solve():\n    return 42');
  });

  it('accepts py / python3 language tags', () => {
    expect(extractPythonCode('```py\nx = 1\n```')).toBe('x = 1');
    expect(extractPythonCode('```python3\ny = 2\n```')).toBe('y = 2');
  });

  it('falls back to the last fenced block of any tag', () => {
    const response = '```\nimport sys\nprint(sys.stdin.read())\n```';
    expect(extractPythonCode(response)).toBe('import sys\nprint(sys.stdin.read())');
  });

  it('falls back to the raw-Python heuristic with leading comments', () => {
    const response = '# a comment\n# another\nimport math\nprint(math.pi)';
    expect(extractPythonCode(response)).toBe(response);
  });

  it('returns empty string when nothing is recognisable', () => {
    expect(extractPythonCode('I cannot solve this problem.')).toBe('');
  });

  it('handles a fenced block with trailing whitespace on the info line', () => {
    expect(extractPythonCode('```python   \nz = 3\n```')).toBe('z = 3');
  });

  it('completes quickly on a 200k-char adversarial fenced-block input', () => {
    // An unterminated fence with an empty info tag followed by a long run of
    // newlines: `\w*` matches empty, then `\s*\n` backtracks across the run
    // looking for a body it never finds — the `\s*\n`-after-`\w*` ReDoS.
    const adversarial = '```' + '\n'.repeat(200000);
    const start = performance.now();
    const out = extractPythonCode(adversarial);
    const elapsed = performance.now() - start;
    expect(typeof out).toBe('string');
    expect(elapsed).toBeLessThan(250);
  });

  it('completes quickly on a 200k-char adversarial raw-Python head', () => {
    // A long whitespace run that never reaches a def/class/import keyword: the
    // overlapping leading and trailing `\s*` around `(#.*\n)*` made the head
    // quadratic on this shape.
    const adversarial = ' '.repeat(200000) + 'x';
    const start = performance.now();
    const out = extractPythonCode(adversarial);
    const elapsed = performance.now() - start;
    expect(out).toBe('');
    expect(elapsed).toBeLessThan(250);
  });
});

describe('composeUserPrompt trailing-whitespace trim', () => {
  function instanceWith(input: string): LiveCodeBenchInstance {
    return {
      instanceId: 'p1',
      platform: 'codeforces',
      difficulty: 'easy',
      problemStatement: 'Echo the input.',
      publicTests: [{ input, expectedOutput: 'ok' }],
    };
  }

  it('trims trailing whitespace from a normal blob', () => {
    const prompt = composeUserPrompt(instanceWith('42   '));
    expect(prompt).toContain('"42"');
  });

  it('completes quickly on a 200k-char trailing-whitespace blob', () => {
    // `/\s+$/` is polynomial on whitespace-run-then-nonspace; assert linear.
    const adversarial = 'x' + ' '.repeat(200000) + 'y';
    const start = performance.now();
    const prompt = composeUserPrompt(instanceWith(adversarial));
    const elapsed = performance.now() - start;
    expect(prompt.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250);
  });
});
