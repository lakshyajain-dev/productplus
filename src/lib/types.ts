export type Sentiment = 'Negative' | 'Neutral' | 'Positive' | 'Mixed';
export type Priority = 'Critical' | 'High' | 'Medium' | 'Low';
export type Feedback = {
  id: string; customer: string; initials: string; message: string; source: string; topic: string;
  sentiment: Sentiment; priority: Priority; date: string; status: 'Processed' | 'Review' | 'Processing' | 'Reviewed';
  summary: string; intent: string; confidence: number; keywords: string[]; demo?: boolean;
};
export type Issue = {
  id: string; title: string; description: string; category: string; severity: Priority; count: number;
  firstSeen: string; lastSeen: string; trend: 'Increasing' | 'Stable' | 'Decreasing' | 'Insufficient Data'; status: string;
  sentiment: number; recommendation: string; demo?: boolean;
};
export type ProductUpdate = {
  id: string; title: string; description: string; area: string; date: string; status: string;
  outcome: string; issueIds: string[]; demo?: boolean;
};
export type Insight = { id: string; title: string; description: string; priority: Priority; confidence: number; evidence: string[]; date: string; category: string; };
