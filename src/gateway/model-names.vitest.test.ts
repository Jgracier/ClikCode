import { describe, expect, it } from 'vitest';
import { listedModel, listedModels } from './model-names.js';

// What the Gateway listed on 2026-11-17, in part.
const LISTED = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5-batch', 'claude-sonnet-5:thinking', 'gpt-5', 'gpt-5.2', 'gpt-4.1-mini', 'gemini-3-flash', 'gemini-3.1-pro'];

describe('a wanted model name against the Gateway\'s list', () => {
  it('finds the same name first', () => {
    expect(listedModel('gpt-5.2', LISTED)).toBe('gpt-5.2');
    expect(listedModel('claude-sonnet-5', LISTED)).toBe('claude-sonnet-5');
  });

  it('finds a name that differs only in punctuation', () => {
    expect(listedModel('gemini-3-1-pro', LISTED)).toBe('gemini-3.1-pro');
    expect(listedModel('Claude_Sonnet_4_6', LISTED)).toBe('claude-sonnet-4-6');
  });

  it('follows a family that dropped its minor version, as claude-sonnet-5-5 became claude-sonnet-5', () => {
    expect(listedModel('claude-sonnet-5-5', LISTED)).toBe('claude-sonnet-5');
    expect(listedModel('claude-opus-5-5', LISTED)).toBe('claude-opus-5');
    expect(listedModel('claude-sonnet-5.5', LISTED)).toBe('claude-sonnet-5');
  });

  it('never takes another generation, a variant, or a shorter family for the same thing', () => {
    expect(listedModel('claude-haiku-5-5', LISTED)).toBeUndefined();
    expect(listedModel('claude-sonnet-6', LISTED)).toBeUndefined();
    expect(listedModel('gpt-5.2', ['gpt-5', 'gpt-5-batch'])).toBe('gpt-5');
    expect(listedModel('claude-sonnet-5-5', ['claude-sonnet-5-batch', 'claude-sonnet-5:thinking'])).toBeUndefined();
    expect(listedModel('claude-sonnet-5-5', ['cl'])).toBeUndefined();
  });

  it('prefers the longest listed family when several fit', () => {
    expect(listedModel('gpt-5-2-1', ['gpt-5', 'gpt-5-2'])).toBe('gpt-5-2');
    expect(listedModel('gpt-5-2-1', ['gpt-5-2', 'gpt-5'])).toBe('gpt-5-2');
  });

  it('resolves a list of wanted names in order, each model once, leaving out what is not there', () => {
    expect(listedModels(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'gpt-5.2', 'gemini-2.5-pro'], LISTED)).toEqual(['claude-sonnet-5', 'gpt-5.2']);
  });
});
