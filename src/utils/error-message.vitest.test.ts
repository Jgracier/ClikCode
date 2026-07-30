import { describe, expect, it } from 'vitest';
import { toCliErrorMessage, toCliErrorJson, toCliExitCode } from './error-message';
import { EXIT_CODE_UNDETERMINED, UndeterminedOutcomeError } from './determination';

const UNAVAILABLE_CLAIM = 'ClikDeploy is temporarily unavailable';

describe('error-message', () => {
  it('extracts nested API and object errors', () => {
    expect(toCliErrorMessage({ message: 'plain' })).toBe('Unknown error');
    expect(toCliErrorMessage({ response: { data: { error: 'api err' } } })).toBe('api err');
    expect(toCliErrorMessage({ response: { data: { message: 'msg err' } } })).toBe('msg err');
    expect(toCliErrorMessage({ response: { data: { error: { message: 'nested' } } } })).toBe('nested');
    expect(toCliErrorMessage({ response: { data: { error: { code: 'E1' } } } })).toBe('E1');
    expect(toCliErrorMessage({ response: { data: { error: { foo: 1 } } } })).toContain('foo');
    expect(toCliErrorMessage(null)).toBe('Unknown error');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toCliErrorMessage({ response: { data: { error: circular } } })).toContain('[object');
    expect(toCliErrorMessage({ response: { data: { error: 42 } } })).toBe('42');
  });

  // ── DEFECT A: an inability to observe rendered as a verdict about the server ────────────────
  describe('a transport failure is never a claim about the platform', () => {
    it('reports undici socket failure as a local failure, not a platform outage', () => {
      // Exactly what undici's fetch() throws when the connection breaks: message is the bare
      // string `fetch failed`, and the syscall code lives on `.cause.code`. There is NO response,
      // so we observed nothing whatsoever about the server.
      const error = Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
        config: { baseURL: 'http://localhost:3000/', url: '/api/gate/apps' },
      });
      const message = toCliErrorMessage(error);
      expect(message).not.toContain(UNAVAILABLE_CLAIM);
      expect(message).toContain('This CLI could not complete its request');
      expect(message).toContain('http://localhost:3000/api/gate/apps');
      expect(message).toContain('UND_ERR_SOCKET');
    });

    it('reports a socket dying mid-body-read as a local failure', () => {
      // undici's message for a socket that dies after the status line — the case where the server
      // has ALREADY logged 200 and the CLI still fails.
      const error = Object.assign(new TypeError('terminated'), {
        cause: { code: 'UND_ERR_SOCKET' },
      });
      expect(toCliErrorMessage(error)).not.toContain(UNAVAILABLE_CLAIM);
    });

    it('does not read the phrase "fetch failed" inside a real HTTP error as an outage', () => {
      // The old predicate matched /\bfetch failed\b/ ANYWHERE in ANY message. A 400 whose
      // axios message merely mentioned an upstream probe was laundered into a platform outage,
      // and the body — the actual answer, already in hand — was discarded.
      const error = Object.assign(new Error('Request failed: upstream fetch failed while probing'), {
        response: { status: 400, data: { error: 'invalid image reference' } },
      });
      const message = toCliErrorMessage(error);
      expect(message).not.toContain(UNAVAILABLE_CLAIM);
      expect(message).toBe('invalid image reference');
    });

    it('reports our own timeout as our own, not as the server being down', () => {
      const error = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
      const message = toCliErrorMessage(error);
      expect(message).not.toContain(UNAVAILABLE_CLAIM);
      expect(message).toContain('This CLI stopped waiting');
      expect(message).toContain('may have completed server-side');
    });

    it('still says the platform is unavailable when the platform itself said so', () => {
      expect(toCliErrorMessage({ response: { status: 503, data: {} } })).toContain(UNAVAILABLE_CLAIM);
      expect(toCliErrorMessage({ response: { status: 521, data: {} } })).toContain(UNAVAILABLE_CLAIM);
    });

    it('quotes the 5xx body instead of discarding it', () => {
      // Third instance of the same collapse: a 502 that TOLD us why was rendered as the generic
      // retry line, throwing away a result we already held.
      const message = toCliErrorMessage({
        response: { status: 502, data: { error: 'builder pool exhausted' } },
      });
      expect(message).toContain(UNAVAILABLE_CLAIM);
      expect(message).toContain('builder pool exhausted');
    });
  });

  // ── DEFECT B: an unknown outcome must not exit or serialise as a failure ────────────────────
  describe('undetermined outcomes are not failures', () => {
    const error = new UndeterminedOutcomeError(
      'confirmation-window-expired',
      'Delete accepted for 10 app(s); convergence not confirmed (confirmation-window-expired)',
      '10 app(s) unconfirmed after watching the live status stream for 300s'
    );

    it('serialises as status "undetermined" with its reason', () => {
      const json = toCliErrorJson(error);
      expect(json.status).toBe('undetermined');
      expect(json.reason).toBe('confirmation-window-expired');
      expect(json.detail).toContain('300s');
    });

    it('exits non-zero but distinguishably from a real failure', () => {
      expect(toCliExitCode(error)).toBe(EXIT_CODE_UNDETERMINED);
      expect(toCliExitCode(error)).not.toBe(0);
      expect(toCliExitCode(error)).not.toBe(1);
      // A genuine failure still exits 1 and still serialises as an error.
      expect(toCliExitCode(new Error('Failed to delete 3 app(s)'))).toBe(1);
      expect(toCliErrorJson(new Error('Failed to delete 3 app(s)')).status).toBe('error');
    });
  });
});
