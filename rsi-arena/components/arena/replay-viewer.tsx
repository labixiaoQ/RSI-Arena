'use client';
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, SkipBack, SkipForward, Loader2 } from 'lucide-react';
import type { Replay } from '@/lib/arena-types';
const PLAYER_COLORS = ['#9ce7bd', '#f2bc69'];
export function ReplayViewer({ replay: initialReplay, compact = false }: { replay: Replay & { dataUrl?: string }; compact?: boolean }) {
  const [replay, setReplay] = useState(initialReplay);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [loading, setLoading] = useState(!compact && initialReplay.frames.length === 0 && Boolean(initialReplay.dataUrl));
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const loaded = replay.frames.length > 0;
  const frame = replay.frames[index];
  const total = replay.frames.length;
  const ended = loaded && index >= total - 1;
  async function loadReplay() {
    if (loaded || !initialReplay.dataUrl) return loaded;
    setLoading(true); setError('');
    try { const response = await fetch(initialReplay.dataUrl); if (!response.ok) throw new Error('回放暂时无法读取，请稍后重试。'); const value = await response.json() as Replay; if (!Array.isArray(value.frames) || !value.frames.length) throw new Error('回放尚未生成可播放的轨迹。'); setReplay(value); return true; } catch (e) { setError(e instanceof Error ? e.message : '读取回放失败。'); return false; } finally { setLoading(false); }
  }
  useEffect(() => { if (!compact && !loaded && initialReplay.dataUrl) { let active = true; fetch(initialReplay.dataUrl).then(async r => { if (!r.ok) throw new Error('回放暂时无法读取，请稍后重试。'); const value = await r.json() as Replay; if (!Array.isArray(value.frames) || !value.frames.length) throw new Error('回放尚未生成可播放的轨迹。'); if (active) { setReplay(value); setLoading(false); } }).catch(e => { if (active) { setError(e.message); setLoading(false); } }); return () => { active = false; }; } }, [compact, initialReplay.dataUrl, loaded]);
  useEffect(() => { if (!playing || !total) return; const timer = window.setInterval(() => setIndex(i => { if (i >= total - 1) { setPlaying(false); return i; } return Math.min(total - 1, i + speed); }), 100); return () => window.clearInterval(timer); }, [playing, speed, total]);
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const ctx = element.getContext('2d'); if (!ctx) return;
    const rows = replay.board.length; const columns = replay.board[0]?.length ?? rows;
    if (!rows || !columns) return;
    const size = 744; element.width = size; element.height = size;
    const cell = size / Math.max(rows, columns);
    const px = (x: number) => (x + 0.5) * cell;
    const py = (y: number) => (rows - y - 0.5) * cell;
    ctx.fillStyle = '#122b29'; ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const wall = replay.board[y][x] !== 0;
      ctx.fillStyle = wall ? '#42645a' : ((x + y) % 2 ? '#17322e' : '#183730');
      ctx.fillRect(x * cell + 0.8, (rows - 1 - y) * cell + 0.8, cell - 1.6, cell - 1.6);
      if (wall) { ctx.fillStyle = '#527265'; ctx.fillRect(x * cell + 1, (rows - 1 - y) * cell + 1, cell - 2, 3); }
    }
    replay.initialMines.forEach(mine => {
      const state = frame?.mines.find(m => m.id === mine.id); const owner = state?.owner ?? mine.owner;
      const color = PLAYER_COLORS[owner] ?? '#d0cfaa'; const x = px(mine.x), y = py(mine.y);
      ctx.fillStyle = owner >= 0 ? `${color}22` : '#d0cfaa18'; ctx.fillRect(x - cell * 1.42, y - cell * 1.42, cell * 2.84, cell * 2.84);
      ctx.beginPath(); ctx.moveTo(x, y - cell * 0.4); ctx.lineTo(x + cell * 0.36, y); ctx.lineTo(x, y + cell * 0.4); ctx.lineTo(x - cell * 0.36, y); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = '#132d28'; ctx.lineWidth = 2; ctx.stroke();
    });
    frame?.observers?.forEach(observer => { ctx.strokeStyle = PLAYER_COLORS[observer.owner] ?? '#b9c6b3'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(px(observer.x), py(observer.y), cell * 0.2, 0, Math.PI * 2); ctx.stroke(); });
    (frame?.players ?? replay.initialPlayers).forEach(player => {
      const color = PLAYER_COLORS[player.id] ?? '#ffffff'; const x = px(player.x), y = py(player.y);
      ctx.shadowColor = color; ctx.shadowBlur = 14; ctx.fillStyle = color; ctx.fillRect(x - cell * .34, y - cell * .34, cell * .68, cell * .68); ctx.shadowBlur = 0;
      ctx.strokeStyle = '#f6f8dc'; ctx.lineWidth = 1.4; ctx.strokeRect(x - cell * .34, y - cell * .34, cell * .68, cell * .68);
      ctx.fillStyle = '#112e27'; ctx.fillRect(x - cell * .18, y - cell * .13, cell * .1, cell * .1); ctx.fillRect(x + cell * .08, y - cell * .13, cell * .1, cell * .1);
    });
  }, [replay, frame]);
  async function toggle() { if (!loaded) { if (await loadReplay()) setPlaying(true); return; } if (ended) setIndex(0); setPlaying(p => !p); }
  return <div className={`replay-viewer ${compact ? 'replay-compact' : ''}`}><div className="board-wrap"><canvas ref={canvas} aria-label={`MoneCraft 棋盘，第 ${frame?.round ?? 0} 回合；${replay.initialMines.length} 座矿点`} role="img" /><div className="board-round"><span className="live-dot" />{playing ? 'PLAYING' : ended ? 'FINISHED' : 'REPLAY'}<b>{String(frame?.round ?? 0).padStart(4, '0')}</b><small>/ {replay.rounds}</small></div>{compact && <button className="board-play" onClick={toggle} disabled={loading} aria-label={playing ? '暂停回放' : '播放真实对局'}>{loading ? <Loader2 size={24} className="spin" /> : playing ? <Pause size={24} /> : <Play size={24} />}</button>}</div>{!compact && <><div className="replay-scoreboard">{[0, 1].map(id => <div key={id} className={`player-stats player-${id}`}><span className="player-square" /><strong>PLAYER {id}</strong><span>{replay.seat === id ? '被测策略' : '固定对手'}</span><div><b>{(frame?.gold[id] ?? 0).toLocaleString()}</b><small>金币</small></div><div><b>{frame?.mineCounts[id] ?? 0}</b><small>矿点</small></div></div>)}</div><div className="replay-controls"><div className="timeline-label"><span>对局时间轴</span><span className="mono">ROUND {frame?.round ?? 0} / {replay.rounds}</span></div><input className="timeline" type="range" min="0" max={Math.max(total - 1, 1)} value={index} disabled={!loaded} aria-label="选择对局回合" onChange={e => { setIndex(Number(e.target.value)); setPlaying(false); }} /><div className="playback-buttons"><div><button className="icon-button" onClick={() => { setIndex(0); setPlaying(false); }} disabled={!loaded} aria-label="跳到开局"><SkipBack size={18} /></button><button className="button button-primary play-button" onClick={toggle} disabled={loading}>{loading ? <Loader2 size={18} className="spin" /> : playing ? <Pause size={18} /> : ended ? <RotateCcw size={18} /> : <Play size={18} />}{loading ? '加载中' : playing ? '暂停' : ended ? '重新播放' : '播放'}</button><button className="icon-button" onClick={() => { setIndex(Math.max(total - 1, 0)); setPlaying(false); }} disabled={!loaded} aria-label="跳到终局"><SkipForward size={18} /></button></div><label className="speed-select">播放速度<select value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={1}>10 回合 / 秒</option><option value={5}>50 回合 / 秒</option><option value={10}>100 回合 / 秒</option><option value={25}>250 回合 / 秒</option></select></label></div></div></>}{error && <div className="replay-error" role="alert">{error}<button onClick={loadReplay}>重试</button></div>}<div className="board-legend"><span><i className="legend-player p0" />P0</span><span><i className="legend-player p1" />P1</span><span><i className="legend-mine" />矿点</span><span><i className="legend-wall" />墙体</span><span className="legend-coordinate">↑ Y</span></div></div>;
}
