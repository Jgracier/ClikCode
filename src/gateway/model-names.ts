/** The Gateway's model list is not stable: it renames families (`claude-sonnet-5.5` is now listed as `claude-sonnet-5`, `claude-opus-5-5` as
 * `claude-opus-5`), changes dots to dashes, and has held 596 models one hour and 354 the next. Code that asks for a model by a fixed name
 * therefore asks for names the list no longer has: on 2026-11-17 that dropped every Claude voter from the captcha rosters and made every
 * connector agent fail at once. A wanted name is matched against what is listed now, here, and nowhere else. */

/** A name with its punctuation taken out, so `claude-sonnet-5.5`, `claude-sonnet-5-5` and `Claude_Sonnet_5_5` compare equal. */
const squash = (id: string): string => id.toLowerCase().replace(/[.\-_:\s]/g, '');

/** The listed model that stands for `wanted`, or undefined when the Gateway lists nothing like it. In order: the same name; the same name
 * apart from punctuation; the longest listed name that `wanted` begins with when only a minor version is left over (a family that dropped
 * its minor number: `claude-sonnet-5-5` -> `claude-sonnet-5`). A different generation is never a match (`claude-haiku-5-5` is not
 * `claude-haiku-4-5`), and neither is a variant (`-batch`, `:thinking`). */
export function listedModel(wanted: string, listed: readonly string[]): string | undefined {
  if (listed.includes(wanted)) return wanted;
  const target = squash(wanted);
  const same = listed.find(id => squash(id) === target);
  if (same) return same;
  let best: { id: string; length: number } | undefined;
  for (const id of listed) {
    const stem = squash(id);
    if (stem.length < 4 || stem.length >= target.length || !target.startsWith(stem) || !/^\d+$/.test(target.slice(stem.length))) continue;
    if (!best || stem.length > best.length) best = { id, length: stem.length };
  }
  return best?.id;
}

/** `wanted`, each resolved against `listed`, in order, each listed model once. Names the Gateway has no match for are left out. */
export function listedModels(wanted: readonly string[], listed: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of wanted) { const id = listedModel(name, listed); if (id && !out.includes(id)) out.push(id); }
  return out;
}
