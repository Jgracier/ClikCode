/** Failures that are swallowed on purpose are written down (runtime/lifecycle-log.ts swallowed/quiet)
 * or say why they need not be. This keeps it so: a catch that does nothing -- empty, `() => undefined`,
 * or a body of comments alone -- either records the error or carries `fail-open-ok: <reason>`.
 * Parsed, not matched by line: a comment is no longer enough on its own, and code in a string (a
 * script run in another process) is not code here. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/** The logger and its own imports: nothing there can record, so a swallow there is tagged. */
const CANNOT_RECORD = new Set([
  'runtime/lifecycle-log.ts', 'runtime/redact.ts', 'session/store/paths.ts', 'agent/computer/secret-scrubber.ts', 'agent/computer/shared-state.ts',
]);

const TAG = /fail-open-ok:\s*\S/;

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.(?:vitest\.)?test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The places a failure goes nowhere: a catch clause with no statements, and a `.catch(...)`
 * handler that does nothing (an empty or comment-only body, or `() => undefined`). A handler that
 * answers something else (`() => null`, `() => []`) is a fallback value, not a swallow. */
function silentCatches(name: string, text: string): string[] {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const area = name.replace(/\.tsx?$/, '');
  const found: string[] = [];
  const say = (node: ts.Node, what: string, end = node.getEnd()): void => {
    const span = text.slice(node.getStart(file), end);
    if (TAG.test(span)) return;
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const fix = CANNOT_RECORD.has(name) ? 'add /* fail-open-ok: <why> */'
      : `record it -- catch (error) { swallowed('${area}', error); } or .catch(quiet('${area}')) -- or add /* fail-open-ok: <why> */`;
    found.push(`${name}:${line}  ${what}  ->  ${fix}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      say(node, text.slice(node.block.getStart(file) + 1, node.block.getEnd() - 1).trim() ? 'catch with only a comment' : 'empty catch');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
      const handler = node.arguments[0];
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const body = handler.body;
        const nothing = ts.isBlock(body) ? body.statements.length === 0 : ts.isIdentifier(body) && body.text === 'undefined';
        // A reason may follow on the same line, after the statement ends.
        const lineEnd = text.indexOf('\n', node.getEnd());
        if (nothing) say(node.expression.name, '.catch that drops the error', lineEnd < 0 ? text.length : lineEnd);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('swallowed failures', () => {
  it('are all written down or say why not', () => {
    const found = sources(SRC).flatMap((path) => silentCatches(relative(SRC, path), readFileSync(path, 'utf8')));
    expect(found).toEqual([]);
  });

  it('takes a comment as a reason only when it is tagged', () => {
    const flagged = silentCatches('x.ts', [
      'try { a(); } catch {}',
      'try { a(); } catch { /* already gone */ }',
      'try { a(); } catch { /* fail-open-ok: already gone */ }',
      'try { a(); } catch (error) { swallowed("x", error); }',
      'p.catch(() => undefined);',
      'p.catch(() => { /* nothing */ });',
      'p.catch(() => { /* fail-open-ok: nothing to do */ });',
      'p.catch(() => undefined); // fail-open-ok: marks it handled',
      'p.catch(quiet("x"));',
      'p.catch(() => null);',
      'const script = `try { a(); } catch {}`;',
    ].join('\n'));
    expect(flagged.map((line) => line.split('  ')[0])).toEqual(['x.ts:1', 'x.ts:2', 'x.ts:5', 'x.ts:6']);
  });
});
