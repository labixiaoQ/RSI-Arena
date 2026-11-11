import type { Metadata } from 'next';
import { getExperiments } from '@/lib/public-data';
import { PageShell, Breadcrumb, Callout } from '@/components/arena/ui';
import { ExperimentList } from '@/components/arena/experiment-list';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '实验档案' };
export default async function ExperimentsPage() { const experiments = await getExperiments(); return <PageShell><div className="page-width page-content"><Breadcrumb items={[{ label: '实验档案' }]} /><div className="page-heading"><p className="eyebrow">EXPERIMENT LOG</p><h1>实验档案</h1><p>完整记录改进过程，也完整保留没有改进的结果。</p></div><Callout>这里展示探索性评测与工程验证。当前公开种子试验不作为隐藏测试排行榜；真实模型试验与受控验证分别标识。</Callout><ExperimentList experiments={experiments} /></div></PageShell>; }
