import { describe, expect, it } from 'vitest';
import { toCliErrorMessage } from './error-message.js';

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
