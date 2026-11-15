import { describe, expect, it } from 'vitest';
import { VoiceReply, voicePresence, writesVoiceReply } from './voice-reply.js';

const decode = (seqs: string[]) => seqs.map((s) => {
  const body = /^\u001b\]7702;(.*)\u001b\\$/.exec(s)![1]!;
  return body.startsWith('d;') ? `d:${Buffer.from(body.slice(2), 'base64').toString('utf8')}` : body;
});

describe('the answer as words for the phone (OSC 7702)', () => {
  it('a turn: its start, what it adds as it streams, and its end', () => {
    const out: string[] = [];
    const reply = new VoiceReply((s) => out.push(s), true);
    reply.start();
    reply.answer('Sure, ');
    reply.answer('Sure, deploying — ');
    reply.answer('Sure, deploying — 🚀 done.');
    reply.end(false);
    expect(decode(out)).toEqual(['s', 'd:Sure, ', 'd:deploying — ', 'd:🚀 done.', 'e']);
  });

  it('a rewritten answer is not said twice, a stopped one says so, and nothing is sent outside a turn', () => {
    const out: string[] = [];
    const reply = new VoiceReply((s) => out.push(s), true);
    reply.answer('before any turn');
    reply.start();
    reply.answer('First try');
    reply.answer('Second try, longer');
    reply.answer('Second try, longer still');
    reply.end(true);
    reply.end(true);
    expect(decode(out)).toEqual(['s', 'd:First try', 'd: still', 'x']);
  });

  it('is written only for the phone', () => {
    expect(writesVoiceReply({ CLIKDEPLOY_CLIENT: 'mobile' })).toBe(true);
    expect(writesVoiceReply({})).toBe(false);
    const out: string[] = [];
    const off = new VoiceReply((s) => out.push(s), false);
    off.start();
    off.answer('x');
    off.end(false);
    expect(out).toEqual([]);
  });

  it('says ClikCode is here when it starts and gone when it leaves, only to the phone', () => {
    expect(voicePresence(true, { CLIKDEPLOY_CLIENT: 'mobile' })).toBe('\u001b]7702;h\u001b\\');
    expect(voicePresence(false, { CLIKDEPLOY_CLIENT: 'mobile' })).toBe('\u001b]7702;q\u001b\\');
    expect(voicePresence(true, {})).toBe('');
  });
});
