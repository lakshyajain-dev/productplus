import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowDownRight, ArrowRight, ArrowUpRight, BrainCircuit, CalendarDays, Check, ChevronDown, CircleAlert, Clock3, MessageSquareText, Plus, RefreshCw, Sparkles, TrendingUp, Users, Zap } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { getOverview, generateInsights, getWorkspaceSettings } from '../lib/api';
import { Badge, Button, Panel, formatDate } from '../components/UI';
import type { Insight, Issue } from '../lib/types';

const palette = ['#34d399', '#3b82f6', '#fb7185', '#a78bfa'];
const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; name: string; color: string }>; label?: string }) => active && payload?.length ? <div className="chart-tooltip"><b>{label}</b>{payload.map((item, i) => <span key={i}><i style={{ background: item.color }}/>{item.name}<strong>{item.value}</strong></span>)}</div> : null;
const KPI = ({ label, value, change, kind, icon: Icon, spark, index, goodWhenDown = false, comparison }: { label: string; value: string | number; change: string; kind: string; icon: typeof Users; spark: number[]; index: number; goodWhenDown?: boolean; comparison: string }) => {
  const points = spark.map((v, i) => `${(i / (spark.length - 1)) * 100},${30 - (v / Math.max(...spark)) * 22}`).join(' ');
  const down = change.startsWith('-') || change.startsWith('−'); const favorable = goodWhenDown ? down : !down;
  return <motion.article className={`kpi-card kpi-${kind}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .055, duration: .32 }}><div className="kpi-top"><span>{label}</span><span className="kpi-icon"><Icon size={17}/></span></div><div className="kpi-value-row"><strong>{value}</strong>{spark.length > 1 && <div className="kpi-spark"><svg viewBox="0 0 100 34" preserveAspectRatio="none"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg></div>}</div><div className="kpi-foot"><span className={favorable ? 'trend-positive' : 'trend-negative'}>{down ? <ArrowDownRight size={13}/> : <ArrowUpRight size={13}/>} {change}</span><span>{comparison}</span></div></motion.article>;
};
const issueTone = (severity: string) => severity === 'Critical' ? 'danger' : severity === 'High' ? 'warning' : 'info';
function InsightRow({ item, i }: { item: Insight; i: number }) { return <Link to="/insights" className="insight-row"><span className={`insight-index index-${i + 1}`}>0{i + 1}</span><span className="insight-copy"><b>{item.title}</b><small>{item.category} <i>·</i> {formatDate(item.date)}</small></span><span className="insight-confidence">{item.confidence}%</span><ArrowRight size={14}/></Link>; }
function IssueRow({ item, i }: { item: Issue; i: number }) { return <Link to="/issues" className="issue-row"><span className={`issue-rank rank-${i}`}>{String(i + 1).padStart(2, '0')}</span><span className="issue-title"><b>{item.title}</b><small>{item.category} <i>·</i> updated {formatDate(item.lastSeen)}</small></span><span className="issue-count">{item.count}<small> mentions</small></span><Badge tone={issueTone(item.severity)}>{item.severity}</Badge><span className={`trend-mark ${item.trend.toLowerCase()}`}>{item.trend === 'Increasing' ? <TrendingUp size={14}/> : item.trend === 'Decreasing' ? <ArrowDownRight size={14}/> : <span>—</span>}</span></Link>; }

export function OverviewPage({ onOpenAssistant }: { onOpenAssistant: () => void }) {
  const queryClient = useQueryClient(); const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview }); const workspace = useQuery({ queryKey: ['workspace-settings'], queryFn: getWorkspaceSettings });
  const [range, setRange] = useState('Last 6 months'); const [rangeOpen, setRangeOpen] = useState(false);
  const insightMutation = useMutation({ mutationFn: generateInsights, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['overview'] }); queryClient.invalidateQueries({ queryKey: ['insights'] }); } });
  const data = overview.data;
  const filteredTrend = useMemo(() => { const months = range === 'Last 3 months' ? 3 : range === 'Last 6 months' ? 6 : Number.POSITIVE_INFINITY; const series = data?.trendData || []; return Number.isFinite(months) ? series.slice(-months) : series; }, [range, data]);
  const kpis = [
    { label: 'Total feedback', value: data?.totalFeedback.toLocaleString() || '—', change: `${(data?.changes.feedback || 0) >= 0 ? '+' : ''}${data?.changes.feedback || 0}%`, kind: 'violet', icon: MessageSquareText, spark: data?.trendData.map(point => point.feedback) || [] },
    { label: 'Negative feedback', value: data?.negativeFeedback.toLocaleString() || '—', change: `${(data?.changes.negative || 0) >= 0 ? '+' : ''}${data?.changes.negative || 0}%`, kind: 'rose', icon: CircleAlert, spark: data?.trendData.map(point => point.negative) || [], goodWhenDown: true },
    { label: 'Open issues', value: data?.openIssues ?? '—', change: `${data?.changes.openIssues || 0} new`, kind: 'blue', icon: Zap, spark: [] },
    { label: 'Critical issues', value: data?.criticalIssues ?? '—', change: `${data?.changes.criticalIssues || 0} new`, kind: 'amber', icon: CircleAlert, spark: [] },
    { label: 'Emerging trends', value: data?.emergingTrends ?? '—', change: `${data?.changes.trends || 0} new`, kind: 'cyan', icon: TrendingUp, spark: [] },
    { label: 'AI insights', value: data?.insightsGenerated ?? '—', change: `${data?.changes.insights || 0} this month`, kind: 'green', icon: BrainCircuit, spark: [] },
  ];
  const todayLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();
  return <div className="page-shell overview-page">
    <div className="welcome-banner"><div className="welcome-glow"/><div className="welcome-copy"><div className="welcome-eyebrow"><span className="eyebrow-dot"/> {todayLabel} <span className="welcome-sep">/</span> NORTHSTAR STUDIO</div><h1>Good morning, Product Team <span>✦</span></h1><p>Your customer intelligence at a glance. Here’s what your users are telling you.</p></div><div className="welcome-orb-large"><div className="orbit-ring ring-one"/><div className="orbit-ring ring-two"/><span><BrainCircuit size={29}/></span><i className="orb-dot dot-one"/><i className="orb-dot dot-two"/></div><div className="welcome-actions"><button className="date-select" onClick={() => setRangeOpen(x => !x)}><CalendarDays size={15}/>{range}<ChevronDown size={14}/></button>{rangeOpen && <div className="range-menu">{['Last 3 months', 'Last 6 months', 'All history'].map(x => <button key={x} onClick={() => { setRange(x); setRangeOpen(false); }}>{x}</button>)}</div>}<Button variant="primary" onClick={() => insightMutation.mutate()} disabled={insightMutation.isPending}><Sparkles size={15}/>{insightMutation.isPending ? 'Generating…' : 'Generate insights'}</Button></div></div>
    <div className="kpi-grid">{kpis.map((k, i) => <KPI key={k.label} {...k} index={i} comparison={data?.comparisonLabel || 'vs prior sample month'}/>)}</div>
    <div className="dashboard-grid main-analytics-grid">
      <Panel className="feedback-trend-panel" title="Feedback volume & sentiment" subtitle="Feedback activity over time" action={<div className="chart-legend"><span><i className="legend-dot violet-dot"/> Feedback</span><span><i className="legend-dot cyan-dot"/> Positive</span></div>}>
        <div className="trend-chart-summary"><div><b>{data?.totalFeedback.toLocaleString() || '—'}</b><span>Total conversations</span></div><span className="change-chip positive"><ArrowUpRight size={13}/> {Math.max(0, data?.changes.feedback || 0)}%</span><span className="summary-caption">compared to prior sample month</span></div>
        <div className="chart-wrap trend-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={filteredTrend} margin={{ top: 12, right: 7, left: -18, bottom: 0 }}><defs><linearGradient id="feedbackFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8b5cf6" stopOpacity={.28}/><stop offset="98%" stopColor="#8b5cf6" stopOpacity={0}/></linearGradient><linearGradient id="positiveFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={.15}/><stop offset="100%" stopColor="#22d3ee" stopOpacity={0}/></linearGradient></defs><CartesianGrid stroke="#253047" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="month" tick={{ fill: '#747e94', fontSize: 11 }} axisLine={false} tickLine={false} dy={9}/><YAxis tick={{ fill: '#747e94', fontSize: 10 }} axisLine={false} tickLine={false} tickCount={5}/><Tooltip content={<CustomTooltip/>}/><Area type="monotone" name="Feedback" dataKey="feedback" stroke="#9b78ff" strokeWidth={2.5} fill="url(#feedbackFill)" activeDot={{ r: 4, stroke: '#c4b5fd', strokeWidth: 2, fill: '#121827' }}/><Area type="monotone" name="Positive" dataKey="positive" stroke="#22d3ee" strokeWidth={2} fill="url(#positiveFill)" activeDot={{ r: 4, stroke: '#67e8f9', strokeWidth: 2, fill: '#121827' }}/></AreaChart></ResponsiveContainer></div>
        <div className="chart-footnote"><span><span className="footnote-dot violet-bg"/> Customer messages</span><span>Latest activity <b>{data?.latestFeedbackDate || '—'}</b></span><Link to="/feedback">View all feedback <ArrowRight size={13}/></Link></div>
      </Panel>
      <Panel className="sentiment-panel" title="Sentiment overview" subtitle="How customers feel in this workspace">
        <div className="sentiment-chart-box"><div className="sentiment-chart"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={data?.sentiment || []} dataKey="value" nameKey="name" innerRadius="72%" outerRadius="94%" stroke="none" paddingAngle={4} startAngle={90} endAngle={-270}>{(data?.sentiment || []).map((entry, i) => <Cell key={entry.name} fill={palette[i]}/>)}</Pie><Tooltip content={<CustomTooltip/>}/></PieChart></ResponsiveContainer></div><div className="donut-center"><strong>{data?.totalFeedback.toLocaleString() || '—'}</strong><span>feedback items</span><small>{data?.negativePercent || 0}% negative</small></div></div>
        <div className="sentiment-legend">{(data?.sentiment || []).map((x, i) => <div key={x.name}><span><i style={{ background: palette[i] }}/>{x.name}</span><b>{x.value}<small>{data?.totalFeedback ? `${Math.round(x.value / data.totalFeedback * 100)}%` : ''}</small></b></div>)}</div>
      </Panel>
    </div>
    <div className="dashboard-grid secondary-analytics-grid">
      <Panel className="sources-panel" title="Feedback sources" subtitle="Where your customers are speaking up" action={<span className="text-link">All history</span>}>
        <div className="source-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={data?.sources || []} layout="vertical" margin={{ top: 2, right: 28, left: -8, bottom: 0 }} barSize={10}><CartesianGrid stroke="#232d40" strokeDasharray="3 6" horizontal={false}/><XAxis type="number" hide/><YAxis dataKey="name" type="category" axisLine={false} tickLine={false} width={83} tick={{ fill: '#a0a8ba', fontSize: 11 }}/><Tooltip content={<CustomTooltip/>}/><Bar dataKey="value" name="Feedback" radius={[0, 6, 6, 0]}>{(data?.sources || []).map((x, i) => <Cell key={x.name} fill={i === 0 ? '#9573ff' : i === 1 ? '#5969d8' : '#303d59'}/>)}</Bar></BarChart></ResponsiveContainer></div>
        <div className="source-foot"><span>Top 5 feedback sources</span><Link to="/settings">Manage integrations <ArrowRight size={13}/></Link></div>
      </Panel>
      <Panel className="issues-panel" title="Top customer issues" subtitle="Ranked by volume & severity" action={<Link className="text-link" to="/issues">All issues <ArrowRight size={13}/></Link>}>
        <div className="issue-list">{(data?.topIssues || []).slice(0, 4).map((item, i) => <IssueRow key={item.id} item={item} i={i}/>)}</div>
      </Panel>
    </div>
    <div className="dashboard-grid bottom-dashboard-grid">
      <Panel className="insights-panel" title="Latest AI insights" subtitle="Patterns worth your attention" icon={<Sparkles size={14}/>} action={<Link className="text-link" to="/insights">Explore insights <ArrowRight size={13}/></Link>}>
        <div className="insights-list">{(data?.recentInsights || []).map((item, i) => <InsightRow key={item.id} item={item} i={i}/>)}</div>
      </Panel>
      <Panel className="history-card" title="Your product remembers" subtitle="Context from across the customer journey"><div className="history-content"><span className="history-icon"><BrainCircuit size={21}/></span><div><b>Checkout friction goes back to January</b><p>Customers first mentioned navigation, then payment failures, and now abandoned purchases. Three signals, one journey to investigate.</p></div></div><div className="history-footer"><span><span className="tiny-online"/> Sample feedback timeline</span><Link to="/memory">Explore the story <ArrowRight size={13}/></Link></div></Panel>
    </div>
    {insightMutation.isSuccess && <div className="toast-success"><Check size={15}/> Insight generated and added to AI Insights.</div>}
  </div>;
}
