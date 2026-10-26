import { describe, expect, it } from 'vitest';
import { failureText, FAILURE_TEXT_LIMIT } from './stderr-line';

describe('a failed process or turn put to a person', () => {
  it("leaves out Codex's startup banners and keeps the error under them", () => {
    const stderr = [
      'Codex: Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load.',
      '    1. /home/me/projects/.codex',
      '       To load project-local config, hooks, and exec policies, add /home/me/projects as a trusted project in /home/me/.clikcode/profiles/codex/abc/config.toml.',
      'Codex: Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
      "Error: Error running remote compact task: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
    ].join('\n');
    expect(failureText(stderr)).toBe("Error: Error running remote compact task: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.");
  });

  it('shows the whole cause, not the line that happens to say "error"', () => {
    const stderr = 'Error: upstream failed\nworker killed with exit code 137 (out of memory)\n';
    const text = failureText(`node exited 1: ${stderr}`);
    expect(text).toContain('Error: upstream failed');
    expect(text).toContain('exit code 137 (out of memory)');
  });

  it('keeps every line of a warning that leads to the complaint', () => {
    const text = failureText("Warning: No project session found with id 'db6d5103'\nNo API key found for the selected model.\n\nUse /login to log into a provider.\n");
    expect(text).toContain('No API key found for the selected model.');
    expect(text).toContain('Use /login to log into a provider.');
  });

  it('keeps the provider\'s own report and shows the message inside its JSON body', () => {
    const message = 'Internal error: The request exceeds the model\'s context window. (provider reported: Failed to create stream: request failed with status 400: {"error":{"message":"prompt is too long: 250000 tokens > 200000","type":"invalid_request_error"}})';
    const text = failureText(message);
    expect(text).toContain('The request exceeds the model\'s context window.');
    expect(text).toContain('provider reported: Failed to create stream: request failed with status 400: prompt is too long: 250000 tokens > 200000');
    expect(text).not.toContain('invalid_request_error');
  });

  it('reads the message out of a multi-line JSON body and leaves an unreadable one as written', () => {
    expect(failureText('request failed with status 429:\n{\n  "error": {"message": "slow down"}\n}')).toBe('request failed with status 429:\nslow down');
    expect(failureText('bad body: {"code": 7, "weird": true}')).toBe('bad body: {"code": 7, "weird": true}');
    expect(failureText('half a body: {"error": "cut off')).toBe('half a body: {"error": "cut off');
  });

  it('drops only stack frames, require stacks, ANSI and bare paths', () => {
    const text = failureText(`claude exited 1: \u001b[31mError: invalid api key\u001b[0m\nRequire stack:\n- /opt/x/y.js\n    at frame (/opt/x.js:1:2)\n/opt/x/y.js\nsecond line of the cause\n${'    at frame\n'.repeat(200)}`);
    expect(text).toBe('claude exited 1: Error: invalid api key\nsecond line of the cause');
  });

  it('falls back to what was written when everything looked like noise', () => {
    expect(failureText('/opt/x/y.js')).toBe('/opt/x/y.js');
  });

  it('bounds a runaway, keeping its start and its end', () => {
    const flood = `banner\n${'noise line\n'.repeat(5000)}the actual cause`;
    const text = failureText(flood);
    expect(text.length).toBeLessThanOrEqual(FAILURE_TEXT_LIMIT + 4);
    expect(text.startsWith('banner')).toBe(true);
    expect(text.endsWith('the actual cause')).toBe(true);
  });
});
