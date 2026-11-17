/** Briefly suppress repeated model requests when every configured provider is unavailable. This is process-local: it avoids
 * repeating a known outage across parallel connector tasks but does not persist a provider's temporary failure across restarts. */
export class ProviderCircuit {
  private until = 0;
  private reason = '';

  state(now = Date.now()): { open: boolean; retryAt?: number; reason?: string } {
    if (this.until <= now) { this.until = 0; this.reason = ''; return { open: false }; }
    return { open: true, retryAt: this.until, reason: this.reason };
  }

  open(now: number, durationMs: number, reason: string): void {
    this.until = Math.max(this.until, now + durationMs);
    this.reason = reason.slice(0, 180);
  }
}
