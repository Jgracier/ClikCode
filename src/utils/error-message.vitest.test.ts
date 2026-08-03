import { describe, expect, it } from 'vitest';
import { toCliErrorMessage } from './error-message.js';
import { ERROR_CATALOG } from './error-catalog.js';

/**
 * A real production problem+json 404, byte-for-byte as
 * `toProblemJson(catalogError('APP_NOT_FOUND'), traceId)` emits it with
 * NODE_ENV=production: no `detail`, no `error`, no `message`.
 */
const PROD_404_BODY = {
  type: 'https://errors.clikdeploy.com/APP_NOT_FOUND',
  title: 'The requested app was not found.',
  status: 404,
  code: 'APP_NOT_FOUND',
  traceId: 'a1b2c3d4e5f60718',
  remediation: 'Verify the app id/name and that it belongs to your account.',
};

/** What axios hands the CLI for that response. */
const AXIOS_404 = Object.assign(new Error('Request failed with status code 404'), {
  response: { status: 404, statusText: 'Not Found', data: PROD_404_BODY, headers: {} },
});

describe('problem+json reaches the CLI user', () => {
  it('renders the catalog title AND remediation instead of axios prose', () => {
    // BEFORE this change `toCliErrorMessageBase` read `data.error ?? data.message`
    // — keys RFC 7807 does not have — so this printed axios's sentence and the
    // user saw neither the title nor the remediation the catalog exists for.
    const rendered = toCliErrorMessage(AXIOS_404);

    expect(rendered).not.toContain('Request failed with status code 404');
    expect(rendered).toContain('The requested app was not found.');
    expect(rendered).toContain(ERROR_CATALOG.APP_NOT_FOUND!.remediation!);
    expect(rendered).toContain('trace a1b2c3d4e5f60718');
  });

  it('renders the same contract for the control-plane gate envelope', () => {
    const rendered = toCliErrorMessage({
      response: {
        status: 401,
        data: { success: false, error: { code: 'AUTH_REQUIRED', message: 'Not signed in', traceId: 'zz' } },
      },
    });
    expect(rendered).toContain('Not signed in');
    // AUTH_REQUIRED is now in the ONE catalog, so its remediation resolves.
    expect(rendered).toContain(ERROR_CATALOG.AUTH_REQUIRED!.remediation!);
    expect(rendered).toContain('trace zz');
  });

  it('still prefers the unavailable-platform message for a 503', () => {
    expect(toCliErrorMessage({ response: { status: 503, data: PROD_404_BODY } })).toContain(
      'temporarily unavailable'
    );
  });
});

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
});
