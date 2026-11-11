'use client';
import { useState } from 'react';
import { Search } from 'lucide-react';
import type { Experiment } from '@/lib/arena-types';
import { EmptyState, ExperimentCard } from './ui';
export function ExperimentList({ experiments }: { experiments: Experiment[] }) {
  const [query, setQuery] = useState(''); const [kind, setKind] = useState('all');
  const shown = experiments.filter(e => (kind === 'all' || e.evidence === kind) && `${e.title} ${e.summary} ${e.model} ${e.protocolId}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="filter-bar"><div className="segmented" role="group" aria-label="证据类型">{[['all', '全部'], ['live', '真实模型'], ['controlled', '受控验证']].map(([value, label]) => <button key={value} onClick={() => setKind(value)} className={kind === value ? 'active' : ''} aria-pressed={kind === value}>{label}</button>)}</div><label className="search-field"><Search size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索实验、模型或协议" aria-label="搜索实验" /></label></div><p className="result-count">{shown.length} 项实验</p>{shown.length ? <div className="experiment-grid">{shown.map(e => <ExperimentCard key={e.id} experiment={e} />)}</div> : <EmptyState title="没有符合条件的实验">试试其他关键词，或切换证据类型。</EmptyState>}</>;
}
