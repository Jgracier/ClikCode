import { describe, expect, it } from 'vitest';
import { acpSessionModels } from './acp-query.js';

describe('ACP model discovery', () => {
  it('reads model choices and current value from session config options', () => {
    expect(acpSessionModels({ configOptions: [{
      id: 'model', currentValue: 'devstral-latest', options: [
        { value: 'devstral-latest', name: 'Devstral Latest' },
        { value: 'mistral-medium', name: 'Mistral Medium' },
      ],
    }] })).toEqual({
      models: ['devstral-latest', 'mistral-medium'],
      labels: { 'devstral-latest': 'Devstral Latest', 'mistral-medium': 'Mistral Medium' },
      current: 'devstral-latest',
    });
  });
});
