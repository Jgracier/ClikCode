/** A pass-through proxy in front of the ClikDeploy Gateway that records each
 * model step ClikCode makes: what the request carried (system prompt, tool
 * schemas, message count) and what the step cost (its usage, reasoning
 * tokens included, which ClikCode's own transcript does not keep), with the
 * time to first byte and to the end of the stream.
 *
 * Nothing secret is logged: no headers, no message text. */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

/** Starts the proxy; resolves to its base URL and a close function. */
export async function startGatewayLog(upstream, logFile) {
  const base = new URL(upstream);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers, host: base.host };
    delete headers['content-length'];
    delete headers.connection;
    const startedAt = Date.now();
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(new URL(req.url, base), { method: req.method, headers, body: body.length ? body : undefined, redirect: 'manual' });
    } catch (error) {
      res.writeHead(502).end(String(error));
      return;
    }
    const outHeaders = {};
    upstreamResponse.headers.forEach((value, name) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) outHeaders[name] = value; });
    res.writeHead(upstreamResponse.status, outHeaders);
    const step = req.method === 'POST' && req.url.includes('/chat/completions') ? describeRequest(body) : null;
    let text = '';
    let firstByteMs;
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        firstByteMs ??= Date.now() - startedAt;
        res.write(chunk);
        if (step) text += Buffer.from(chunk).toString('utf8');
      }
    }
    res.end();
    if (step) appendFileSync(logFile, `${JSON.stringify({ at: new Date(startedAt).toISOString(), status: upstreamResponse.status, firstByteMs, totalMs: Date.now() - startedAt, ...step, ...describeResponse(text) })}\n`);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

function describeRequest(body) {
  try {
    const request = JSON.parse(body.toString('utf8'));
    const system = (request.messages ?? []).filter((message) => message.role === 'system').map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('');
    return {
      model: request.model,
      messages: request.messages?.length ?? 0,
      systemChars: system.length,
      tools: request.tools?.length ?? 0,
      toolsChars: JSON.stringify(request.tools ?? []).length,
      ...(request.reasoning_effort ? { effort: request.reasoning_effort } : {}),
      // Each tool's schema size, on the first step only (they repeat).
      ...(request.messages?.length <= 2 ? { toolSizes: Object.fromEntries((request.tools ?? []).map((tool) => [tool.function?.name ?? tool.name, JSON.stringify(tool).length])) } : {}),
    };
  } catch {
    return { unparsed: true };
  }
}

/** The step's usage and what it visibly produced, from its SSE stream. */
function describeResponse(text) {
  let usage;
  let contentChars = 0;
  let toolArgChars = 0;
  const toolNames = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.startsWith('data: [DONE]')) continue;
    let event;
    try { event = JSON.parse(line.slice(6)); } catch { continue; }
    if (event.usage) usage = event.usage;
    const delta = event.choices?.[0]?.delta ?? {};
    if (typeof delta.content === 'string') contentChars += delta.content.length;
    for (const call of delta.tool_calls ?? []) {
      if (call.function?.name) toolNames.push(call.function.name);
      if (typeof call.function?.arguments === 'string') toolArgChars += call.function.arguments.length;
    }
  }
  return {
    output: usage?.completion_tokens ?? null,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    input: usage?.prompt_tokens ?? null,
    cached: usage?.prompt_tokens_details?.cached_tokens ?? null,
    contentChars,
    toolArgChars,
    toolNames,
  };
}
