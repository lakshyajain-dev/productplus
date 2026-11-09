import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HindsightClient } from '@vectorize-io/hindsight-client';

const groqKey = process.env.GROQ_API_KEY;
const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const hindsightReady = Boolean(process.env.HINDSIGHT_API_URL && process.env.HINDSIGHT_API_KEY && process.env.HINDSIGHT_BANK_ID);

test('Groq chat completions return valid JSON when credentials are configured', { skip: !groqKey }, async () => {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${groqKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: groqModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return JSON with one key named status and a short string value.' },
        { role: 'user', content: 'Reply with status ready.' },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, `Groq returned HTTP ${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  assert.ok(content, 'Groq response did not contain message content');
  const parsed = JSON.parse(content) as { status?: string };
  assert.equal(typeof parsed.status, 'string');
});

test('Hindsight retain, recall, and reflect work when credentials are configured', { skip: !hindsightReady }, async () => {
  const client = new HindsightClient({ baseUrl: process.env.HINDSIGHT_API_URL!, apiKey: process.env.HINDSIGHT_API_KEY! });
  const bankId = process.env.HINDSIGHT_BANK_ID!;
  const marker = `ProductPulse integration verification ${randomUUID()}`;
  const retained = await client.retain(bankId, `${marker}. This is a synthetic test memory, not customer data.`, {
    timestamp: new Date(),
    context: 'ProductPulse automated integration check',
    metadata: { sourceType: 'integration_test' },
  });
  assert.ok(retained, 'Hindsight retain returned no result');
  const recalled = await client.recall(bankId, marker, { budget: 'low' });
  assert.ok(recalled, 'Hindsight recall returned no result');
  const reflected = await client.reflect(bankId, `Summarize any retained context for: ${marker}`, {
    budget: 'low',
    context: 'Automated integration check; describe uncertainty.',
  });
  assert.equal(typeof reflected.text, 'string');
});
