import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { lazy, Suspense, useState } from 'react';
import Layout from './components/Layout';

const OverviewPage = lazy(() => import('./pages/Overview').then(page => ({ default: page.OverviewPage })));
const FeedbackPage = lazy(() => import('./pages/Feedback').then(page => ({ default: page.FeedbackPage })));
const IssuesPage = lazy(() => import('./pages/Issues').then(page => ({ default: page.IssuesPage })));
const InsightsPage = lazy(() => import('./pages/Insights').then(page => ({ default: page.InsightsPage })));
const MemoryPage = lazy(() => import('./pages/Memory').then(page => ({ default: page.MemoryPage })));
const UpdatesPage = lazy(() => import('./pages/Updates').then(page => ({ default: page.UpdatesPage })));
const ImpactPage = lazy(() => import('./pages/Impact').then(page => ({ default: page.ImpactPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then(page => ({ default: page.SettingsPage })));

export default function App() {
  const location = useLocation();
  const [assistantOpen, setAssistantOpen] = useState(false);
  return <Layout onOpenAssistant={() => setAssistantOpen(true)} assistantOpen={assistantOpen} onCloseAssistant={() => setAssistantOpen(false)}>
    <AnimatePresence mode="wait" initial={false}>
      <Suspense fallback={<div className="route-loading" role="status">Loading workspace…</div>}>
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<OverviewPage onOpenAssistant={() => setAssistantOpen(true)} />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="/issues" element={<IssuesPage />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/updates" element={<UpdatesPage />} />
        <Route path="/impact" element={<ImpactPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </AnimatePresence>
  </Layout>;
}
