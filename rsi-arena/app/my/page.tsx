/* eslint-disable @next/next/no-html-link-for-pages -- Use document navigation to avoid the verified Vinext production prefetch failure. */
import type { Metadata } from 'next';
import { ArrowUpRight } from 'lucide-react';
import { PageShell, Breadcrumb } from '@/components/arena/ui';
import { SubmissionDashboard } from '@/components/arena/submission-dashboard';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '我的提交' };
export default function MyPage() { return <PageShell><div className="page-width page-content"><Breadcrumb items={[{ label: '我的提交' }]} /><div className="detail-heading"><div><p className="eyebrow">YOUR EXPERIMENTS</p><h1>我的提交</h1><p>从等待批准到结果归档，跟踪每一个实验的进展。</p></div><a href="/submit" className="button button-primary">新建提交<ArrowUpRight size={16} /></a></div><SubmissionDashboard /></div></PageShell>; }
