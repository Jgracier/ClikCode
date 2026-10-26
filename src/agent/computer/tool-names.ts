/** The two tools were `computer_web` and `computer_desktop` until 2026-10-26. Permission rules, scripts and
 * other harnesses may still use those names, so they keep working wherever a name comes in from outside. */
const RENAMED: Readonly<Record<string, string>> = { computer_web: 'browser_use', computer_desktop: 'computer_use' };

export function currentToolName(name: string): string { return RENAMED[name] ?? name; }
