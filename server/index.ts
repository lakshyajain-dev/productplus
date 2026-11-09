import dotenv from 'dotenv';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import Papa from 'papaparse';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { z } from 'zod';
import { demoFeedback, demoIssues, demoInsights, demoUpdates } from '../src/lib/demo.js';
import type { Feedback, Insight, Issue, ProductUpdate } from '../src/lib/types.js';

if (process.env.NODE_ENV !== 'test') dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);
const prisma = new PrismaClient();
let databaseReady = false;
let feedback = [...demoFeedback];
let issues = [...demoIssues];
let insights = [...demoInsights];
let updates = [...demoUpdates];
const memorySync: Array<{ id: string; sourceId: string; sourceType: string; status: string; content: string; createdAt: string; error?: string }> = [];
const retrievals: Array<{ query: string; count: number; at: string; kind: string }> = [];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

const hindsightConfig = () => Boolean(process.env.HINDSIGHT_API_KEY && process.env.HINDSIGHT_API_URL && process.env.HINDSIGHT_BANK_ID);
const hindsight = () => new HindsightClient({ baseUrl: process.env.HINDSIGHT_API_URL!, apiKey: process.env.HINDSIGHT_API_KEY! });
const bankId = () => process.env.HINDSIGHT_BANK_ID || 'ProductPulse';
let workspaceId = process.env.PRODUCTPULSE_WORKSPACE_ID;
let workspaceName = process.env.PRODUCTPULSE_WORKSPACE_NAME || 'Northstar Studio';
let workspaceSlug = 'productpulse-demo';

for (const item of demoFeedback) { const related = demoIssues.find(issue => issue.category === item.topic || (item.topic === 'Payments' && issue.id === 'issue-checkout')); memorySync.push({ id: `demo-memory-${item.id}`, sourceId: item.id, sourceType: 'feedback', status: 'pending', content: `Customer feedback (${item.date}) in ${item.topic}. Sentiment: ${item.sentiment}. Priority: ${item.priority}. Summary: ${item.summary}.${related ? ` Related issue ${related.id}.` : ''} Reference: ${item.id}.`, createdAt: item.date }); }
for (const item of demoIssues) memorySync.push({ id: `demo-memory-${item.id}`, sourceId: item.id, sourceType: 'issue', status: 'pending', content: `Product issue ${item.title} in ${item.category}. First reported ${item.firstSeen}, latest report ${item.lastSeen}. Current status: ${item.status}. Evidence count: ${item.count}. Reference: ${item.id}.`, createdAt: item.firstSeen });
for (const item of demoUpdates.filter(x => ['Released', 'Monitoring'].includes(x.status))) memorySync.push({ id: `demo-memory-${item.id}`, sourceId: item.id, sourceType: 'product_update', status: 'pending', content: `Product update ${item.title} (${item.status}) in ${item.area}, date ${item.date}. Description: ${item.description}. Expected outcome: ${item.outcome}. Related issues: ${item.issueIds.join(', ') || 'none'}. Reference: ${item.id}.`, createdAt: item.date });

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 160, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api', (req, res, next) => {
  const secret = process.env.PRODUCTPULSE_PROXY_SECRET;
  if (req.path === '/health' || (!secret && process.env.NODE_ENV !== 'production')) return next();
  if (!secret || req.get('x-productpulse-proxy-secret') !== secret) return res.status(403).json({ error: 'Forbidden' });
  next();
});

function classifyLocally(message: string, source = 'In-app feedback', customer = 'New customer'): Feedback {
  const lower = message.toLowerCase();
  const tags: Array<[string[], string, Feedback['sentiment'], Feedback['priority']]> = [
    [['pay', 'charge', 'card'], 'Payments', 'Negative', 'High'], [['checkout', 'cart', 'order'], 'Checkout', 'Negative', 'High'],
    [['slow', 'load', 'freeze'], 'Performance', 'Negative', 'Medium'], [['login', 'password', 'session'], 'Authentication', 'Negative', 'High'],
    [['onboard', 'setup', 'connect'], 'Onboarding', 'Negative', 'Medium'], [['price', 'cost', 'expensive'], 'Pricing', 'Mixed', 'Medium'],
    [['outage', 'down', 'unavailable'], 'Reliability', 'Negative', 'Critical'], [['feature', 'would be great', 'request'], 'Features', 'Neutral', 'Medium'],
  ];
  const found = tags.find(([words]) => words.some(word => lower.includes(word)));
  const topic = found?.[1] || 'Other';
  const positive = /great|love|helpful|thank|amazing|easy/.test(lower);
  const sentiment = positive ? 'Positive' : (found?.[2] || 'Neutral');
  const summary = message.length > 138 ? `${message.slice(0, 135).trim()}…` : message;
  return { id: randomUUID(), customer, initials: customer.split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase(), message, source, topic, sentiment, priority: found?.[3] || 'Low', date: new Date().toISOString().slice(0, 10), status: 'Processed', summary, intent: lower.includes('would be') || lower.includes('request') ? 'Request a feature' : 'Share feedback', confidence: found ? 84 : 62, keywords: topic === 'Other' ? [] : [topic.toLowerCase()], demo: false };
}

async function groqJson<T>(system: string, prompt: string, fallback: T): Promise<T> {
  if (!process.env.GROQ_API_KEY) return fallback;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(18000),
      });
      if (!response.ok) throw new Error(`Groq returned HTTP ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = payload.choices?.[0]?.message?.content;
      if (!text) throw new Error('Groq returned an empty response');
      return JSON.parse(text) as T;
    } catch (error) {
      if (attempt === 1) console.warn('Groq request failed; using safe fallback:', error instanceof Error ? error.message : 'unknown error');
    }
  }
  return fallback;
}

async function classifyFeedback(message: string, source: string, customer: string): Promise<Feedback> {
  const local = classifyLocally(message, source, customer);
  const result = await groqJson<{ sentiment: string; topic: string; subtopic: string; urgency: string; intent: string; summary: string; keywords: string[]; confidence: number }>(
    'Classify customer feedback. Return a single JSON object with sentiment (Positive, Negative, Neutral, Mixed), topic, subtopic, urgency (Critical, High, Medium, Low), intent, summary, keywords array, and confidence number 0-100. Never include personal data beyond the input.',
    message,
    { sentiment: local.sentiment, topic: local.topic, subtopic: '', urgency: local.priority, intent: local.intent, summary: local.summary, keywords: local.keywords, confidence: local.confidence },
  );
  const valid = z.object({ sentiment: z.enum(['Positive', 'Negative', 'Neutral', 'Mixed']), topic: z.string().min(1).max(80), subtopic: z.string().max(80), urgency: z.enum(['Critical', 'High', 'Medium', 'Low']), intent: z.string().min(1).max(100), summary: z.string().min(1).max(500), keywords: z.array(z.string().max(50)).max(12), confidence: z.number().min(0).max(100) }).safeParse(result);
  if (!valid.success) return local;
  return { ...local, sentiment: valid.data.sentiment, topic: valid.data.topic, priority: valid.data.urgency, intent: valid.data.intent, summary: valid.data.summary, keywords: valid.data.keywords, confidence: valid.data.confidence };
}

function memoryContent(item: Feedback | Issue | ProductUpdate): string {
  if ('message' in item) { const related = issues.find(issue => issue.category === item.topic || (item.topic === 'Payments' && issue.id === 'issue-checkout')); return `Customer feedback (${item.date}) in ${item.topic}. Sentiment: ${item.sentiment}. Priority: ${item.priority}. Summary: ${item.summary}.${related ? ` Related issue ${related.id}.` : ''} Reference: ${item.id}.`; }
  if ('category' in item) return `Product issue ${item.title} in ${item.category}. First reported ${item.firstSeen}, latest report ${item.lastSeen}. Current status: ${item.status}. Evidence count: ${item.count}. Reference: ${item.id}.`;
  return `Product update ${item.title} (${item.status}) in ${item.area}, date ${item.date}. Description: ${item.description}. Expected outcome: ${item.outcome}. Related issues: ${item.issueIds.join(', ') || 'none'}. Reference: ${item.id}.`;
}

async function attachFeedbackToIssue(item: Feedback) {
  const related = issues.find(issue => issue.category === item.topic || (item.topic === 'Payments' && issue.id === 'issue-checkout'));
  if (!related) return;
  if (databaseReady) {
    await prisma.issueFeedback.create({ data: { issueId: related.id, feedbackId: item.id } });
    await prisma.issue.update({ where: { id: related.id }, data: { lastSeen: new Date(item.date) } });
  }
  related.count += 1; related.lastSeen = item.date;
}

async function persistMemoryStatus(item: Feedback | Issue | ProductUpdate, sourceType: string, contentHash: string, syncStatus: string, lastError: string | null) {
  if (!databaseReady || !workspaceId) return;
  const link = sourceType === 'feedback' ? { feedbackId: item.id } : sourceType === 'issue' ? { issueId: item.id } : { productUpdateId: item.id };
  await prisma.memoryReference.upsert({ where: { contentHash }, create: { workspaceId, bankId: bankId(), sourceType, sourceId: item.id, contentHash, syncStatus, lastError, ...(syncStatus === 'synced' ? { retainedAt: new Date() } : {}), ...link }, update: { syncStatus, lastError, ...(syncStatus === 'synced' ? { retainedAt: new Date() } : {}) } }).catch(error => console.warn('Could not persist Hindsight sync status:', error instanceof Error ? error.message : 'database write failed'));
}

async function retainMemory(item: Feedback | Issue | ProductUpdate, sourceType: string) {
  const content = memoryContent(item);
  const hash = createHash('sha256').update(`${sourceType}:${item.id}:${content}`).digest('hex');
  let entry = memorySync.find(x => x.sourceId === item.id && x.sourceType === sourceType);
  if (!entry) { entry = { id: randomUUID(), sourceId: item.id, sourceType, status: 'pending', content, createdAt: new Date().toISOString() }; memorySync.push(entry); }
  if (entry.status === 'synced' && entry.content === content) return entry;
  entry.content = content; entry.status = 'pending'; entry.error = undefined;
  if (!hindsightConfig()) { entry.status = 'not_configured'; entry.error = 'Hindsight credentials are not configured.'; await persistMemoryStatus(item, sourceType, hash, entry.status, entry.error); return entry; }
  try {
    const date = 'date' in item ? item.date : 'firstSeen' in item ? item.firstSeen : new Date().toISOString();
    await hindsight().retain(bankId(), content, { timestamp: new Date(date), context: `ProductPulse ${sourceType}`, metadata: { sourceType, sourceId: item.id, contentHash: hash } });
    entry.status = 'synced'; entry.error = undefined;
    await persistMemoryStatus(item, sourceType, hash, 'synced', null);
  } catch (error) {
    entry.status = 'failed'; entry.error = error instanceof Error ? error.message : 'Hindsight request failed';
    await persistMemoryStatus(item, sourceType, hash, 'failed', entry.error);
  }
  return entry;
}

async function historicalRecall(query: string) {
  if (!hindsightConfig()) return { configured: false, results: [], error: 'Hindsight is not configured. Add server-side credentials to enable historical memory.' };
  try {
    const result = await hindsight().recall(bankId(), query, { budget: 'mid' });
    const rows = (result as { results?: Array<{ text?: string; type?: string }> }).results || [];
    retrievals.unshift({ query, count: rows.length, at: new Date().toISOString(), kind: 'recall' });
    return { configured: true, results: rows.map((r, i) => ({ id: `memory-${i}`, text: r.text || '', type: r.type || 'memory' })) };
  } catch (error) {
    return { configured: true, results: [], error: error instanceof Error ? error.message : 'Recall failed' };
  }
}

function issueToClient(row: Issue): Issue { return row; }
function feedbackToClient(row: Feedback): Feedback { return row; }
function dateWithin(date: string, start: Date, end: Date) { const d = new Date(date); return d >= start && d <= end; }

const feedbackSchema = z.object({ message: z.string().trim().min(4).max(5000), customer: z.string().trim().min(1).max(120).default('Anonymous customer'), source: z.string().trim().min(1).max(80).default('In-app feedback') });
const issueUpdateSchema = z.object({ status: z.enum(['New', 'Investigating', 'Planned', 'In Progress', 'Resolved', 'Monitoring']).optional(), severity: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(), title: z.string().min(3).max(160).optional() });

app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: 'ProductPulse', mode: databaseReady ? 'postgresql' : 'demo', time: new Date().toISOString() }));
app.get('/api/settings/workspace', (_req, res) => res.json({ name: workspaceName, slug: workspaceSlug }));
app.patch('/api/settings/workspace', async (req, res, next) => { try { const parsed = z.object({ name: z.string().trim().min(2).max(80) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Workspace name must be between 2 and 80 characters.' }); workspaceName = parsed.data.name; if (databaseReady) { const workspace = workspaceId ? await prisma.workspace.update({ where: { id: workspaceId }, data: { name: workspaceName } }) : await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } }).then(row => row ? prisma.workspace.update({ where: { id: row.id }, data: { name: workspaceName } }) : null); if (workspace) { workspaceName = workspace.name; workspaceSlug = workspace.slug; } } res.json({ name: workspaceName, slug: workspaceSlug }); } catch (error) { next(error); } });
app.get('/api/health/integrations', async (_req, res) => {
  const result: Record<string, unknown> = { database: { status: databaseReady ? 'connected' : process.env.DATABASE_URL ? 'configured_unverified' : 'not_configured' }, groq: { status: process.env.GROQ_API_KEY ? 'configured_unverified' : 'not_configured', model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b' }, hindsight: { status: hindsightConfig() ? 'configured_unverified' : 'not_configured', bankId: process.env.HINDSIGHT_BANK_ID || null } };
  if (hindsightConfig()) {
    try { await hindsight().getVersion(); result.hindsight = { status: 'connected', bankId: bankId() }; }
    catch (error) { result.hindsight = { status: 'error', bankId: bankId(), message: error instanceof Error ? error.message : 'Hindsight check failed' }; }
  }
  if (process.env.GROQ_API_KEY) {
    try {
      const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
      const check = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` }, signal: AbortSignal.timeout(9000) });
      if (!check.ok) result.groq = { status: 'error', model, message: `Groq returned HTTP ${check.status}` };
      else {
        const payload = await check.json() as { data?: Array<{ id?: string }> };
        const available = payload.data?.some(item => item.id === model) || false;
        result.groq = { status: available ? 'connected' : 'error', model, ...(!available ? { message: `The configured model is not available to this Groq key: ${model}` } : {}) };
      }
    }
    catch (error) { result.groq = { status: 'error', model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', message: error instanceof Error ? error.message : 'Groq check failed' }; }
  }
  res.json(result);
});

app.get('/api/dashboard/overview', (_req, res) => {
  const negative = feedback.filter(x => x.sentiment === 'Negative' || x.sentiment === 'Mixed').length;
  const monthKey = (date: string) => date.slice(0, 7);
  const months = [...new Set(feedback.map(x => monthKey(x.date)))].sort(); const currentMonth = months.at(-1) || ''; const previousMonth = months.at(-2) || '';
  const currentRows = feedback.filter(x => monthKey(x.date) === currentMonth); const previousRows = feedback.filter(x => monthKey(x.date) === previousMonth);
  const currentNegative = currentRows.filter(x => ['Negative', 'Mixed'].includes(x.sentiment)).length; const previousNegative = previousRows.filter(x => ['Negative', 'Mixed'].includes(x.sentiment)).length;
  const pct = (current: number, previous: number) => previous ? Math.round(((current - previous) / previous) * 1000) / 10 : current ? 100 : 0;
  const dateCounts = [...feedback].sort((a, b) => b.date.localeCompare(a.date));
  const monthChange = currentMonth ? new Date(`${currentMonth}-01T12:00:00`).toLocaleDateString('en-US', { month: 'short' }) : 'latest';
  const computedTrend = months.slice(-6).map(month => { const rows = feedback.filter(x => monthKey(x.date) === month); return { month: new Date(`${month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'short' }), feedback: rows.length, positive: rows.filter(x => x.sentiment === 'Positive').length, neutral: rows.filter(x => x.sentiment === 'Neutral').length, negative: rows.filter(x => ['Negative', 'Mixed'].includes(x.sentiment)).length }; });
  res.json({ totalFeedback: feedback.length, negativeFeedback: negative, negativePercent: feedback.length ? Math.round(negative / feedback.length * 100) : 0, openIssues: issues.filter(x => !['Resolved', 'Monitoring'].includes(x.status)).length, criticalIssues: issues.filter(x => x.severity === 'Critical' && !['Resolved', 'Monitoring'].includes(x.status)).length, emergingTrends: issues.filter(x => x.trend === 'Increasing').length, insightsGenerated: insights.length, comparisonLabel: `${monthChange} vs prior sample month`, changes: { feedback: pct(currentRows.length, previousRows.length), negative: pct(currentNegative, previousNegative), openIssues: issues.filter(x => monthKey(x.firstSeen) === currentMonth && !['Resolved', 'Monitoring'].includes(x.status)).length, criticalIssues: issues.filter(x => monthKey(x.firstSeen) === currentMonth && x.severity === 'Critical').length, trends: issues.filter(x => monthKey(x.firstSeen) === currentMonth && x.trend === 'Increasing').length, insights: insights.filter(x => monthKey(x.date) === currentMonth).length }, latestFeedbackDate: dateCounts[0]?.date || null, trendData: computedTrend, sentiment: ['Positive', 'Neutral', 'Negative', 'Mixed'].map(name => ({ name, value: feedback.filter(x => x.sentiment === name).length })), sources: [...new Set(feedback.map(x => x.source))].map(name => ({ name, value: feedback.filter(x => x.source === name).length })).sort((a, b) => b.value - a.value).slice(0, 5), topIssues: issues.slice(0, 4), recentInsights: insights.slice(0, 3) });
});
app.get('/api/dashboard/trends', (_req, res) => { const months = [...new Set(feedback.map(item => item.date.slice(0, 7)))].sort().slice(-6); const data = months.map(month => { const rows = feedback.filter(item => item.date.slice(0, 7) === month); return { month: new Date(`${month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'short' }), feedback: rows.length, positive: rows.filter(item => item.sentiment === 'Positive').length, negative: rows.filter(item => ['Negative', 'Mixed'].includes(item.sentiment)).length }; }); res.json({ data }); });
app.get('/api/dashboard/sentiment', (_req, res) => res.json(['Positive', 'Neutral', 'Negative', 'Mixed'].map(name => ({ name, value: feedback.filter(x => x.sentiment === name).length }))));

app.get('/api/feedback', (req, res) => {
  const query = String(req.query.q || '').toLowerCase();
  const sentiment = String(req.query.sentiment || ''); const source = String(req.query.source || ''); const topic = String(req.query.topic || ''); const priority = String(req.query.priority || '');
  const month = String(req.query.month || ''); const sort = String(req.query.sort || 'newest');
  let rows = feedback.filter(x => (!query || `${x.message} ${x.customer} ${x.topic}`.toLowerCase().includes(query)) && (!sentiment || sentiment === 'All sentiments' || x.sentiment === sentiment) && (!source || source === 'All sources' || x.source === source) && (!topic || topic === 'All topics' || x.topic === topic) && (!priority || priority === 'All priorities' || x.priority === priority) && (!month || /^\d{4}-\d{2}$/.test(month) && x.date.startsWith(month)));
  rows = rows.sort(sort === 'oldest' ? (a, b) => a.date.localeCompare(b.date) : sort === 'priority' ? (a, b) => ['Critical','High','Medium','Low'].indexOf(a.priority) - ['Critical','High','Medium','Low'].indexOf(b.priority) : (a, b) => b.date.localeCompare(a.date));
  const page = Math.max(1, Number(req.query.page || 1)); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
  res.json({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize });
});
app.post('/api/feedback', async (req, res, next) => {
  try {
    const parsed = feedbackSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid feedback', details: parsed.error.flatten() });
    const result = await classifyFeedback(parsed.data.message, parsed.data.source, parsed.data.customer);
    if (databaseReady && workspaceId) {
      const row = await prisma.feedback.create({ data: { workspaceId, customerName: parsed.data.customer, message: result.message, source: result.source, receivedAt: new Date(), processingState: 'processed', classification: { create: { sentiment: result.sentiment, topic: result.topic, urgency: result.priority, intent: result.intent, summary: result.summary, keywords: result.keywords, confidence: result.confidence } } }, include: { classification: true } });
      result.id = row.id; result.date = row.receivedAt.toISOString().slice(0, 10);
    }
    await attachFeedbackToIssue(result);
    feedback.unshift(result);
    void retainMemory(result, 'feedback');
    res.status(201).json(result);
  } catch (error) { next(error); }
});
app.get('/api/feedback/export', (_req, res) => { const csv = Papa.unparse(feedback.map(({ id, customer, message, source, topic, sentiment, priority, date, status }) => ({ id, customer, message, source, topic, sentiment, priority, date, status }))); res.type('text/csv').attachment('productpulse-feedback.csv').send(csv); });
app.post('/api/feedback/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Select a CSV file first.' });
    if (!req.file.originalname.toLowerCase().endsWith('.csv')) return res.status(415).json({ error: 'Only CSV files are supported.' });
    const parsed = Papa.parse<Record<string, string>>(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true, transformHeader: h => h.trim().toLowerCase() });
    if (parsed.errors.length || parsed.data.length > 500) return res.status(400).json({ error: parsed.data.length > 500 ? 'A CSV can contain up to 500 rows.' : 'Could not read the CSV header or rows.' });
    const created: Feedback[] = [];
    for (const row of parsed.data) {
      const candidate = feedbackSchema.safeParse({ message: row.message || row.feedback || row.text, customer: row.customer || row.name || 'CSV customer', source: row.source || 'CSV import' });
      if (candidate.success) {
        const item = await classifyFeedback(candidate.data.message, candidate.data.source, candidate.data.customer);
        if (databaseReady && workspaceId) { const record = await prisma.feedback.create({ data: { workspaceId, customerName: item.customer, message: item.message, source: item.source, receivedAt: new Date(item.date), processingState: 'processed', classification: { create: { sentiment: item.sentiment, topic: item.topic, urgency: item.priority, intent: item.intent, summary: item.summary, keywords: item.keywords, confidence: item.confidence } } } }); item.id = record.id; }
        await attachFeedbackToIssue(item);
        created.push(item);
      }
    }
    if (!created.length) return res.status(400).json({ error: 'No valid rows found. Include a message, feedback, or text column.' });
    feedback.unshift(...created); created.forEach(item => void retainMemory(item, 'feedback'));
    res.status(201).json({ imported: created.length, skipped: parsed.data.length - created.length, items: created });
  } catch (error) { next(error); }
});
app.get('/api/feedback/facets', (_req, res) => res.json({ sources: [...new Set(feedback.map(x => x.source))].sort(), topics: [...new Set(feedback.map(x => x.topic))].sort(), months: [...new Set(feedback.map(x => x.date.slice(0, 7)))].sort().reverse() }));
app.get('/api/feedback/:id', async (req, res) => { const item = feedback.find(x => x.id === req.params.id); if (!item) return res.status(404).json({ error: 'Feedback not found' }); const relatedIssue = issues.find(issue => issue.category === item.topic || (item.topic === 'Payments' && issue.id === 'issue-checkout')); const recall = await historicalRecall(`Historical customer reports related to ${item.topic}: ${item.summary}`); res.json({ ...item, related: feedback.filter(x => x.id !== item.id && (x.topic === item.topic || x.keywords.some(k => item.keywords.includes(k)))).slice(0, 5), relatedIssue, historicalMemories: recall.results, memoryStatus: recall.error ? 'unavailable' : recall.configured ? 'retrieved' : 'not_configured', memoryError: recall.error }); });
app.patch('/api/feedback/:id', async (req, res, next) => { try { const item = feedback.find(x => x.id === req.params.id); if (!item) return res.status(404).json({ error: 'Feedback not found' }); const schema = z.object({ sentiment: z.enum(['Positive', 'Negative', 'Neutral', 'Mixed']).optional(), topic: z.string().max(80).optional(), priority: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(), reviewed: z.boolean().optional() }); const patch = schema.safeParse(req.body); if (!patch.success) return res.status(400).json({ error: 'Invalid correction', details: patch.error.flatten() }); const { reviewed, ...corrections } = patch.data; Object.assign(item, corrections); if (reviewed) item.status = 'Reviewed'; if (databaseReady) { const existing = await prisma.feedbackClassification.findUnique({ where: { feedbackId: item.id }, select: { humanCorrection: true } }); const previous = existing?.humanCorrection && typeof existing.humanCorrection === 'object' && !Array.isArray(existing.humanCorrection) ? existing.humanCorrection as Record<string, unknown> : {}; await prisma.feedbackClassification.update({ where: { feedbackId: item.id }, data: { humanCorrection: { ...previous, ...corrections, ...(reviewed ? { reviewed: true } : {}) } } }); if (reviewed && workspaceId) await prisma.auditLog.create({ data: { workspaceId, action: 'feedback.reviewed', entityType: 'feedback', entityId: item.id } }); } res.json(item); } catch (error) { next(error); } });

app.get('/api/issues', (req, res) => { const q = String(req.query.q || '').toLowerCase(); res.json({ items: issues.filter(i => !q || `${i.title} ${i.description} ${i.category}`.toLowerCase().includes(q)), total: issues.length }); });
app.post('/api/issues', async (req, res, next) => { try { const parsed = z.object({ title: z.string().min(3).max(160), description: z.string().min(5).max(2000), category: z.string().min(1).max(80), severity: z.enum(['Critical', 'High', 'Medium', 'Low']) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid issue', details: parsed.error.flatten() }); const today = new Date().toISOString().slice(0, 10); const item: Issue = { ...parsed.data, id: randomUUID(), count: 0, firstSeen: today, lastSeen: today, trend: 'Insufficient Data', status: 'New', sentiment: 0, recommendation: 'Collect more evidence before making a recommendation.' }; if (databaseReady && workspaceId) await prisma.issue.create({ data: { id: item.id, workspaceId, title: item.title, description: item.description, category: item.category, severity: item.severity, priority: item.severity, status: item.status, trend: item.trend, firstSeen: new Date(today), lastSeen: new Date(today), recommendation: item.recommendation } }); issues.unshift(item); void retainMemory(item, 'issue'); res.status(201).json(item); } catch (error) { next(error); } });
app.get('/api/issues/:id', (req, res) => { const item = issues.find(i => i.id === req.params.id); if (!item) return res.status(404).json({ error: 'Issue not found' }); res.json({ ...item, feedback: feedback.filter(x => x.topic === item.category).slice(0, 10) }); });
app.patch('/api/issues/:id', async (req, res, next) => { try { const item = issues.find(i => i.id === req.params.id); if (!item) return res.status(404).json({ error: 'Issue not found' }); const patch = issueUpdateSchema.safeParse(req.body); if (!patch.success) return res.status(400).json({ error: 'Invalid issue update', details: patch.error.flatten() }); Object.assign(item, patch.data); if (databaseReady) await prisma.issue.update({ where: { id: item.id }, data: patch.data }); void retainMemory(item, 'issue'); res.json(item); } catch (error) { next(error); } });
app.post('/api/issues/:id/merge', async (req, res, next) => {
  try {
    const source = issues.find(i => i.id === req.params.id);
    const target = issues.find(i => i.id === req.body.targetId);
    if (!source || !target || source.id === target.id) return res.status(400).json({ error: 'Choose two different existing issues.' });
    if (databaseReady) {
      const [feedbackLinks, updateLinks, insightLinks] = await Promise.all([
        prisma.issueFeedback.findMany({ where: { issueId: source.id }, select: { feedbackId: true } }),
        prisma.productUpdateIssue.findMany({ where: { issueId: source.id }, select: { productUpdateId: true } }),
        prisma.insight.findMany({ where: { issues: { some: { id: source.id } } }, select: { id: true } }),
      ]);
      await prisma.$transaction(async tx => {
        if (feedbackLinks.length) await tx.issueFeedback.createMany({ data: feedbackLinks.map(link => ({ issueId: target.id, feedbackId: link.feedbackId })), skipDuplicates: true });
        if (updateLinks.length) await tx.productUpdateIssue.createMany({ data: updateLinks.map(link => ({ issueId: target.id, productUpdateId: link.productUpdateId })), skipDuplicates: true });
        for (const insight of insightLinks) await tx.issue.update({ where: { id: target.id }, data: { insights: { connect: { id: insight.id } } } });
        await tx.impactAnalysis.updateMany({ where: { issueId: source.id }, data: { issueId: target.id } });
        await tx.memoryReference.deleteMany({ where: { issueId: source.id } });
        await tx.issue.delete({ where: { id: source.id } });
        await tx.issue.update({ where: { id: target.id }, data: { firstSeen: new Date(source.firstSeen < target.firstSeen ? source.firstSeen : target.firstSeen), lastSeen: new Date(source.lastSeen > target.lastSeen ? source.lastSeen : target.lastSeen) } });
      });
    }
    memorySync.splice(0, memorySync.length, ...memorySync.filter(entry => !(entry.sourceType === 'issue' && entry.sourceId === source.id)));
    target.count += source.count;
    target.firstSeen = source.firstSeen < target.firstSeen ? source.firstSeen : target.firstSeen;
    target.lastSeen = source.lastSeen > target.lastSeen ? source.lastSeen : target.lastSeen;
    issues = issues.filter(i => i.id !== source.id);
    void retainMemory(target, 'issue');
    res.json({ merged: source.id, into: target.id });
  } catch (error) { next(error); }
});
app.post('/api/issues/:id/split', async (req, res, next) => { try { const source = issues.find(i => i.id === req.params.id); if (!source) return res.status(404).json({ error: 'Issue not found' }); const parsed = z.object({ title: z.string().min(3).max(160), description: z.string().min(5).max(2000), category: z.string().min(1).max(80), feedbackCount: z.number().int().min(1) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid split request', details: parsed.error.flatten() }); if (parsed.data.feedbackCount >= source.count) return res.status(400).json({ error: 'A split must leave at least one feedback item in the original issue.' }); const item: Issue = { id: randomUUID(), title: parsed.data.title, description: parsed.data.description, category: parsed.data.category, count: parsed.data.feedbackCount, severity: source.severity, firstSeen: source.firstSeen, lastSeen: source.lastSeen, trend: 'Insufficient Data', status: 'New', sentiment: source.sentiment, recommendation: 'Review the newly separated evidence before choosing an action.' }; if (databaseReady && workspaceId) { const links = await prisma.issueFeedback.findMany({ where: { issueId: source.id }, orderBy: { createdAt: 'asc' }, take: parsed.data.feedbackCount }); if (links.length < parsed.data.feedbackCount) return res.status(400).json({ error: 'The source issue does not have enough linked feedback to split.' }); await prisma.$transaction(async tx => { await tx.issue.create({ data: { id: item.id, workspaceId: workspaceId!, title: item.title, description: item.description, category: item.category, severity: item.severity, priority: item.severity, status: item.status, trend: item.trend, firstSeen: new Date(item.firstSeen), lastSeen: new Date(item.lastSeen), recommendation: item.recommendation } }); await tx.issueFeedback.createMany({ data: links.map(link => ({ issueId: item.id, feedbackId: link.feedbackId })) }); await tx.issueFeedback.deleteMany({ where: { issueId: source.id, feedbackId: { in: links.map(link => link.feedbackId) } } }); }); } source.count -= parsed.data.feedbackCount; issues.unshift(item); void retainMemory(item, 'issue'); void retainMemory(source, 'issue'); res.status(201).json(item); } catch (error) { next(error); } });
app.post('/api/issues/:id/reanalyze', async (req, res) => { const issue = issues.find(i => i.id === req.params.id); if (!issue) return res.status(404).json({ error: 'Issue not found' }); const recall = await historicalRecall(`${issue.category}: recurring product feedback and historical issue context`); const related = feedback.filter(x => x.topic === issue.category || (issue.id === 'issue-checkout' && x.topic === 'Payments')); issue.count = Math.max(issue.count, related.length); issue.lastSeen = related.sort((a, b) => b.date.localeCompare(a.date))[0]?.date || issue.lastSeen; void retainMemory(issue, 'issue'); res.json({ issue, historicalContext: recall.results, historicalError: recall.error || null }); });

app.get('/api/insights', (_req, res) => res.json({ items: insights }));
app.post('/api/insights/generate', async (_req, res, next) => { try { const evidence = issues.slice(0, 4).map(x => `${x.title}: ${x.count} mentions, trend ${x.trend}, ${x.status}.`); const response = await groqJson<{ title?: string; description?: string; recommendation?: string }>('Write one concise evidence-based customer insight. Return JSON with title, description, recommendation. Mention uncertainty and do not invent metrics.', evidence.join('\n'), { title: 'Checkout signals deserve a journey-level review', description: `${issues[0]?.count || 0} records span navigation, payment, and purchase abandonment. They may point to a related journey problem, but do not establish a shared cause.`, recommendation: 'Map the checkout journey and validate each handoff with event data.' }); const item: Insight = { id: randomUUID(), title: response.title || 'New customer pattern detected', description: response.description || 'The available feedback suggests a pattern for further investigation.', priority: 'High', confidence: 74, evidence: evidence.slice(0, 3), date: new Date().toISOString().slice(0, 10), category: 'Generated insight' }; if (databaseReady && workspaceId) await prisma.insight.create({ data: { id: item.id, workspaceId, title: item.title, description: item.description, category: item.category, priority: item.priority, confidence: item.confidence, evidence: item.evidence, recommendation: response.recommendation || null } }); insights.unshift(item); res.status(201).json(item); } catch (error) { next(error); } });

app.get('/api/memory/status', async (_req, res) => { if (!hindsightConfig()) return res.json({ status: 'not_configured', bankId: process.env.HINDSIGHT_BANK_ID || null, synced: memorySync.filter(x => x.status === 'synced').length, pending: memorySync.filter(x => ['pending', 'failed', 'not_configured'].includes(x.status)).length }); try { const version = await hindsight().getVersion(); res.json({ status: 'connected', bankId: bankId(), version: version.api_version, synced: memorySync.filter(x => x.status === 'synced').length, pending: memorySync.filter(x => ['pending', 'failed'].includes(x.status)).length }); } catch (error) { res.json({ status: 'error', bankId: bankId(), message: error instanceof Error ? error.message : 'Connection failed' }); } });
app.get('/api/memory/recent', (_req, res) => res.json({ items: [...memorySync].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30), retrievals: retrievals.slice(0, 15) }));
app.post('/api/memory/recall', async (req, res) => { const parsed = z.object({ query: z.string().min(3).max(800) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Enter a search question.' }); const result = await historicalRecall(parsed.data.query); if (result.configured) return res.json(result); const terms = parsed.data.query.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 3 && !['what', 'when', 'have', 'were', 'with', 'from', 'about', 'after', 'before', 'most', 'common', 'customers', 'customer'].includes(term)); const structured = [...feedback.map(item => ({ id: item.id, type: `Structured feedback · ${item.topic}`, text: `${item.date} · ${item.topic} · ${item.sentiment}: ${item.summary}`, searchable: `${item.topic} ${item.sentiment} ${item.summary} ${item.message}` })), ...issues.map(item => ({ id: item.id, type: `Structured issue · ${item.status}`, text: `${item.title} · ${item.count} linked feedback records · ${item.trend} trend. ${item.description}`, searchable: `${item.title} ${item.category} ${item.status} ${item.description}` })), ...updates.map(item => ({ id: item.id, type: `Structured product update · ${item.status}`, text: `${item.date} · ${item.title}. ${item.description}`, searchable: `${item.title} ${item.area} ${item.status} ${item.description}` }))].map(item => ({ ...item, score: terms.filter(term => item.searchable.toLowerCase().includes(term)).length })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 10).map(({ id, type, text }) => ({ id, type, text })); res.json({ ...result, results: structured }); });
app.post('/api/memory/reflect', async (req, res) => { const parsed = z.object({ query: z.string().min(3).max(1000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Enter a reflection question.' }); if (!hindsightConfig()) return res.json({ configured: false, text: 'Hindsight is not configured yet. Once connected, this view will reflect across retained feedback and product updates.', evidence: [], uncertainty: 'No historical memory service is connected.' }); try { const result = await hindsight().reflect(bankId(), parsed.data.query, { budget: 'mid', context: 'Product feedback intelligence; cite uncertainty and use only retained customer/product context.' }); retrievals.unshift({ query: parsed.data.query, count: 0, at: new Date().toISOString(), kind: 'reflect' }); res.json({ configured: true, text: result.text, evidence: [], uncertainty: 'Reflection synthesizes retained memories and may not establish causality.' }); } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Hindsight reflection failed' }); } });
app.post('/api/memory/sync', async (_req, res) => { const unsynced = [...memorySync].filter(x => x.status !== 'synced').slice(0, 30); let attempted = 0; for (const entry of unsynced) { const item = feedback.find(x => x.id === entry.sourceId) || issues.find(x => x.id === entry.sourceId) || updates.find(x => x.id === entry.sourceId); if (item) { attempted++; await retainMemory(item, entry.sourceType); } } res.json({ attempted, items: memorySync }); });

app.get('/api/product-updates', (_req, res) => res.json({ items: [...updates].sort((a, b) => b.date.localeCompare(a.date)) }));
app.post('/api/product-updates', async (req, res, next) => { try { const parsed = z.object({ title: z.string().min(3).max(160), description: z.string().min(5).max(3000), area: z.string().min(1).max(80), date: z.string().date(), status: z.enum(['Planned', 'In Progress', 'Released', 'Monitoring']).default('Planned'), outcome: z.string().min(3).max(500), issueIds: z.array(z.string()).default([]) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid product update', details: parsed.error.flatten() }); if (parsed.data.issueIds.some(id => !issues.some(issue => issue.id === id))) return res.status(400).json({ error: 'One or more linked issues do not exist.' }); const item: ProductUpdate = { ...parsed.data, id: randomUUID(), demo: false }; if (databaseReady && workspaceId) { await prisma.productUpdate.create({ data: { id: item.id, workspaceId, title: item.title, description: item.description, productArea: item.area, releaseDate: new Date(item.date), expectedOutcome: item.outcome, status: item.status, issues: { create: item.issueIds.map(issueId => ({ issue: { connect: { id: issueId } } })) } } }); } updates.unshift(item); if (item.status === 'Released') void retainMemory(item, 'product_update'); res.status(201).json(item); } catch (error) { next(error); } });
app.get('/api/product-updates/:id', (req, res) => { const item = updates.find(x => x.id === req.params.id); if (!item) return res.status(404).json({ error: 'Product update not found' }); res.json(item); });
app.patch('/api/product-updates/:id', async (req, res, next) => { try { const item = updates.find(x => x.id === req.params.id); if (!item) return res.status(404).json({ error: 'Product update not found' }); const parsed = z.object({ title: z.string().min(3).max(160).optional(), description: z.string().min(5).max(3000).optional(), date: z.string().date().optional(), status: z.enum(['Planned', 'In Progress', 'Released', 'Monitoring']).optional(), outcome: z.string().min(3).max(500).optional(), area: z.string().min(1).max(80).optional(), issueIds: z.array(z.string()).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid product update', details: parsed.error.flatten() }); if (parsed.data.issueIds?.some(id => !issues.some(issue => issue.id === id))) return res.status(400).json({ error: 'One or more linked issues do not exist.' }); Object.assign(item, parsed.data); if (databaseReady) { const { issueIds, ...fields } = parsed.data; await prisma.$transaction(async tx => { await tx.productUpdate.update({ where: { id: item.id }, data: { ...(fields.title ? { title: fields.title } : {}), ...(fields.description ? { description: fields.description } : {}), ...(fields.area ? { productArea: fields.area } : {}), ...(fields.date ? { releaseDate: new Date(fields.date) } : {}), ...(fields.outcome ? { expectedOutcome: fields.outcome } : {}), ...(fields.status ? { status: fields.status } : {}) } }); if (issueIds) { await tx.productUpdateIssue.deleteMany({ where: { productUpdateId: item.id } }); if (issueIds.length) await tx.productUpdateIssue.createMany({ data: issueIds.map(issueId => ({ productUpdateId: item.id, issueId })) }); } }); } if (item.status === 'Released') void retainMemory(item, 'product_update'); res.json(item); } catch (error) { next(error); } });

function impactFor(update: ProductUpdate, beforeDays = 30, afterDays = 30) {
  const release = new Date(`${update.date}T00:00:00`); const startBefore = new Date(release); startBefore.setDate(release.getDate() - beforeDays); const endAfter = new Date(release); endAfter.setDate(release.getDate() + afterDays);
  const areaFeedback = feedback.filter(x => x.topic.toLowerCase() === update.area.toLowerCase());
  const before = areaFeedback.filter(x => dateWithin(x.date, startBefore, new Date(release.getTime() - 1)));
  const after = areaFeedback.filter(x => dateWithin(x.date, release, endAfter));
  const beforeNeg = before.filter(x => x.sentiment === 'Negative' || x.sentiment === 'Mixed').length; const afterNeg = after.filter(x => x.sentiment === 'Negative' || x.sentiment === 'Mixed').length;
  return { id: `impact-${update.id}`, productUpdate: update, releaseDate: update.date, beforeDays, afterDays, beforeFeedback: before.length, afterFeedback: after.length, beforeNegative: beforeNeg, afterNegative: afterNeg, beforeNegativeRate: before.length ? Math.round(beforeNeg / before.length * 100) : null, afterNegativeRate: after.length ? Math.round(afterNeg / after.length * 100) : null, direction: before.length < 3 || after.length < 3 ? 'Insufficient data' : afterNeg < beforeNeg ? 'Decreasing' : afterNeg > beforeNeg ? 'Increasing' : 'Stable', sufficientData: before.length >= 3 && after.length >= 3, disclaimer: 'A before/after comparison shows timing and correlation only; it does not establish that the update caused the change.', evidence: [...before, ...after].slice(0, 8) };
}
app.get('/api/impact', (req, res) => { const before = Number(req.query.beforeDays || 30); const after = Number(req.query.afterDays || 30); res.json({ items: updates.filter(x => ['Released', 'Monitoring'].includes(x.status)).map(x => impactFor(x, before, after)) }); });
app.post('/api/impact/analyze', async (req, res, next) => { try { const parsed = z.object({ updateId: z.string(), beforeDays: z.number().int().min(7).max(180).default(30), afterDays: z.number().int().min(7).max(180).default(30) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid impact analysis request', details: parsed.error.flatten() }); const update = updates.find(x => x.id === parsed.data.updateId); if (!update) return res.status(404).json({ error: 'Product update not found' }); const analysis = impactFor(update, parsed.data.beforeDays, parsed.data.afterDays); const memory = await historicalRecall(`${update.area} customer feedback before and after product update: ${update.title}`); const explanation = await groqJson<{ explanation?: string }>('Explain this deterministic before/after comparison in two sentences. Use only the supplied counts, call out insufficient data if present, and explicitly say timing does not prove causation. Return JSON with explanation.', JSON.stringify({ title: update.title, beforeFeedback: analysis.beforeFeedback, afterFeedback: analysis.afterFeedback, beforeNegative: analysis.beforeNegative, afterNegative: analysis.afterNegative, sufficientData: analysis.sufficientData, disclaimer: analysis.disclaimer }), { explanation: analysis.sufficientData ? `Negative feedback in this sample moved from ${analysis.beforeNegative} to ${analysis.afterNegative} mentions around the release. This time comparison does not establish that the update caused the change.` : 'There are fewer than three records in one or both comparison windows, so the signal is too sparse to interpret. A before/after comparison would not establish causation.' }); if (databaseReady) await prisma.impactAnalysis.create({ data: { productUpdateId: update.id, issueId: update.issueIds[0] || null, beforeDays: analysis.beforeDays, afterDays: analysis.afterDays, beforeFeedbackCount: analysis.beforeFeedback, afterFeedbackCount: analysis.afterFeedback, beforeNegativeCount: analysis.beforeNegative, afterNegativeCount: analysis.afterNegative, explanation: explanation.explanation || null, insufficientData: !analysis.sufficientData } }); res.json({ ...analysis, explanation: explanation.explanation, historicalContext: memory.results, historicalError: memory.error || null }); } catch (error) { next(error); } });

app.post('/api/assistant/chat', async (req, res) => {
  const parsed = z.object({ message: z.string().trim().min(3).max(1200) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Ask a question with at least 3 characters.' });
  const q = parsed.data.message.toLowerCase();
  const relevantIssues = issues.filter(x => q.includes(x.category.toLowerCase()) || q.includes(x.title.toLowerCase().split(' ')[0]) || /biggest|priority|worsen|problem|issue|complaint/.test(q)).slice(0, 4);
  const relevantFeedback = feedback.filter(x => relevantIssues.some(i => i.category === x.topic) || q.includes(x.topic.toLowerCase())).slice(0, 8);
  const memory = await historicalRecall(parsed.data.message);
  const evidence = [...relevantIssues.map(i => `[${i.id}] ${i.title}: ${i.count} mentions, ${i.trend} trend, ${i.status}.`), ...relevantFeedback.map(f => `[${f.id}] ${f.date} ${f.topic}/${f.sentiment}: ${f.summary}`), ...memory.results.map(r => `Hindsight: ${r.text}`)];
  const generated = await groqJson<{ answer?: string; uncertainty?: string }>('You are ProductPulse, a careful customer intelligence assistant. Use only supplied evidence. Reference feedback/issue IDs in square brackets. Calculate no new metrics. Distinguish correlation from causation. Return JSON with answer and uncertainty. If evidence is thin, say so.', `Question: ${parsed.data.message}\nEvidence:\n${evidence.join('\n') || 'No matching evidence found.'}`, { answer: evidence.length ? `${relevantIssues.map(i => `${i.title} has ${i.count} related records and is ${i.trend.toLowerCase()}.`).join(' ')} The evidence here is drawn from the current workspace records${memory.results.length ? ' and historical memory' : ''}.` : 'I could not find matching workspace evidence for that question yet. Try asking about checkout, payments, performance, onboarding, or authentication.', uncertainty: memory.error || (!memory.results.length ? 'No historical Hindsight memories were available for this response.' : 'Patterns indicate association and do not prove a shared cause.') });
  res.json({ answer: generated.answer || 'I could not generate a response from the available evidence.', uncertainty: generated.uncertainty || 'Use this response as a starting point for investigation.', evidence: evidence.map((text, i) => ({ id: String(i + 1), text })), memoryStatus: memory.error ? 'unavailable' : memory.configured ? 'used' : 'not_configured' });
});

const clientBuild = resolve(process.cwd(), 'dist');
if (process.env.SERVE_CLIENT !== 'false' && existsSync(resolve(clientBuild, 'index.html'))) {
  app.use(express.static(clientBuild));
  app.use((req, res, next) => req.method === 'GET' && !req.path.startsWith('/api') ? res.sendFile(resolve(clientBuild, 'index.html')) : next());
}
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { console.error('API request failed:', error instanceof Error ? error.message : 'unknown error'); res.status(error instanceof multer.MulterError ? 400 : 500).json({ error: error instanceof multer.MulterError ? error.message : 'The request could not be completed.' }); });

async function connectDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    await prisma.$connect();
    const activeWorkspace = workspaceId ? await prisma.workspace.findUnique({ where: { id: workspaceId } }) : await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
    if (activeWorkspace) { workspaceId = activeWorkspace.id; workspaceSlug = activeWorkspace.slug; if (!process.env.PRODUCTPULSE_WORKSPACE_NAME) workspaceName = activeWorkspace.name; }
    const rows = await prisma.feedback.findMany({ where: workspaceId ? { workspaceId } : undefined, include: { classification: true }, orderBy: { receivedAt: 'desc' } });
    if (rows.length) feedback = rows.map(row => { const correction = row.classification?.humanCorrection && typeof row.classification.humanCorrection === 'object' && !Array.isArray(row.classification.humanCorrection) ? row.classification.humanCorrection as Record<string, unknown> : {}; return { id: row.id, customer: row.customerName, initials: row.customerName.split(' ').map(x => x[0]).join(''), message: row.message, source: row.source, topic: String(correction.topic || row.classification?.topic || 'Other'), sentiment: String(correction.sentiment || row.classification?.sentiment || 'Neutral') as Feedback['sentiment'], priority: String(correction.priority || row.classification?.urgency || 'Low') as Feedback['priority'], date: row.receivedAt.toISOString().slice(0, 10), status: row.processingState !== 'processed' ? 'Review' : correction.reviewed ? 'Reviewed' : 'Processed', summary: row.classification?.summary || row.message, intent: row.classification?.intent || 'Share feedback', confidence: row.classification?.confidence || 0, keywords: Array.isArray(row.classification?.keywords) ? row.classification.keywords as string[] : [], demo: row.isDemo }; });
    if (workspaceId) {
      const [issueRows, updateRows, insightRows, memoryRows] = await Promise.all([
        prisma.issue.findMany({ where: { workspaceId }, include: { feedback: { include: { feedback: { include: { classification: true } } } }, updates: { include: { productUpdate: true } } }, orderBy: { updatedAt: 'desc' } }),
        prisma.productUpdate.findMany({ where: { workspaceId }, include: { issues: true }, orderBy: { releaseDate: 'desc' } }),
        prisma.insight.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } }),
        prisma.memoryReference.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } }),
      ]);
      if (issueRows.length) issues = issueRows.map(row => { const related = row.feedback.map(link => link.feedback); const negative = related.filter(x => ['Negative', 'Mixed'].includes(x.classification?.sentiment || '')).length; return { id: row.id, title: row.title, description: row.description, category: row.category, severity: row.severity as Issue['severity'], count: related.length, firstSeen: row.firstSeen.toISOString().slice(0, 10), lastSeen: row.lastSeen.toISOString().slice(0, 10), trend: row.trend as Issue['trend'], status: row.status, sentiment: related.length ? Math.round(negative / related.length * 100) : 0, recommendation: row.recommendation || '', demo: row.isDemo }; });
      if (updateRows.length) updates = updateRows.map(row => ({ id: row.id, title: row.title, description: row.description, area: row.productArea, date: row.releaseDate.toISOString().slice(0, 10), status: row.status, outcome: row.expectedOutcome, issueIds: row.issues.map(link => link.issueId), demo: row.isDemo }));
      if (insightRows.length) insights = insightRows.map(row => ({ id: row.id, title: row.title, description: row.description, category: row.category, priority: row.priority as Insight['priority'], confidence: row.confidence, evidence: Array.isArray(row.evidence) ? row.evidence as string[] : [], date: row.createdAt.toISOString().slice(0, 10) }));
      if (memoryRows.length) {
        memorySync.splice(0, memorySync.length);
        for (const ref of memoryRows) {
          const item = ref.sourceType === 'feedback' ? feedback.find(x => x.id === ref.sourceId) : ref.sourceType === 'issue' ? issues.find(x => x.id === ref.sourceId) : updates.find(x => x.id === ref.sourceId);
          const content = item ? memoryContent(item) : `ProductPulse ${ref.sourceType} reference ${ref.sourceId}.`;
          memorySync.push({ id: ref.id, sourceId: ref.sourceId, sourceType: ref.sourceType, status: ref.syncStatus, content, createdAt: ref.createdAt.toISOString(), ...(ref.lastError ? { error: ref.lastError } : {}) });
        }
      }
    }
    databaseReady = true;
    console.info('ProductPulse connected to PostgreSQL.');
  } catch (error) { console.warn('PostgreSQL is unavailable; starting in demo mode:', error instanceof Error ? error.message : 'connection failed'); }
}

export async function start() { await connectDatabase(); return app.listen(port, '0.0.0.0', () => console.info(`ProductPulse API listening on port ${port} (${databaseReady ? 'PostgreSQL' : 'demo'} mode)`)); }
if (process.env.NODE_ENV !== 'test') void start();
export { app };
