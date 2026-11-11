import type { Metadata } from 'next';
import { PageShell, Breadcrumb } from '@/components/arena/ui';
import { SubmissionDashboard } from '@/components/arena/submission-dashboard';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '运营台' };
export default function OpsPage() { return <PageShell><div className="page-width page-content"><Breadcrumb items={[{ label: '运营台' }]} /><div className="page-heading"><p className="eyebrow">OPERATIONS</p><h1>审核与执行队列</h1><p>在明确的额度和执行条件下，让每一次运行有据可查。</p></div><SubmissionDashboard ops /></div></PageShell>; }
