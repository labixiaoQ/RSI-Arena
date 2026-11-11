import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: { default: 'RSI Arena · 让改进有据可循', template: '%s · RSI Arena' },
  description: '以 MoneCraft 对战为环境，在固定模型和预算下评测 Agent 的递归自我改进。查看真实实验、跨代继承、对战回放和资源消耗。',
  icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body><a className="skip-link" href="#main-content">跳至主要内容</a>{children}</body></html>; }
