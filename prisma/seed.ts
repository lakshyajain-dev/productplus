import 'dotenv/config';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { demoFeedback, demoIssues, demoInsights, demoUpdates } from '../src/lib/demo.js';

const prisma = new PrismaClient();
const uuidFromKey = (value: string) => { const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };

async function main() {
  const workspace = await prisma.workspace.upsert({ where: { slug: 'productpulse-demo' }, update: { name: 'Northstar Studio' }, create: { name: 'Northstar Studio', slug: 'productpulse-demo' } });
  const existing = await prisma.feedback.count({ where: { workspaceId: workspace.id } });
  if (!existing) {
    for (const item of demoFeedback) {
      await prisma.feedback.create({ data: {
        workspaceId: workspace.id, customerName: item.customer, message: item.message, source: item.source,
        receivedAt: new Date(item.date), processingState: 'processed', isDemo: true,
        classification: { create: { sentiment: item.sentiment, topic: item.topic, urgency: item.priority, intent: item.intent, summary: item.summary, keywords: item.keywords, confidence: item.confidence } },
      } });
    }
  }
  const issueIds = new Map<string, string>();
  for (const item of demoIssues) {
    const id = uuidFromKey(item.id);
    const issue = await prisma.issue.upsert({ where: { id }, update: {}, create: { id, workspaceId: workspace.id, title: item.title, description: item.description, category: item.category, severity: item.severity, priority: item.severity, status: item.status, trend: item.trend, firstSeen: new Date(item.firstSeen), lastSeen: new Date(item.lastSeen), recommendation: item.recommendation, isDemo: true } });
    issueIds.set(item.id, issue.id);
    const relatedWhere = item.id === 'issue-checkout' ? { topic: { in: ['Checkout', 'Payments'] } } : item.id === 'issue-analytics' ? { topic: 'Features', intent: 'Request a feature' } : { topic: item.category };
    const related = await prisma.feedback.findMany({ where: { workspaceId: workspace.id, classification: relatedWhere }, select: { id: true } });
    if (related.length) await prisma.issueFeedback.createMany({ data: related.map(row => ({ issueId: issue.id, feedbackId: row.id })), skipDuplicates: true });
  }
  const updateIds = new Map<string, string>();
  for (const item of demoUpdates) {
    const id = uuidFromKey(item.id);
    const update = await prisma.productUpdate.upsert({ where: { id }, update: {}, create: { id, workspaceId: workspace.id, title: item.title, description: item.description, productArea: item.area, releaseDate: new Date(item.date), expectedOutcome: item.outcome, status: item.status, isDemo: true } });
    updateIds.set(item.id, update.id);
    for (const issueId of item.issueIds) {
      const mapped = issueIds.get(issueId);
      if (mapped) await prisma.productUpdateIssue.upsert({ where: { productUpdateId_issueId: { productUpdateId: update.id, issueId: mapped } }, update: {}, create: { productUpdateId: update.id, issueId: mapped } });
    }
  }
  for (const item of demoInsights) {
    const exists = await prisma.insight.findFirst({ where: { workspaceId: workspace.id, title: item.title } });
    if (!exists) await prisma.insight.create({ data: { workspaceId: workspace.id, title: item.title, description: item.description, category: item.category, priority: item.priority, confidence: item.confidence, evidence: item.evidence, recommendation: 'Review the cited evidence and validate with customers.' } });
  }
  const released = demoUpdates.filter(x => ['Released', 'Monitoring'].includes(x.status));
  for (const update of released.slice(0, 3)) {
    const updateId = updateIds.get(update.id)!;
    const issueId = issueIds.get(update.issueIds[0]);
    const exists = await prisma.impactAnalysis.findFirst({ where: { productUpdateId: updateId } });
    if (!exists) await prisma.impactAnalysis.create({ data: { productUpdateId: updateId, issueId, beforeFeedbackCount: 7, afterFeedbackCount: 5, beforeNegativeCount: 5, afterNegativeCount: 3, explanation: 'Demo comparison built from seeded records. Before/after timing is correlational and does not establish causation.', insufficientData: true } });
  }
  const dbFeedback = await prisma.feedback.findMany({ where: { workspaceId: workspace.id, isDemo: true }, include: { classification: true } });
  const feedbackIds = new Map<string, string>();
  for (const item of demoFeedback) { const row = dbFeedback.find(x => x.customerName === item.customer && x.message === item.message && x.receivedAt.toISOString().slice(0, 10) === item.date); if (row) feedbackIds.set(item.id, row.id); }
  const memoryItems: Array<{ sourceType: string; sourceId: string; content: string; relation: { feedbackId?: string; issueId?: string; productUpdateId?: string } }> = [];
  for (const item of demoFeedback) { const id = feedbackIds.get(item.id); const relatedIssue = demoIssues.find(issue => issue.category === item.topic || (item.topic === 'Payments' && issue.id === 'issue-checkout')); const relatedId = relatedIssue ? issueIds.get(relatedIssue.id) : undefined; if (id) memoryItems.push({ sourceType: 'feedback', sourceId: id, relation: { feedbackId: id }, content: `Customer feedback (${item.date}) in ${item.topic}. Sentiment: ${item.sentiment}. Priority: ${item.priority}. Summary: ${item.summary}.${relatedId ? ` Related issue ${relatedId}.` : ''} Reference: ${id}.` }); }
  for (const item of demoIssues) { const id = issueIds.get(item.id)!; memoryItems.push({ sourceType: 'issue', sourceId: id, relation: { issueId: id }, content: `Product issue ${item.title} in ${item.category}. First reported ${item.firstSeen}, latest report ${item.lastSeen}. Current status: ${item.status}. Evidence count: ${item.count}. Reference: ${id}.` }); }
  for (const item of demoUpdates.filter(x => ['Released', 'Monitoring'].includes(x.status))) { const id = updateIds.get(item.id)!; const related = item.issueIds.map(issueId => issueIds.get(issueId)).filter((issueId): issueId is string => Boolean(issueId)); memoryItems.push({ sourceType: 'product_update', sourceId: id, relation: { productUpdateId: id }, content: `Product update ${item.title} (${item.status}) in ${item.area}, date ${item.date}. Description: ${item.description}. Expected outcome: ${item.outcome}. Related issues: ${related.join(', ') || 'none'}. Reference: ${id}.` }); }
  for (const item of memoryItems) {
    const hash = createHash('sha256').update(`${item.sourceType}:${item.sourceId}:${item.content}`).digest('hex');
    await prisma.memoryReference.upsert({ where: { contentHash: hash }, update: {}, create: { workspaceId: workspace.id, bankId: process.env.HINDSIGHT_BANK_ID || 'ProductPulse', sourceType: item.sourceType, sourceId: item.sourceId, contentHash: hash, syncStatus: 'pending', ...item.relation } });
  }
  await prisma.user.upsert({ where: { workspaceId_email: { workspaceId: workspace.id, email: 'team@northstar.example' } }, update: {}, create: { workspaceId: workspace.id, email: 'team@northstar.example', name: 'Product Team', role: 'admin' } });
  console.info(`Seeded ProductPulse demo workspace with ${demoFeedback.length} feedback records, ${demoIssues.length} issues, ${demoInsights.length} insights, ${demoUpdates.length} updates, and 3 impact comparisons.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
