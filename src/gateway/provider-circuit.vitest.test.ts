import { describe, expect, it } from 'vitest';
import { ProviderCircuit } from './provider-circuit.js';

describe('provider availability circuit', () => {
  it('opens for a bounded outage and closes itself when it expires', () => {
    const circuit = new ProviderCircuit();
    expect(circuit.state(100).open).toBe(false);
    circuit.open(100, 300_000, 'all configured models exhausted');
    expect(circuit.state(101)).toEqual({ open: true, retryAt: 300_100, reason: 'all configured models exhausted' });
    expect(circuit.state(300_100)).toEqual({ open: false });
  });

  it('keeps the longer expiry when concurrent tasks report the same outage', () => {
    const circuit = new ProviderCircuit();
    circuit.open(100, 300_000, 'first');
    circuit.open(150, 60_000, 'second');
    expect(circuit.state(151)).toEqual({ open: true, retryAt: 300_100, reason: 'second' });
  });
});
