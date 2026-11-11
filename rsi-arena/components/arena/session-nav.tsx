/* eslint-disable @next/next/no-html-link-for-pages -- Use document navigation to avoid the verified Vinext production prefetch failure. */
'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import type { SessionInfo } from '@/lib/arena-types';
export function SessionNav() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { let current = true; fetch('/api/session').then(r => r.ok ? r.json() : null).then(s => { if (current) setSession(s as SessionInfo | null); }).catch(() => {}); return () => { current = false; }; }, []);
  return <><div className="nav-actions">{session?.admin && <a href="/ops" className="ops-link">运营台</a>}<a href="/submit" className="button button-dark nav-submit">提交参评<ArrowUpRight size={14} /></a><button className="mobile-menu-button icon-button" aria-label={open ? '关闭导航' : '打开导航'} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X size={22} /> : <Menu size={22} />}</button></div>{open && <nav className="mobile-nav" aria-label="移动导航"><a href="/experiments">实验档案</a><a href="/protocol">评测协议</a><a href="/my">我的提交</a>{session?.admin && <a href="/ops">运营台</a>}</nav>}</>;
}
