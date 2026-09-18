function reportTypesafeDecision(event: string, details: Record<string, unknown> = {}): void {
  if (process.env.CLIKROUTER_DEBUG !== '1') return;
  process.stderr.write(`${JSON.stringify({ event, ...details })}\n`);
}

export async function decideWithTypesafe(req: any, explicitApiKey?: string): Promise<any | null> {
  const apiKey = explicitApiKey || process.env.TYPESAFE_API_KEY || '';
  if (!apiKey) {
    reportTypesafeDecision('router.decision.typesafe.unconfigured', { reason: 'no-typesafe-key' });
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
      reportTypesafeDecision('router.decision.typesafe.error', { status: res.status, body: text });
      return null;
    }
    const json = await res.json() as {
      top_choice?: unknown;
      pick?: { provider?: unknown; model?: unknown };
    };
    // Expecting a structured response; be defensive.
    // Try common shapes: { top_choice: 'provider:model' } or { pick: { provider, model } }
    if (json?.top_choice && typeof json.top_choice === 'string') {
      const [provider, model] = (json.top_choice as string).split(':');
      if (provider && model) {
        const admitted = req.candidates?.some((candidate: any) => candidate.provider === provider && candidate.model === model);
        if (admitted) return { provider, model, reason: 'typesafe' };
      }
    }
    if (json?.pick?.provider && json?.pick?.model) {
      const provider = String(json.pick.provider);
      const model = String(json.pick.model);
      const admitted = req.candidates?.some((candidate: any) => candidate.provider === provider && candidate.model === model);
      if (admitted) return { provider, model, reason: 'typesafe' };
    }
    // fallback: null
    reportTypesafeDecision('router.decision.typesafe.unexpected', { json });
    return null;
  } catch (error) {
    reportTypesafeDecision('router.decision.typesafe.exception', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export default decideWithTypesafe;
