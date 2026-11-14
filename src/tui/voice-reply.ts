/** The answer as words, for ClikDeploy's phone, which can read it aloud (its terminal's voice: the person talks, ClikCode answers out
 * loud, and talking over it stops it). A private OSC, written only for that page (CLIKDEPLOY_CLIENT=mobile), which swallows it; it draws
 * nothing on any terminal, and xterm-based ones drop an OSC they do not know.
 *   OSC 7702 ; s ST              a turn's answer begins
 *   OSC 7702 ; d ; <base64> ST   more of it (UTF-8 text, as it streams)
 *   OSC 7702 ; e ST              it ended   (x: it was stopped)
 * Only text that grows the answer is sent: a replacement that rewrites what was already sent (a retry on another account) is not said
 * twice; its new end is. */
import { stdout } from 'node:process';

export const writesVoiceReply = (env: NodeJS.ProcessEnv = process.env): boolean => env.CLIKDEPLOY_CLIENT === 'mobile';

const osc = (body: string) => `\u001b]7702;${body}\u001b\\`;

export class VoiceReply {
  private open = false;
  private sent = '';

  constructor(
    private readonly write: (sequence: string) => void = (sequence) => void stdout.write(sequence),
    private readonly on = writesVoiceReply(),
  ) {}

  start(): void {
    if (!this.on) return;
    this.open = true;
    this.sent = '';
    this.write(osc('s'));
  }

  /** The answer so far, whole. */
  answer(text: string): void {
    if (!this.on || !this.open || text.length <= this.sent.length) return;
    const grows = text.startsWith(this.sent);
    const piece = grows ? text.slice(this.sent.length) : '';
    this.sent = text;
    if (piece) this.write(osc(`d;${Buffer.from(piece, 'utf8').toString('base64')}`));
  }

  end(stopped: boolean): void {
    if (!this.on || !this.open) return;
    this.open = false;
    this.write(osc(stopped ? 'x' : 'e'));
  }
}
