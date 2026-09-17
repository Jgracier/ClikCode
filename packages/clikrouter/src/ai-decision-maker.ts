import { logger } from '@/packages/core';

export async function decideWithTypesafe(req: any): Promise<any | null> {
  const apiKey = process.env.TYPESAFE_API_KEY || '';
  if (!apiKey) {
    logger.warn({ reason: 'no-typesafe-key' }, 'router.decision.typesafe.unconfigured');
    return null;
  }
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        state: { candidates: req.candidates, mode: req.mode, preferredModel: req.preferredModel },
        model: 'jev-latest',
        questions: {
          pick: {
            type: 'choice',
            instructions:
              'Return the best candidate as {provider:model} in the top_choice field. Provide confidence. If none, return null.',
          },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text }, 'router.decision.typesafe.error');
      return null;
    }
    const json = await res.json();
    // Expecting a structured response; be defensive.
    // Try common shapes: { top_choice: 'provider:model' } or { pick: { provider, model } }
    if (json?.top_choice && typeof json.top_choice === 'string') {
      const [provider, model] = (json.top_choice as string).split(':');
      if (provider && model) {
        return { provider, model, reason: 'typesafe' };
      }
    }
    if (json?.pick?.provider && json?.pick?.model) {
      return { provider: String(json.pick.provider), model: String(json.pick.model), reason: 'typesafe' };
    }
    // fallback: null
    logger.warn({ json }, 'router.decision.typesafe.unexpected');
    return null;
  } catch (err: any) {
    logger.error({ err }, 'router.decision.typesafe.exception');
    return null;
  }
}

export default decideWithTypesafe;
