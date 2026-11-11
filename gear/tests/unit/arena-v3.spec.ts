import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { budgetedAgent } from '../../src/adapters/arena/agent.js'
import { ArenaBudget } from '../../src/adapters/arena/budget.js'
import { comparisonPlan, frozenEvaluation, runArenaComparison } from '../../src/adapters/arena/comparison.js'
import {
  digest,
  type AgentReply,
  type AgentRequest,
  type ArenaProtocol,
  type HarnessBundle,
  type ModelBackend,
} from '../../src/adapters/arena/contracts.js'
import { runArenaExperiment } from '../../src/adapters/arena/coordinator.js'
import { evaluateEpisode } from '../../src/adapters/arena/episode.js'
import { HttpModel } from '../../src/adapters/arena/model.js'
import { generationBound } from '../../src/adapters/arena/planner.js'

const roots: string[] = [],
  budgets: ArenaBudget[] = []
afterEach(async () => {
  for (const budget of budgets.splice(0)) budget.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'gear-arena-v3-'))
  roots.push(root)
  return root
}
const initial: HarnessBundle = {
  executor: { version: 1, instruction: 'E0' },
  improver: { version: 1, instruction: 'I0' },
}
const protocol: ArenaProtocol = {
  version: 3,
  mode: 'recursive',
  lookaheadDepth: 1,
  initialPolicy: 'P0',
  sdk: 'SDK',
  opponents: ['opponent'],
  rounds: 20,
  tasks: [
    { id: 'dev', family: 'dev', split: 'seed', seed: 7 },
    { id: 'gate', family: 'gate', split: 'held_out', seed: 23 },
  ],
  learning: {
    rules: 'Original game rules.',
    trainingSeeds: [1],
    trainingOpponents: ['training-opponent'],
    maxPolicyCalls: 3,
    maxTokensPerCall: 32768,
  },
}
function matches() {
  return {
    kind: 'fixture' as const,
    identity: 'v3-test-matches',
    compile: vi.fn(async () => ({ status: 'ready' as const, diagnostics: '' })),
    play: vi.fn(async () => ({ status: 'complete' as const, score: 0.5, replay: null, details: {} })),
  }
}
function model(output: string, kind: ModelBackend['kind'] = 'fixture') {
  return {
    kind,
    identity: 'v3-test-model',
    allowance: () => ({ model_requests: kind === 'live' ? 1 : 0, tokens: kind === 'live' ? 1000 : 0 }),
    complete: vi.fn(async (_request: AgentRequest): Promise<AgentReply> => ({
      output,
      usage: { model_requests: kind === 'live' ? 1 : 0, tokens: kind === 'live' ? 7 : 0 },
    })),
  }
}
async function episodeOptions(backend: ModelBackend, version: ArenaProtocol['version'] = 3) {
  const config = { ...protocol, version },
    budget = new ArenaBudget(
      join(await directory(), 'budget.sqlite'),
      generationBound({ ...config, version: version === 1 ? 2 : version }, backend.kind),
      Date.now() + 60000,
    )
  budgets.push(budget)
  return {
    id: 'episode/',
    target: initial,
    protocol: config,
    memory: [],
    budget,
    matches: matches(),
    agent: budgetedAgent(budget, backend, config),
    seed: 7,
    signal: new AbortController().signal,
  }
}

it.each([
  ['invalid JSON', 'not JSON', 'malformed_json'],
  [
    'oversized E',
    JSON.stringify({ ...initial, executor: { version: 1, instruction: 'x'.repeat(2049) } }),
    'invalid_harness',
  ],
  [
    'oversized discarded I',
    JSON.stringify({ ...initial, improver: { version: 1, instruction: '字'.repeat(683) } }),
    'invalid_harness',
  ],
  ['missing field', JSON.stringify({ executor: initial.executor }), 'invalid_harness'],
  ['extra field', JSON.stringify({ ...initial, tool: 'not-allowed' }), 'invalid_harness'],
])(
  'v3 scores %s lookahead as a settled task failure, without E, compilation or matches',
  async (_label, output, reason) => {
    const backend = model(output, 'live'),
      options = await episodeOptions(backend)
    const result = await evaluateEpisode(options)
    expect(result).toMatchObject({
      status: 'task_failed',
      failure: { kind: 'invalid_lookahead', reason },
      probe: null,
      policy: null,
      learning: null,
      games: [],
      score: 0,
      execution: {
        improver: { status: 'executed', instruction_digest: digest(initial.improver) },
        executor: { status: 'not_executed', instruction_digest: null },
      },
    })
    expect(backend.complete.mock.calls.map(([request]) => request.phase)).toEqual(['lookahead'])
    expect(options.matches.compile).not.toHaveBeenCalled()
    expect(options.matches.play).not.toHaveBeenCalled()
    expect(options.budget.summary()).toMatchObject({
      charged: { agent_calls: 1, model_requests: 1, tokens: 7, episodes: 1, matches: 0 },
      observed: { agent_calls: 1, model_requests: 1, tokens: 7, episodes: 1, matches: 0 },
      unknown: [],
    })
    expect(await evaluateEpisode(options)).toEqual(result)
    expect(backend.complete).toHaveBeenCalledTimes(1)
  },
)

it.each([1, 2] as const)(
  'keeps protocol v%s malformed lookahead as the historical exception',
  async (version) => {
    const backend = model('not JSON'),
      options = await episodeOptions(backend, version)
    await expect(evaluateEpisode(options)).rejects.toThrow()
    expect(options.matches.play).not.toHaveBeenCalled()
    expect(backend.complete).toHaveBeenCalledTimes(1)
  },
)

it.each([2, 3] as const)('uses the same bounded learning and repair allowance in v%s', async (version) => {
  const backend = model(''),
    options = await episodeOptions(backend, version)
  backend.complete.mockImplementation(async (request) => ({
    output:
      request.phase === 'lookahead'
        ? JSON.stringify(initial)
        : JSON.parse(request.input).stage === 'generate'
          ? 'malformed policy'
          : JSON.stringify({ policy: 'P1' }),
    usage: { model_requests: 0, tokens: 0 },
  }))
  const result = await evaluateEpisode(options)
  expect(result.status).toBe('complete')
  expect(result.score).toBe(0.5)
  const requests = backend.complete.mock.calls.map(([request]) => request)
  expect(requests.map((request) => request.phase)).toEqual(['lookahead', 'learn', 'learn', 'learn'])
  expect(requests.slice(1).map((request) => JSON.parse(request.input).stage)).toEqual([
    'generate',
    'repair',
    'revise',
  ])
  expect(options.matches.play).toHaveBeenCalledTimes(4)
  expect(generationBound(options.protocol, 'live')).toEqual(
    generationBound({ ...protocol, version: 2 }, 'live'),
  )
  for (const request of requests) {
    const rules = JSON.parse(request.input).game_contract
    if (version === 3) {
      expect(rules).toContain('Player.owner to RoundInfo.player_id')
      expect(rules).toContain('Never index ri.players[player_id]')
    } else expect(rules).toBe(protocol.learning!.rules)
  }
})

it.each(['partial output', '', JSON.stringify(initial)] as const)(
  'settles measured HTTP truncation (%s) before the v3 zero-score outcome',
  async (output) => {
    vi.stubEnv('ARENA_V3_TEST_KEY', 'fixture-only')
    const fetch = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: output }, finish_reason: 'length' }],
        usage: { total_tokens: 17 },
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const backend = new HttpModel(
      'https://example.test/chat/completions',
      'fixture',
      'ARENA_V3_TEST_KEY',
      100,
    )
    const options = await episodeOptions(backend)
    const result = await evaluateEpisode(options)
    expect(result).toMatchObject({ status: 'task_failed', score: 0, failure: { reason: 'truncated' } })
    expect(options.budget.summary()).toMatchObject({
      charged: { model_requests: 1, tokens: 17 },
      unknown: [],
    })
    expect(options.matches.compile).not.toHaveBeenCalled()
    expect(options.matches.play).not.toHaveBeenCalled()
    expect(await evaluateEpisode(options)).toEqual(result)
    expect(fetch).toHaveBeenCalledTimes(1)
  },
)

it.each([1, 2] as const)(
  'keeps confirmed truncation as the historical reserved exception in v%s',
  async (version) => {
    const backend = model('partial output', 'live')
    backend.complete.mockResolvedValue({
      output: 'partial output',
      usage: { model_requests: 1, tokens: 17 },
      invalid_output: { reason: 'truncated', detail: 'Model output was truncated' },
    })
    const options = await episodeOptions(backend, version)
    await expect(evaluateEpisode(options)).rejects.toThrow('truncated')
    expect(options.budget.summary()).toMatchObject({
      charged: { model_requests: 1, tokens: 1000 },
      unknown: ['episode/lookahead'],
    })
  },
)

it.each(['network', 'missing usage'] as const)(
  'retains unknown %s allowance, marks needs_recovery and never retries it',
  async (failure) => {
    const root = await directory(),
      backend = model('', 'live'),
      matchBackend = matches()
    backend.complete.mockImplementation(async () => {
      if (failure === 'network') throw new Error('Network disconnected after invalid JSON bytes')
      return { output: 'invalid JSON' } as AgentReply
    })
    const options = {
      root,
      initial,
      protocol,
      limits: generationBound(protocol, 'live'),
      epochs: 1,
      durationMs: 60000,
      model: backend,
      matches: matchBackend,
    }
    await expect(runArenaExperiment(options)).rejects.toThrow()
    const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))
    expect(report.status).toBe('needs_recovery')
    expect(report.budget.unknown).toHaveLength(1)
    expect(report.budget.charged).toMatchObject({ model_requests: 1, tokens: 1000, matches: 0 })
    expect(matchBackend.compile).not.toHaveBeenCalled()
    expect(matchBackend.play).not.toHaveBeenCalled()
    await expect(runArenaExperiment(options)).rejects.toThrow('Unresolved')
    expect(backend.complete).toHaveBeenCalledTimes(1)
  },
  30000,
)

it('records failed search and audit episodes with truthful execution traces and keeps their zeros in the denominator', async () => {
  const root = await directory(),
    backend = model('not JSON'),
    matchBackend = matches()
  const plan = comparisonPlan(protocol, 'fixture', 1, [31, 47])
  const options = {
    root,
    initial,
    protocol,
    epochs: 1,
    durationMs: 120000,
    model: backend,
    matches: matchBackend,
    auditSeeds: [31, 47],
    limitsPerArm: plan.per_arm,
    limitsPerAudit: plan.per_audit,
  }
  const result = await runArenaComparison(options)
  expect(result).toMatchObject({
    status: 'completed',
    protocol_version: 3,
    same_harness: true,
    same_improver: true,
    evidence_kind: 'fixture-model-fixture-matches',
    amendment: null,
    paired_C_minus_B: 0,
    metric_scope: { invalid_lookahead: 'zero_score_task_failure', inference: 'descriptive_only' },
    difference_attribution: 'same_harness_difference_cannot_be_attributed_to_evolved_I',
  })
  for (const audit of result.audits) {
    expect(audit.result.mean_score).toBe(0)
    expect(audit.result.task_failures).toBe(2)
    expect(audit.result.episodes).toHaveLength(2)
    expect(
      audit.result.episodes.every((episode) => episode.status === 'task_failed' && episode.score === 0),
    ).toBe(true)
  }
  expect(result.budget.unknown).toEqual([])
  expect(result.budget.observed.matches).toBe(0)
  expect(matchBackend.compile).not.toHaveBeenCalled()
  expect(matchBackend.play).not.toHaveBeenCalled()
  const operationRoot = join(
    root,
    'B/search/epochs/000/.gear/runs',
    result.arms[0]!.epochs[0]!.run_id,
    'arena-operations',
  )
  let found = false
  for (const entry of await readdir(operationRoot)) {
    const files = await readdir(join(operationRoot, entry))
    if (!files.includes('dev-0.json')) continue
    const trace = JSON.parse(await readFile(join(operationRoot, entry, 'dev-0.json'), 'utf8'))
    expect(trace).toMatchObject({
      status: 'task_failed',
      executed_improver: digest(initial.improver),
      executed_executor: null,
      policy: null,
      policy_digest: null,
      discarded_probe_improver: null,
      execution: { executor: { status: 'not_executed', instruction_digest: null } },
    })
    found = true
  }
  expect(found).toBe(true)
  const calls = backend.complete.mock.calls.length
  expect(await runArenaComparison(options)).toEqual(result)
  expect(backend.complete).toHaveBeenCalledTimes(calls)
}, 60000)

it('does not drop a failed audit episode when another episode succeeds', async () => {
  const backend = model('not JSON'),
    matchBackend = matches()
  let lookaheads = 0
  backend.complete.mockImplementation(async (request) => ({
    output:
      request.phase === 'lookahead'
        ? ++lookaheads === 1
          ? 'not JSON'
          : JSON.stringify(initial)
        : JSON.stringify({ policy: 'P1' }),
    usage: { model_requests: 0, tokens: 0 },
  }))
  const result = await frozenEvaluation({
    root: await directory(),
    target: initial,
    protocol,
    seeds: [31, 47],
    limits: comparisonPlan(protocol, 'fixture', 1, [31, 47]).per_audit,
    model: backend,
    matches: matchBackend,
    durationMs: 60000,
  })
  expect(result.episodes.map((episode) => episode.score)).toEqual([0, 0.5])
  expect(result.mean_score).toBe(0.25)
  expect(result.task_failures).toBe(1)
})
