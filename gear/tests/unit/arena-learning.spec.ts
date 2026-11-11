import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ArenaBudget } from '../../src/adapters/arena/budget.js'
import { budgetedAgent } from '../../src/adapters/arena/agent.js'
import { evaluateEpisode } from '../../src/adapters/arena/episode.js'
import { generationBound } from '../../src/adapters/arena/planner.js'
import { runArenaExperiment } from '../../src/adapters/arena/coordinator.js'
import { ArenaProvider } from '../../src/adapters/arena/provider.js'
import { comparisonPlan, runArenaComparison } from '../../src/adapters/arena/comparison.js'
import {
  digest,
  type AgentRequest,
  type ArenaProtocol,
  type HarnessBundle,
  type MatchBackend,
  type MatchRequest,
  type ModelBackend,
} from '../../src/adapters/arena/contracts.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'gear-learning-'))
  roots.push(root)
  return root
}
const initial: HarnessBundle = {
  executor: { version: 1, instruction: 'E0' },
  improver: { version: 1, instruction: 'I0' },
}
const protocol: ArenaProtocol = {
  version: 2,
  mode: 'recursive',
  lookaheadDepth: 1,
  initialPolicy: 'P0',
  sdk: 'SDK',
  opponents: ['hidden-opponent-source'],
  rounds: 20,
  tasks: [
    { id: 'dev', family: 'dev', split: 'seed', seed: 7 },
    { id: 'gate', family: 'gate', split: 'held_out', seed: 23 },
  ],
  learning: {
    rules: 'Up increases y',
    trainingSeeds: [1],
    trainingOpponents: ['training-opponent-source'],
    maxPolicyCalls: 3,
    maxTokensPerCall: 32768,
  },
}
const limits = { agent_calls: 100, model_requests: 0, tokens: 0, episodes: 100, matches: 100 }
class Model implements ModelBackend {
  kind = 'fixture' as const
  identity = 'learning-test'
  calls: AgentRequest[] = []
  broken: 'none' | 'initial' | 'revision' | 'all' = 'none'
  allowance() {
    return { model_requests: 0, tokens: 0 }
  }
  async complete(request: AgentRequest) {
    this.calls.push(request)
    const input = JSON.parse(request.input),
      parent = input.harness
    let result: unknown
    if (request.phase === 'propose')
      result = {
        ...parent,
        improver: {
          version: 1,
          instruction:
            input.mode === 'fixed-improver' ? request.system : `I${Number(request.system.slice(1)) + 1}`,
        },
      }
    else if (request.phase === 'lookahead')
      result = {
        ...parent,
        executor: { version: 1, instruction: `E${request.system.slice(1)}` },
        improver: { version: 1, instruction: 'I999' },
      }
    else {
      if (input.stage === 'revise') {
        expect(input.training_feedback).toHaveLength(2)
        expect(input.training_feedback[0].own_behavior.unique_positions).toBe(1)
        expect(request.input).not.toContain('SECRET')
      }
      result = {
        policy:
          this.broken === 'all' ||
          (this.broken === 'initial' && input.stage === 'generate') ||
          (this.broken === 'revision' && input.stage === 'revise')
            ? 'broken'
            : input.stage === 'generate'
              ? 'P0'
              : `P${request.system.slice(1)}`,
      }
    }
    return { output: JSON.stringify(result), usage: { model_requests: 0, tokens: 0 } }
  }
}
class Matches implements MatchBackend {
  kind = 'fixture' as const
  identity = 'learning-matches'
  games: MatchRequest[] = []
  compilations = 0
  async compile(request: { policy: string }) {
    this.compilations++
    return {
      status: request.policy === 'broken' ? ('policy_failed' as const) : ('ready' as const),
      diagnostics: request.policy === 'broken' ? 'syntax error: expected semicolon' : '',
    }
  }
  async play(request: MatchRequest) {
    this.games.push(request)
    return {
      status: 'complete' as const,
      score: Number(request.policy.slice(1)) / 10,
      replay: 'SECRET-replay',
      details: {
        hidden_map: 'SECRET-map',
        own_behavior: {
          unique_positions: 1,
          final_gold: 0,
          final_mines: 0,
          first_capture_round: null,
          hidden: 'SECRET',
        },
      },
    }
  }
}
async function episode(broken: Model['broken']) {
  const budget = new ArenaBudget(join(await directory(), 'budget.sqlite'), limits, Date.now() + 60000)
  const model = new Model(),
    matches = new Matches()
  model.broken = broken
  const options = {
    id: 'episode/',
    target: { ...initial, improver: { version: 1 as const, instruction: 'I1' } },
    protocol,
    memory: [],
    budget,
    matches,
    agent: budgetedAgent(budget, model, protocol),
    seed: 7,
    signal: new AbortController().signal,
  }
  try {
    const result = await evaluateEpisode(options)
    const calls = model.calls.length,
      games = matches.games.length,
      compilations = matches.compilations
    expect(await evaluateEpisode(options)).toEqual(result)
    expect([model.calls.length, matches.games.length, matches.compilations]).toEqual([
      calls,
      games,
      compilations,
    ])
    return { result, model, matches, usage: budget.summary().observed }
  } finally {
    budget.close()
  }
}

it('repairs an initial compile failure once, trains, revises from own feedback, then scores fresh games', async () => {
  const { result, model, matches, usage } = await episode('initial')
  expect(
    model.calls.filter((call) => call.phase === 'learn').map((call) => JSON.parse(call.input).stage),
  ).toEqual(['generate', 'repair', 'revise'])
  expect(model.calls.filter((call) => call.phase === 'lookahead')).toHaveLength(1)
  expect(model.calls.some((call) => call.system === 'I999')).toBe(false)
  expect(matches.games.map((request) => request.seed)).toEqual([1, 1, 7, 7])
  expect(model.calls.some((call) => call.input.includes('opponent-source'))).toBe(false)
  expect(result.policy).toBe('P1')
  expect(result.score).toBe(0.1)
  expect(usage).toEqual({ agent_calls: 4, model_requests: 0, tokens: 0, episodes: 1, matches: 4 })
})

it('uses the same repair cap after revision failure and preserves the last valid policy on total failure', async () => {
  const revision = await episode('revision')
  expect(
    revision.model.calls.filter((call) => call.phase === 'learn').map((call) => JSON.parse(call.input).stage),
  ).toEqual(['generate', 'revise', 'repair'])
  const failed = await episode('all')
  expect(failed.model.calls).toHaveLength(4)
  expect(failed.result.policy).toBe('P0')
  expect(failed.result.score).toBe(0)
  expect(failed.matches.games.every((game) => game.policy === 'P0')).toBe(true)
})

it('rejects oversized per-call allowances before dispatch', async () => {
  const budget = new ArenaBudget(
    join(await directory(), 'budget.sqlite'),
    { ...limits, tokens: 100000, model_requests: 10 },
    Date.now() + 10000,
  )
  const model = {
    identity: 'oversized',
    kind: 'live' as const,
    allowance: () => ({ tokens: 32769, model_requests: 1 }),
    complete: vi.fn(),
  }
  try {
    await expect(
      budgetedAgent(budget, model, protocol)('x', 'learn', 'E', {}, new AbortController().signal),
    ).rejects.toThrow('per-call allowance')
    expect(model.complete).not.toHaveBeenCalled()
    expect(budget.summary().charged.agent_calls).toBe(0)
  } finally {
    budget.close()
  }
})

it('does not start a generation if any complete-generation resource bound is unavailable', async () => {
  const bound = generationBound(protocol, 'fixture')
  expect(bound).toEqual({ agent_calls: 17, model_requests: 0, tokens: 0, episodes: 4, matches: 16 })
  for (const dimension of ['agent_calls', 'episodes', 'matches'] as const) {
    const model = new Model(),
      matches = new Matches()
    const report = await runArenaExperiment({
      root: await directory(),
      initial,
      protocol,
      limits: { ...bound, [dimension]: bound[dimension] - 1 },
      epochs: 1,
      durationMs: 60000,
      model,
      matches,
    })
    expect(report.status).toBe('budget_exhausted')
    expect(report.epochs).toHaveLength(0)
    expect(model.calls).toHaveLength(0)
    expect(matches.compilations).toBe(0)
    expect(matches.games).toHaveLength(0)
  }
})

it('rejects training / selection leakage and missing compiler before any model work', async () => {
  const root = await directory(),
    model = new Model(),
    matches = new Matches()
  const options = { root, initial, protocol, limits, epochs: 1, durationMs: 60000, model, matches }
  await expect(
    runArenaExperiment({
      ...options,
      protocol: { ...protocol, learning: { ...protocol.learning!, trainingSeeds: [23] } },
    }),
  ).rejects.toThrow('disjoint')
  await expect(
    runArenaExperiment({
      ...options,
      matches: { kind: 'fixture', identity: 'no-compiler', play: matches.play },
    }),
  ).rejects.toThrow('compiler')
  expect(model.calls).toHaveLength(0)
})

it('inherits I over three feedback-learning generations, resumes a committed operation, and never replays completed work', async () => {
  const root = await directory(),
    model = new Model(),
    matches = new Matches()
  const options = { root, initial, protocol, limits, epochs: 3, durationMs: 120000, model, matches }
  const submit = ArenaProvider.prototype.submit
  vi.spyOn(ArenaProvider.prototype, 'submit').mockImplementationOnce(async function (
    this: ArenaProvider,
    request,
    signal,
  ) {
    await submit.call(this, request, signal)
    throw new Error('lost acknowledgment')
  })
  await expect(runArenaExperiment(options)).rejects.toThrow('lost acknowledgment')
  const report = await runArenaExperiment(options)
  expect(report.epochs.map((epoch) => epoch.gate)).toEqual(['accepted', 'accepted', 'accepted'])
  expect(model.calls.filter((call) => call.phase === 'propose').map((call) => call.system)).toEqual([
    'I0',
    'I1',
    'I2',
  ])
  expect(report.epochs.map((epoch) => epoch.retained_improver)).toEqual(
    [1, 2, 3].map((n) => digest({ version: 1, instruction: `I${n}` })),
  )
  for (const call of model.calls.filter((entry) => entry.phase === 'propose')) {
    const input = JSON.parse(call.input)
    expect(
      [...input.feedback, ...input.memory].every(
        (row: { task: string; candidate_id: string }) => row.task === 'dev' && !!row.candidate_id,
      ),
    ).toBe(true)
  }
  const counts = [model.calls.length, matches.games.length, matches.compilations]
  expect(await runArenaExperiment(options)).toEqual(report)
  expect([model.calls.length, matches.games.length, matches.compilations]).toEqual(counts)
  expect(JSON.parse(await readFile(join(root, 'epochs/000/admission.json'), 'utf8')).bound.agent_calls).toBe(
    17,
  )
}, 60000)

it('freezes both fair-comparison arms before fresh disjoint audits and resumes without any external work', async () => {
  const root = await directory(),
    model = new Model(),
    matches = new Matches()
  const plan = comparisonPlan(protocol, 'fixture', 1, [31, 47])
  expect(plan.total).toEqual({ agent_calls: 50, model_requests: 0, tokens: 0, episodes: 12, matches: 48 })
  const options = {
    root,
    initial,
    protocol,
    model,
    matches,
    epochs: 1,
    durationMs: 120000,
    auditSeeds: [31, 47],
    limitsPerArm: plan.per_arm,
    limitsPerAudit: plan.per_audit,
  }
  const result = await runArenaComparison(options)
  expect(result.status).toBe('completed')
  expect(result.paired_C_minus_B).toBe(0.1)
  expect(result.arms[0]!.epochs[0]!.retained_improver).toBe(digest(initial.improver))
  expect(result.arms[1]!.epochs[0]!.retained_improver).not.toBe(digest(initial.improver))
  expect(
    result.audits.every((arm) => arm.result.episodes.map((episode) => episode.seed).join() === '31,47'),
  ).toBe(true)
  const firstAudit = matches.games.findIndex((game) => game.seed === 31)
  expect(
    matches.games
      .slice(firstAudit)
      .filter((game) => game.id.includes('/match-'))
      .every((game) => [31, 47].includes(game.seed)),
  ).toBe(true)
  const snapshot = await readFile(join(root, 'frozen.json'), 'utf8')
  expect(JSON.parse(snapshot).map((arm: { label: string }) => arm.label)).toEqual(['B', 'C'])
  const calls = model.calls.length,
    games = matches.games.length,
    compiles = matches.compilations
  expect(await runArenaComparison(options)).toEqual(result)
  expect([model.calls.length, matches.games.length, matches.compilations]).toEqual([calls, games, compiles])
  await expect(runArenaComparison({ ...options, auditSeeds: [31, 59] })).rejects.toThrow()
  expect(model.calls).toHaveLength(calls)
}, 60000)

it('plans real model costs and rejects audit leakage or incomplete arm funding', async () => {
  const plan = comparisonPlan(protocol, 'live', 1, [31, 47])
  expect(plan.total.model_requests).toBe(50)
  expect(plan.total.tokens).toBe(50 * 32768)
  expect(() => comparisonPlan(protocol, 'live', 1, [7, 47])).toThrow('disjoint')
  const model = new Model(),
    matches = new Matches()
  await expect(
    runArenaComparison({
      root: await directory(),
      initial,
      protocol,
      model,
      matches,
      epochs: 1,
      durationMs: 60000,
      auditSeeds: [31, 47],
      limitsPerArm: { ...plan.per_arm, matches: 0 },
      limitsPerAudit: plan.per_audit,
    }),
  ).rejects.toThrow('allowance')
  expect(model.calls).toHaveLength(0)
})

it('reports unresolved comparison work and does not silently restart a failed arm', async () => {
  const root = await directory(),
    model = new Model(),
    matches = new Matches()
  const plan = comparisonPlan(protocol, 'fixture', 1, [31, 47])
  const options = {
    root,
    initial,
    protocol,
    model,
    matches,
    epochs: 1,
    durationMs: 60000,
    auditSeeds: [31, 47],
    limitsPerArm: plan.per_arm,
    limitsPerAudit: plan.per_audit,
  }
  matches.play = vi.fn(async () => {
    throw new Error('lost game result')
  })
  await expect(runArenaComparison(options)).rejects.toThrow('lost game result')
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))
  expect(report.status).toBe('needs_recovery')
  expect(report.paired_C_minus_B).toBeNull()
  expect(report.budget.charged.matches).toBe(1)
  expect(report.budget.unknown).toHaveLength(1)
  const calls = model.calls.length
  await expect(runArenaComparison(options)).rejects.toThrow('Unresolved')
  expect(matches.play).toHaveBeenCalledTimes(1)
  expect(model.calls).toHaveLength(calls)
}, 30000)

it('records invalid model proposals as failures, retains the sealed parent and never retries or evaluates them', async () => {
  for (const invalid of ['oversized', 'malformed', 'fixed-I-change']) {
    const root = await directory(),
      model = new Model(),
      matches = new Matches()
    const complete = model.complete.bind(model)
    model.complete = async (request) => {
      if (request.phase !== 'propose') return complete(request)
      model.calls.push(request)
      const value = {
        ...initial,
        executor: { version: 1, instruction: invalid === 'oversized' ? 'x'.repeat(2049) : 'E1' },
        improver: { version: 1, instruction: invalid === 'fixed-I-change' ? 'I1' : 'I0' },
      }
      return {
        output: invalid === 'malformed' ? 'invalid JSON' : JSON.stringify(value),
        usage: { model_requests: 0, tokens: 0 },
      }
    }
    const result = await runArenaExperiment({
      root,
      initial,
      protocol: { ...protocol, mode: invalid === 'fixed-I-change' ? 'fixed-improver' : 'recursive' },
      limits,
      epochs: 1,
      durationMs: 60000,
      model,
      matches,
    })
    expect(result.status).toBe('completed')
    expect(result.epochs[0]!.retained_bundle).toBe(digest(initial))
    expect(result.epochs[0]!.gate).not.toBe('accepted')
    expect(model.calls.filter((call) => call.phase === 'propose')).toHaveLength(1)
    expect(result.budget.observed.episodes).toBe(1)
    expect(matches.games).toHaveLength(4)
    expect(result.budget.unknown).toEqual([])
  }
}, 60000)
