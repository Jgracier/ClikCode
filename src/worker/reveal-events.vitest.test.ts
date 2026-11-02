import { afterEach, expect, it, vi } from 'vitest';
import { ResponseReveal } from '../tui/render/response-reveal.js';
import { RevealEvents } from './reveal-events.js';
afterEach(() => vi.useRealTimers());
it('keeps the final snapshot and following events behind the live answer', () => {
  vi.useFakeTimers();
  const reveal = new ResponseReveal(() => undefined);
  const events: string[] = [];
  const delivery = new RevealEvents(reveal, (event: string) => events.push(event), (event) => event === 'end');
  delivery.push('delta');
  reveal.update(4000);
  delivery.push('end'); delivery.push('next');
  expect(events).toEqual(['delta']);
  reveal.flush();
  expect(events).toEqual(['delta', 'end', 'next']);
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds the hold and discards delayed events when leaving a chat', () => {
  vi.useFakeTimers();
  const reveal = new ResponseReveal(() => undefined);
  const events: string[] = [];
  const delivery = new RevealEvents(reveal, (event: string) => events.push(event), () => true);
  reveal.update(50000); delivery.push('end');
  delivery.dispose(); reveal.flush();
  expect(events).toEqual([]);
  reveal.update(50000); delivery.push('next end');
  vi.advanceTimersByTime(2600);
  expect(events).toEqual(['next end']);
});
