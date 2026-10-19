/** Typed-in formats for a question's free-text box, so a date or a phone number types itself:
 * "06" shows "06/", the slash is jumped over, and "1998" completes it.
 *
 * A pattern: `#` a digit, `A` a letter, `*` a letter or digit; anything else is a literal the box
 * inserts itself. Pure, so the terminal and the VS Code panel apply exactly the same rule. */

export const INPUT_FORMATS: Readonly<Record<string, string>> = {
  date: '##/##/####',
  phone: '(###) ###-####',
  zip: '#####',
  time: '##:##',
};

/** A named format or a pattern, as a pattern. */
export function maskPattern(format: string | undefined): string | undefined {
  if (!format) return undefined;
  return INPUT_FORMATS[format] ?? (/[#A*]/.test(format) ? format : undefined);
}

const accepts = (slot: string, char: string): boolean =>
  slot === '#' ? /\d/.test(char) : slot === 'A' ? /[A-Za-z]/.test(char) : /[A-Za-z0-9]/.test(char);
const isSlot = (char: string): boolean => char === '#' || char === 'A' || char === '*';

/** The text the box should show for what was typed. Characters that do not fit the next slot are dropped
 * (a typed "/" is the literal already there); a literal is added as soon as the slot before it is full.
 * While deleting, no trailing literal is added back, or Backspace could never get past one. */
export function applyInputMask(raw: string, pattern: string, deleting = false): string {
  const chars = [...raw];
  let at = 0;
  let out = '';
  for (let index = 0; index < pattern.length; index++) {
    const slot = pattern[index]!;
    if (isSlot(slot)) {
      while (at < chars.length && !accepts(slot, chars[at]!)) at++;
      if (at >= chars.length) break;
      out += chars[at++]!;
    } else {
      // A literal goes in when more has been typed, or right after a full slot unless deleting.
      const more = chars.slice(at).some(char => accepts(nextSlot(pattern, index) ?? '*', char));
      if (more || (!deleting && out.length > 0)) out += slot;
      else break;
    }
  }
  // A deleting user lands just after the last slot character, not on a dangling literal.
  if (deleting) while (out.length && !isSlot(pattern[out.length - 1]!)) out = out.slice(0, -1);
  return out;
}

function nextSlot(pattern: string, from: number): string | undefined {
  for (let index = from; index < pattern.length; index++) if (isSlot(pattern[index]!)) return pattern[index];
  return undefined;
}

/** Whether every slot is filled. */
export function maskComplete(value: string, pattern: string): boolean {
  return value.length === pattern.length && [...pattern].every((slot, index) => (isSlot(slot) ? accepts(slot, value[index]!) : value[index] === slot));
}
