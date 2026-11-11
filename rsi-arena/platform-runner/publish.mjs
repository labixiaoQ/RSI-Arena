import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { sha256 } from './core.mjs';

export const publicCounts = (value) => ({ modelRequests: value.model_requests, tokens: value.tokens, matches: value.matches, episodes: value.episodes });
async function scopedJson(path, root) {
  const [actual, base] = await Promise.all([realpath(path), realpath(root)]);
  if (!actual.startsWith(base + sep) || (await stat(actual)).size > 8 * 1024 * 1024) throw new Error('Artifact source is outside the job or oversized');
  return { bytes: await readFile(actual), actual };
}
function number(value, fallback = 0) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function player(p) { return { id: number(p.id), x: number(p.x), y: number(p.y), blinkCd: number(p['blink-cd']) }; }
export function normalizeReplay(bytes, jobId, match) {
  const data = JSON.parse(bytes.toString('utf8'));
  const width = data.map?.width, height = data.map?.height, terrain = data.map?.terrain;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 100 || height > 100 || typeof terrain !== 'string' || terrain.length !== width * height || !Array.isArray(data['rounds-info']) || data['rounds-info'].length > 1000) throw new Error('Invalid game replay');
  return {
    id: match.id, experimentId: jobId, title: `${match.arm} · ${match.phase} · seed ${match.seed}`,
    // MoneCraft output.cc serializes x in the outer loop and y in the inner loop.
    board: Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => terrain[x * height + y] === '#' ? 1 : 0)),
    initialPlayers: (data['init-players'] || []).map((p) => ({ id: number(p.id), x: number(p.x), y: number(p.y) })),
    initialMines: (data['init-mines'] || []).map((m) => ({ id: number(m.id), x: number(m.x), y: number(m.y), owner: number(m.owner, -1) })),
    frames: data['rounds-info'].map((frame) => ({
      round: number(frame.rounds) + 1, players: (frame.players || []).map(player),
      mines: (frame.mines || []).map((m) => ({ id: number(m.id), owner: number(m.owner, -1), point: number(m.point), protection: number(m['ptc-round']) })),
      gold: [0, 1].map((id) => number(frame.ginfo?.find((p) => p.id === id)?.golds)),
      mineCounts: [0, 1].map((id) => number(frame.ginfo?.find((p) => p.id === id)?.['mine-num'])),
      observers: (frame.OB || []).map((ob, index) => ({ id: number(ob.id, index), x: number(ob.x), y: number(ob.y), owner: number(ob.owner, -1) })),
    })),
    winner: number(data.result?.winner, -1), seed: match.seed, seat: match.seat, rounds: data['rounds-info'].length, sourceDigest: `sha256:${sha256(bytes)}`,
  };
}
export async function publicArtifacts(job, result, root) {
  const { report, initial, gearDigest, recordings } = result;
  const controlled = job.manifest.evidence_kind === 'controlled';
  const nodes = [], edges = [], arms = [];
  for (const arm of report.arms) {
    const audit = report.audits.find((item) => item.label === arm.label).result;
    let prior = `${arm.label.toLowerCase()}-initial`;
    nodes.push({ id: prior, label: `${arm.label} · 初始 H`, arm: arm.label, epoch: 0, state: 'initial', executor: gearDigest(initial.executor), improver: gearDigest(initial.improver), note: '两组从相同 H 开始' });
    for (const epoch of arm.epochs) {
      const raw = await scopedJson(join(epoch.exported_target, 'executor.json'), root);
      const id = `${arm.label.toLowerCase()}-retained-${epoch.epoch + 1}`;
      nodes.push({ id, label: `${arm.label} · 第 ${epoch.epoch + 1} 代保留 H`, arm: arm.label, epoch: epoch.epoch + 1, state: 'retained', executor: gearDigest(JSON.parse(raw.bytes)), improver: epoch.retained_improver, note: `Gear gate: ${epoch.gate}。节点展示实际继承的 H。` });
      edges.push({ from: prior, to: id }); prior = id;
    }
    arms.push({ id: arm.label, label: arm.label === 'B' ? '固定改进器' : '递归改进器', mode: arm.label === 'B' ? 'fixed-improver' : 'recursive', score: audit.mean_score, gate: arm.epochs.at(-1).gate, retainedHarness: arm.frozen_harness, initialImprover: gearDigest(initial.improver), finalImprover: arm.epochs.at(-1).retained_improver, scores: audit.episodes.map((entry) => ({ seed: entry.seed, score: entry.score, status: entry.status === 'task_failed' ? 'task_failed' : 'completed', failureReason: entry.failure_reason ?? null })) });
  }
  const replays = [], matches = [];
  for (const recording of recordings) {
    // Controlled games have no real game trajectory. Never fabricate a MoneCraft replay.
    if (controlled) continue;
    const { request, receipt } = recording;
    const arm = report.arms.find((entry) => entry.epochs.some((epoch) => request.id.startsWith(`${epoch.run_id}/`)))?.label
      || ['B', 'C'].find((label) => request.id.startsWith(`audit/${gearDigest(join(root, 'gear', label, 'audit'))}/`));
    if (!arm) throw new Error('Match lacks attributable arm');
    const phase = request.id.includes('/train-') ? 'training' : request.id.startsWith('audit/') ? 'audit' : 'development';
    const id = `match-${sha256(`${job.id}/${request.id}`).slice(0, 32)}`;
    const match = { id, experimentId: job.id, arm, phase, seed: request.seed, seat: request.seat, score: receipt.score, opponent: `fixed-${Math.max(0, result.protocol.opponents.indexOf(request.opponent)) + 1}`, status: receipt.status, rounds: 0, replayUrl: null };
    if (receipt.replay) {
      const replay = normalizeReplay((await scopedJson(receipt.replay, root)).bytes, job.id, match);
      match.rounds = replay.rounds; match.replayUrl = `/replays/${id}`;
      replays.push(replay);
    } else if (receipt.status !== 'policy_failed') throw new Error('Completed match replay is missing');
    matches.push(match);
  }
  const experiment = {
    id: job.id, title: job.title || (controlled ? '受控闭环验证' : 'MoneCraft RSI 对照试验'),
    summary: controlled ? '真实运行 Gear 编排与预算账本；模型与对局均由确定性 fixture 提供，不代表模型或游戏能力。' : '在固定预算、固定对手和分离的审计种子上比较固定 I 与递归 I。',
    game: 'MoneCraft', status: 'completed', evidence: controlled ? 'controlled' : 'live', protocolId: job.manifest.protocol_id,
    model: controlled ? 'controlled-fixture' : job.manifest.model_profile_id, createdAt: job.approval.approvedAt,
    classification: controlled ? 'controlled_validation' : report.same_harness ? 'same_harness_repeat' : 'exploratory',
    sameHarness: report.same_harness, amendment: null,
    metricScope: controlled ? '确定性 fixture 分数，仅验证执行路径；无真实模型调用和游戏对局。' : '固定种子及对手上的描述性 episode score；不是正式隐藏测试，也未建立 RSI 优越性。',
    usage: publicCounts(report.budget.observed), limits: publicCounts(job.manifest.caps), arms, nodes, edges, matches,
    notes: [
      'I 跨代继承以 Gear 导出产物为准；一步后续评测的临时 I 不进入继承。',
      controlled ? '所有模拟对局均明确记为 controlled；不生成或伪造游戏回放。' : '执行隔离为 experimental development profile，任务经过人工批准并在专用执行机器运行。',
      report.same_harness ? 'B/C 最终 H 相同；分差不能归因于 I 的改进。' : '两种搜索程序的差异不等于隔离得到的 I 因果效应。',
      `Manifest ${job.manifestDigest}`, `Gear ${job.manifest.gear_implementation_digest || 'local build recorded in private checkpoint'}`,
    ], artifacts: [],
  };
  return { experiment, replays };
}
