/**
 * Extract a Python solution from a LiveCodeBench model response.
 *
 * Models commonly wrap their solution in fenced ```python``` (or just
 * ```) blocks, sometimes with leading prose. Strategy:
 *
 * 1. If the response contains one or more fenced blocks tagged `python`
 *    or `py`, return the LAST one (later blocks are typically the
 *    refined / final answer).
 * 2. Otherwise, return the LAST fenced block of any language tag.
 * 3. Otherwise, if the response looks like raw Python (starts with
 *    `def`, `class`, `import`, `from`), return it whole.
 * 4. Otherwise, return the empty string.
 *
 * @module runner/code-extractor
 */

const FENCED_RE = /```(\w*)\s*\n([\s\S]*?)```/g;
const PY_LANGS = new Set(['python', 'py', 'python3', 'py3']);
const RAW_PY_HEAD = /^(\s*(#.*\n)*\s*)(def\s|class\s|import\s|from\s)/;

export function extractPythonCode(response: string): string {
  const blocks: Array<{ lang: string; body: string }> = [];
  FENCED_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCED_RE.exec(response)) !== null) {
    const lang = (match[1] ?? '').toLowerCase();
    const body = match[2] ?? '';
    blocks.push({ lang, body });
  }

  // 1. Last python-tagged block.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block !== undefined && PY_LANGS.has(block.lang)) {
      return block.body.trim();
    }
  }

  // 2. Last fenced block of any tag.
  const last = blocks[blocks.length - 1];
  if (last !== undefined) {
    return last.body.trim();
  }

  // 3. Raw-Python heuristic.
  if (RAW_PY_HEAD.test(response)) {
    return response.trim();
  }

  // 4. Nothing recognisable.
  return '';
}
