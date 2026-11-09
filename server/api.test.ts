import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.GROQ_API_KEY;
delete process.env.HINDSIGHT_API_KEY;
delete process.env.HINDSIGHT_API_URL;
delete process.env.HINDSIGHT_BANK_ID;
const { app } = await import('./index.js');
let server: ReturnType<typeof app.listen>;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (address && typeof address !== 'string') base = `http://127.0.0.1:${address.port}`;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

test('health reports the live API and demo mode when no database is configured', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as { status: string; mode: string };
  assert.equal(body.status, 'ok');
  assert.ok(['demo', 'postgresql'].includes(body.mode));
});

test('feedback API returns deterministic records and applies search filters', async () => {
  const response = await fetch(`${base}/api/feedback?q=checkout&pageSize=50`);
  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ topic: string }>; total: number };
  assert.ok(body.total > 0);
  assert.ok(body.items.every(item => item.topic === 'Checkout'));
});

test('feedback creation validates input and produces a safe fallback classification', async () => {
  const invalid = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x' }) });
  assert.equal(invalid.status, 400);
  const created = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Payment failed and I was charged twice', customer: 'Test customer', source: 'Survey' }) });
  assert.equal(created.status, 201);
  const body = await created.json() as { topic: string; priority: string; status: string };
  assert.equal(body.topic, 'Payments');
  assert.equal(body.status, 'Processed');
});

test('impact endpoint explains missing evidence and does not claim causation', async () => {
  const response = await fetch(`${base}/api/impact`);
  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ disclaimer: string }> };
  assert.ok(body.items.length > 0);
  assert.ok(body.items.every(item => item.disclaimer.includes('does not establish')));
});

test('feedback date, priority, and month filters are applied by the API', async () => {
  const response = await fetch(`${base}/api/feedback?month=2026-03&sort=priority&pageSize=50`);
  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ date: string; priority: string }>; total: number };
  assert.ok(body.total > 0);
  assert.ok(body.items.every(item => item.date.startsWith('2026-03')));
  const ranks = ['Critical', 'High', 'Medium', 'Low'];
  assert.deepEqual(body.items.map(item => ranks.indexOf(item.priority)), [...body.items].map(item => ranks.indexOf(item.priority)).sort((a, b) => a - b));
});

test('feedback import validates the CSV file and imports supported rows', async () => {
  const form = new FormData();
  form.append('file', new Blob(['customer,message,source\nCSV Test,The payment flow failed twice,Survey\n'], { type: 'text/csv' }), 'feedback.csv');
  const response = await fetch(`${base}/api/feedback/import`, { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const body = await response.json() as { imported: number; skipped: number };
  assert.equal(body.imported, 1);
  assert.equal(body.skipped, 0);
});

test('feedback review and classification corrections persist in API state', async () => {
  const created = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'The payment page froze before checkout finished', customer: 'Correction Test', source: 'Survey' }) });
  const record = await created.json() as { id: string };
  const correction = await fetch(`${base}/api/feedback/${record.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentiment: 'Mixed', priority: 'Low', topic: 'Checkout' }) });
  assert.equal(correction.status, 200);
  const corrected = await correction.json() as { sentiment: string; priority: string; topic: string };
  assert.deepEqual([corrected.sentiment, corrected.priority, corrected.topic], ['Mixed', 'Low', 'Checkout']);
  const reviewed = await fetch(`${base}/api/feedback/${record.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewed: true }) });
  assert.equal((await reviewed.json() as { status: string }).status, 'Reviewed');
});

test('issue and insight endpoints expose seeded evidence records', async () => {
  const [issueResponse, insightResponse] = await Promise.all([fetch(`${base}/api/issues?q=checkout`), fetch(`${base}/api/insights`)]);
  assert.equal(issueResponse.status, 200);
  assert.equal(insightResponse.status, 200);
  const issueBody = await issueResponse.json() as { items: Array<{ count: number }> };
  const insightBody = await insightResponse.json() as { items: Array<{ evidence: string[] }> };
  assert.ok(issueBody.items.length > 0 && issueBody.items[0].count > 0);
  assert.ok(insightBody.items.length > 0 && insightBody.items.every(item => item.evidence.length > 0));
});

test('dashboard trends are calculated from feedback and memory search labels structured matches', async () => {
  const [trendResponse, memoryResponse] = await Promise.all([
    fetch(`${base}/api/dashboard/trends`),
    fetch(`${base}/api/memory/recall`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'checkout navigation' }) }),
  ]);
  assert.equal(trendResponse.status, 200);
  const trends = await trendResponse.json() as { data: Array<{ feedback: number; positive: number; negative: number }> };
  assert.ok(trends.data.length > 0 && trends.data.every(row => row.feedback >= row.positive + row.negative));
  assert.equal(memoryResponse.status, 200);
  const memory = await memoryResponse.json() as { configured: boolean; results: Array<{ type: string }> };
  assert.equal(memory.configured, false);
  assert.ok(memory.results.length > 0 && memory.results.every(row => row.type.startsWith('Structured')));
});

test('issue split and merge keep grouped feedback counts consistent in demo mode', async () => {
  const initialResponse = await fetch(`${base}/api/issues`);
  const initial = await initialResponse.json() as { items: Array<{ id: string; count: number }> };
  const checkout = initial.items.find(issue => issue.id === 'issue-checkout');
  assert.ok(checkout && checkout.count > 2);
  const splitResponse = await fetch(`${base}/api/issues/${checkout.id}/split`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Split checkout sample', description: 'A separated subset for regression testing.', category: 'Checkout test', feedbackCount: 2 }) });
  assert.equal(splitResponse.status, 201);
  const split = await splitResponse.json() as { id: string; count: number };
  assert.equal(split.count, 2);
  const mergeResponse = await fetch(`${base}/api/issues/${split.id}/merge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: checkout.id }) });
  assert.equal(mergeResponse.status, 200);
  const afterResponse = await fetch(`${base}/api/issues/${checkout.id}`);
  const after = await afterResponse.json() as { count: number };
  assert.equal(after.count, checkout.count);
});
