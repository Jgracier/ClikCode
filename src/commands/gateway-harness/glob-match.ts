/** Dependency-free glob matching over `/`-separated relative paths.
 * Supports `**`, `*`, `?`, `[set]`, `[!set]` and `{a,b}` alternation. */

const cache = new Map<string, RegExp>();

function expandBraces(pattern: string): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') { i++; continue; }
    if (char === '{') { if (depth === 0) start = i; depth++; }
    else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const options: string[] = [];
        let level = 0;
        let last = start + 1;
        for (let j = start + 1; j < i; j++) {
          if (pattern[j] === '{') level++;
          else if (pattern[j] === '}') level--;
          else if (pattern[j] === ',' && level === 0) { options.push(pattern.slice(last, j)); last = j + 1; }
        }
        options.push(pattern.slice(last, i));
        if (options.length < 2) continue;
        const head = pattern.slice(0, start);
        const tail = pattern.slice(i + 1);
        return options.flatMap((option) => expandBraces(`${head}${option}${tail}`)).slice(0, 256);
      }
    }
  }
  return [pattern];
}

function segmentSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0 || pattern[i - 1] === '/';
        while (pattern[i + 1] === '*') i++;
        if (atStart && pattern[i + 1] === '/') { out += '(?:[^/]+/)*'; i++; }
        else if (atStart && i + 1 === pattern.length) out += '.*';
        else out += '[^/]*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else if (char === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) { out += '\\['; continue; }
      let body = pattern.slice(i + 1, close);
      const negated = body[0] === '!' || body[0] === '^';
      if (negated) body = body.slice(1);
      out += `[${negated ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
      i = close;
    } else if (char === '\\' && i + 1 < pattern.length) { out += escapeRegex(pattern[++i]); }
    else out += escapeRegex(char);
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function globToRegExp(pattern: string, options: { caseInsensitive?: boolean } = {}): RegExp {
  const key = `${options.caseInsensitive ? 'i' : 's'}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const normalized = pattern.replace(/\\(?=[^*?[\]{}\\])/g, '/').replace(/^\.\//, '');
  const source = expandBraces(normalized).map(segmentSource).join('|');
  const regex = new RegExp(`^(?:${source})$`, options.caseInsensitive ? 'i' : '');
  if (cache.size > 500) cache.clear();
  cache.set(key, regex);
  return regex;
}

/** Match a relative path. A pattern with no `/` matches the basename at any
 * depth (`*.ts` finds `src/a.ts`), the convention both rg and gitignore use. */
export function matchGlob(pattern: string, relativePath: string, options: { caseInsensitive?: boolean } = {}): boolean {
  const target = relativePath.split('\\').join('/').replace(/^\.\//, '');
  if (!pattern.includes('/')) {
    const base = target.slice(target.lastIndexOf('/') + 1);
    return globToRegExp(pattern, options).test(base);
  }
  return globToRegExp(pattern.replace(/^\//, ''), options).test(target);
}
