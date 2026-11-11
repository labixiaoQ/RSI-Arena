import type { Metadata } from 'next';
import { PageShell, Breadcrumb } from '@/components/arena/ui';
import { SubmissionForm } from '@/components/arena/submission-form';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '提交参评' };
export default function SubmitPage() { return <PageShell><div className="page-width page-content"><Breadcrumb items={[{ label: '提交参评' }]} /><div className="page-heading"><p className="eyebrow">NEW SUBMISSION</p><h1>从一组 E / I 开始。</h1><p>提出你的改进假设，用相同的评测规则检验它。</p></div><SubmissionForm /></div></PageShell>; }
