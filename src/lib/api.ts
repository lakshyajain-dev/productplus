import { demoFeedback, demoInsights, demoIssues, demoUpdates, trendData } from './demo';
import type { Feedback, Insight, Issue, ProductUpdate } from './types';

const readLocal = <T,>(key: string, fallback: T): T => {
  try { const value = localStorage.getItem(`productpulse:${key}`); return value ? JSON.parse(value) as T : structuredClone(fallback); } catch { return structuredClone(fallback); }
};
const writeLocal = <T,>(key: string, value: T) => { try { localStorage.setItem(`productpulse:${key}`, JSON.stringify(value)); } catch { /* storage is optional for demo mode */ } };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `Request failed (${response.status})`); }
  if (response.headers.get('content-type')?.includes('text/csv')) return response as T;
  return response.json() as Promise<T>;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function getHealth() { return request<{ status: string; mode: string }>('/health').catch(() => ({ status: 'ok', mode: 'demo' })); }
export async function getOverview() {
  const negative = demoFeedback.filter(x => ['Negative', 'Mixed'].includes(x.sentiment)).length;
  const fallback = { totalFeedback: demoFeedback.length, negativeFeedback: negative, negativePercent: Math.round(negative / demoFeedback.length * 100), openIssues: demoIssues.filter(x => !['Resolved', 'Monitoring'].includes(x.status)).length, criticalIssues: demoIssues.filter(x => x.severity === 'Critical' && !['Resolved', 'Monitoring'].includes(x.status)).length, emergingTrends: demoIssues.filter(x => x.trend === 'Increasing').length, insightsGenerated: demoInsights.length, comparisonLabel: 'latest vs prior sample month', changes: { feedback: 0, negative: 0, openIssues: 0, criticalIssues: 0, trends: 0, insights: 0 }, latestFeedbackDate: demoFeedback[0]?.date || null, trendData, sentiment: ['Positive', 'Neutral', 'Negative', 'Mixed'].map(name => ({ name, value: demoFeedback.filter(x => x.sentiment === name).length })), sources: [...new Set(demoFeedback.map(x => x.source))].map(name => ({ name, value: demoFeedback.filter(x => x.source === name).length })).sort((a, b) => b.value - a.value).slice(0, 5), topIssues: demoIssues.slice(0, 4), recentInsights: demoInsights.slice(0, 3) };
  return request<typeof fallback>('/dashboard/overview').catch(() => fallback);
}
export async function getFeedback(params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return request<{ items: Feedback[]; total: number; page: number; pageSize: number }>(`/feedback?${qs}`).catch(() => {
    let items = readLocal('feedback', demoFeedback);
    const q = String(params.q || '').toLowerCase();
    items = items.filter(f => (!q || `${f.message} ${f.customer} ${f.topic}`.toLowerCase().includes(q)) && (!params.sentiment || params.sentiment === 'All sentiments' || f.sentiment === params.sentiment) && (!params.source || params.source === 'All sources' || f.source === params.source) && (!params.topic || params.topic === 'All topics' || f.topic === params.topic) && (!params.priority || params.priority === 'All priorities' || f.priority === params.priority) && (!params.month || f.date.startsWith(String(params.month))));
    items.sort(params.sort === 'oldest' ? (a, b) => a.date.localeCompare(b.date) : params.sort === 'priority' ? (a, b) => ['Critical','High','Medium','Low'].indexOf(a.priority) - ['Critical','High','Medium','Low'].indexOf(b.priority) : (a, b) => b.date.localeCompare(a.date));
    const page = Number(params.page || 1); const pageSize = Number(params.pageSize || 20);
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  });
}
export async function getFeedbackFacets() { return request<{ sources: string[]; topics: string[]; months: string[] }>('/feedback/facets').catch(() => ({ sources: [...new Set(demoFeedback.map(x => x.source))].sort(), topics: [...new Set(demoFeedback.map(x => x.topic))].sort(), months: [...new Set(demoFeedback.map(x => x.date.slice(0, 7)))].sort().reverse() })); }
export async function createFeedback(data: { message: string; customer: string; source: string }) {
  try { return await request<Feedback>('/feedback', json('POST', data)); }
  catch {
    const item: Feedback = { id: crypto.randomUUID(), customer: data.customer || 'Anonymous customer', initials: (data.customer || 'AC').split(' ').map(x => x[0]).join('').toUpperCase(), message: data.message, source: data.source, topic: /pay|charge/i.test(data.message) ? 'Payments' : /checkout|cart/i.test(data.message) ? 'Checkout' : 'Other', sentiment: /love|great|thank/i.test(data.message) ? 'Positive' : /fail|confus|slow|problem/i.test(data.message) ? 'Negative' : 'Neutral', priority: 'Medium', date: new Date().toISOString().slice(0, 10), status: 'Processed', summary: data.message, intent: 'Share feedback', confidence: 68, keywords: [], demo: false };
    writeLocal('feedback', [item, ...readLocal('feedback', demoFeedback)]); return item;
  }
}
export async function getFeedbackDetail(id: string) {
  return request<Feedback & { related: Feedback[]; relatedIssue?: Issue; historicalMemories: Array<{ id: string; text: string; type: string }>; memoryStatus: string; memoryError?: string }>(`/feedback/${encodeURIComponent(id)}`).catch(() => {
    const all = readLocal('feedback', demoFeedback); const item = all.find(x => x.id === id) || demoFeedback.find(x => x.id === id)!;
    return { ...item, related: all.filter(x => x.id !== item.id && x.topic === item.topic).slice(0, 5), relatedIssue: demoIssues.find(x => x.category === item.topic || (item.topic === 'Payments' && x.id === 'issue-checkout')), historicalMemories: [], memoryStatus: 'not_configured', memoryError: 'Hindsight retrieval is unavailable. No historical matches were returned.' };
  });
}
export async function markFeedbackReviewed(id: string) {
  try { return await request<Feedback>(`/feedback/${encodeURIComponent(id)}`, json('PATCH', { reviewed: true })); }
  catch { const items = readLocal('feedback', demoFeedback); const item = items.find(x => x.id === id); if (item) item.status = 'Reviewed'; writeLocal('feedback', items); return item; }
}
export async function correctFeedbackClassification(id: string, patch: { sentiment?: Feedback['sentiment']; topic?: string; priority?: Feedback['priority'] }) {
  try { return await request<Feedback>(`/feedback/${encodeURIComponent(id)}`, json('PATCH', patch)); }
  catch { const items = readLocal('feedback', demoFeedback); const item = items.find(x => x.id === id); if (item) Object.assign(item, patch); writeLocal('feedback', items); return item; }
}
export async function getIssues() { return request<{ items: Issue[]; total: number }>('/issues').catch(() => ({ items: readLocal('issues', demoIssues), total: demoIssues.length })); }
export async function updateIssue(id: string, patch: Partial<Issue>) {
  try { return await request<Issue>(`/issues/${id}`, json('PATCH', patch)); }
  catch { const items = readLocal('issues', demoIssues); const item = items.find(x => x.id === id)!; if (item) Object.assign(item, patch); writeLocal('issues', items); return item; }
}
export async function mergeIssues(sourceId: string, targetId: string) {
  try { return await request<{ merged: string; into: string }>(`/issues/${sourceId}/merge`, json('POST', { targetId })); }
  catch { const items = readLocal('issues', demoIssues); const source = items.find(x => x.id === sourceId); const target = items.find(x => x.id === targetId); if (source && target) { target.count += source.count; writeLocal('issues', items.filter(x => x.id !== sourceId)); } return { merged: sourceId, into: targetId }; }
}
export async function splitIssue(id: string, data: { title: string; description: string; category: string; feedbackCount: number }) {
  try { return await request<Issue>(`/issues/${id}/split`, json('POST', data)); }
  catch { const items = readLocal('issues', demoIssues); const source = items.find(x => x.id === id)!; source.count -= data.feedbackCount; const item: Issue = { ...source, title: data.title, description: data.description, category: data.category, count: data.feedbackCount, id: crypto.randomUUID(), severity: 'Medium', status: 'New', trend: 'Insufficient Data', recommendation: 'Review the newly separated evidence.' }; writeLocal('issues', [item, ...items]); return item; }
}
export async function getInsights() { return request<{ items: Insight[] }>('/insights').catch(() => ({ items: readLocal('insights', demoInsights) })); }
export async function generateInsights() {
  try { return await request<Insight>('/insights/generate', json('POST', {})); }
  catch { const item = { ...demoInsights[0], id: crypto.randomUUID(), date: new Date().toISOString().slice(0, 10) }; writeLocal('insights', [item, ...readLocal('insights', demoInsights)]); return item; }
}
export async function getUpdates() { return request<{ items: ProductUpdate[] }>('/product-updates').catch(() => ({ items: readLocal('updates', demoUpdates) })); }
export async function createUpdate(data: Omit<ProductUpdate, 'id'>) {
  try { return await request<ProductUpdate>('/product-updates', json('POST', data)); }
  catch { const item = { ...data, id: crypto.randomUUID(), demo: false }; writeLocal('updates', [item, ...readLocal('updates', demoUpdates)]); return item; }
}
export async function updateUpdate(id: string, patch: Partial<ProductUpdate>) {
  try { return await request<ProductUpdate>(`/product-updates/${id}`, json('PATCH', patch)); }
  catch { const items = readLocal('updates', demoUpdates); const item = items.find(x => x.id === id)!; if (item) Object.assign(item, patch); writeLocal('updates', items); return item; }
}
export async function getMemoryStatus(): Promise<{ status: string; bankId?: string; version?: string; synced: number; pending: number; message?: string }> { return request<{ status: string; bankId?: string; version?: string; synced: number; pending: number; message?: string }>('/memory/status').catch(() => ({ status: 'not_configured', bankId: 'ProductPulse', synced: 0, pending: 0 })); }
export async function getRecentMemory() { return request<{ items: Array<{ id: string; sourceType: string; status: string; content: string; createdAt: string }>; retrievals: Array<{ query: string; count: number; at: string; kind: string }> }>('/memory/recent').catch(() => ({ items: [], retrievals: [] })); }
export async function syncMemories() { return request<{ attempted: number; items: Array<{ id: string; status: string }> }>('/memory/sync', json('POST', {})); }
export async function recall(query: string) { return request<{ configured: boolean; results: Array<{ id: string; text: string; type: string }>; error?: string }>('/memory/recall', json('POST', { query })); }
export async function reflect(query: string) { return request<{ configured: boolean; text: string; evidence: string[]; uncertainty: string }>('/memory/reflect', json('POST', { query })); }
export async function sendChat(message: string) { return request<{ answer: string; uncertainty: string; evidence: Array<{ id: string; text: string }>; memoryStatus: string }>('/assistant/chat', json('POST', { message })); }
export async function getImpact(beforeDays = 30, afterDays = 30) { return request<{ items: Array<Record<string, unknown>> }>(`/impact?beforeDays=${beforeDays}&afterDays=${afterDays}`).catch(() => ({ items: [] })); }
export async function createImpact(updateId: string, beforeDays: number, afterDays: number) { return request<Record<string, unknown>>('/impact/analyze', json('POST', { updateId, beforeDays, afterDays })); }
export async function getIntegrationStatus() { return request<Record<string, { status: string; model?: string; bankId?: string; message?: string }>>('/health/integrations').catch(() => ({ database: { status: 'not_configured' }, groq: { status: 'not_configured' }, hindsight: { status: 'not_configured' } })); }
export async function getWorkspaceSettings() { return request<{ name: string; slug: string }>('/settings/workspace').catch(() => ({ name: 'Northstar Studio', slug: 'productpulse-demo' })); }
export async function saveWorkspaceSettings(name: string) { try { return await request<{ name: string; slug: string }>('/settings/workspace', json('PATCH', { name })); } catch { return { name, slug: 'productpulse-demo' }; } }
