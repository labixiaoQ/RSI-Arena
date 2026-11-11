import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runArenaExperiment } from '../../src/adapters/arena/coordinator.js'
import { ArenaBudget, BudgetError, UnknownOperation, zero } from '../../src/adapters/arena/budget.js'
import { ArenaHarnessAdapter } from '../../src/adapters/arena/harness.js'
import { ArenaProvider } from '../../src/adapters/arena/provider.js'
import {
  digest,
  type AgentRequest,
  type ArenaProtocol,
  type HarnessBundle,
  type MatchBackend,
  type ModelBackend,
} from '../../src/adapters/arena/contracts.js'

const roots: string[] = []
beforeEach(() =>
  vi.stubEnv('GEAR_PYTHON', process.env.GEAR_TRAINING_TEST_PYTHON ?? join(process.cwd(), '.venv/bin/python')),
)
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'gear-arena-'))
  roots.push(root)
  return root
}
const initial: HarnessBundle = {
  executor: { version: 1, instruction: 'E0' },
  improver: { version: 1, instruction: 'I0' },
}
const limits = { agent_calls: 100, model_requests: 0, tokens: 0, episodes: 100, matches: 100 }
const protocol: ArenaProtocol = {
  version: 1,
  mode: 'recursive',
  lookaheadDepth: 1,
  initialPolicy: 'P0',
  sdk: 'fixture SDK',
  opponents: ['fixture opponent'],
  rounds: 20,
  tasks: [
    { id: 'seed', family: 'seed-family', split: 'seed', seed: 7 },
    { id: 'holdout', family: 'holdout-family', split: 'held_out', seed: 23 },
  ],
}
class TestModel implements ModelBackend {
  kind = 'fixture' as const
  identity = digest('controlled-test-model-v1')
  calls: AgentRequest[] = []
  allowance() {
    return { model_requests: 0, tokens: 0 }
  }
  async complete(request: AgentRequest) {
    this.calls.push(request)
    const input = JSON.parse(request.input),
      parent = input.harness as HarnessBundle
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
        // An instruction that must never become a second forward call or active Meta.
        improver: { version: 1, instruction: 'I999' },
      }
    else result = { policy: `P${request.system.slice(1)}` }
    return { output: JSON.stringify(result), usage: { model_requests: 0, tokens: 0 } }
  }
}
class TestMatches implements MatchBackend {
  kind = 'fixture' as const
  identity = digest('controlled-test-game-v1')
  calls = 0
  async play(request: { policy: string }) {
    this.calls++
    return {
      status: 'complete' as const,
      score: Number(request.policy.slice(1)) / 10,
      replay: null,
      details: { fixture: true },
    }
  }
}
async function experiment(epochs = 3) {
  return {
    root: await directory(),
    initial,
    protocol,
    limits,
    epochs,
    durationMs: 120_000,
    model: new TestModel(),
    matches: new TestMatches(),
  }
}
async function traces(root: string): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = []
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name)
      if (entry.isDirectory()) await walk(next)
      else if (/^(seed|holdout)-0\.json$/u.test(entry.name))
        result.push(JSON.parse(await readFile(next, 'utf8')))
    }
  }
  await walk(root)
  return result
}

it('uses Gear promotion/export and actually inherits I across three epochs', async () => {
  const options = await experiment()
  const report = await runArenaExperiment(options)
  expect(report.epochs).toHaveLength(3)
  expect(report.epochs.every((epoch) => epoch.gate === 'accepted')).toBe(true)
  expect(options.model.calls.filter((call) => call.phase === 'propose').map((call) => call.system)).toEqual([
    'I0',
    'I1',
    'I2',
  ])
  expect(report.epochs.map((epoch) => epoch.retained_improver)).toEqual(
    [1, 2, 3].map((n) => digest({ version: 1, instruction: `I${n}` })),
  )
  expect(report.budget.observed).toEqual({
    agent_calls: 27,
    model_requests: 0,
    tokens: 0,
    episodes: 12,
    matches: 24,
  })
  expect(report.budget.unknown).toEqual([])
  expect(options.matches.calls).toBe(24)
  const saved = await traces(options.root)
  expect(saved).toHaveLength(12)
  expect(saved.every((trace) => trace.lookahead_depth === 1)).toBe(true)
  expect(options.model.calls.some((call) => call.system === 'I999')).toBe(false)
}, 60_000)

it('distinguishes I-only changes through offspring behavior with unchanged candidate E', async () => {
  const options = await experiment(1)
  const report = await runArenaExperiment(options)
  const target = JSON.parse(await readFile(join(report.epochs[0]!.exported_target, 'executor.json'), 'utf8'))
  expect(target).toEqual(initial.executor)
  const saved = (await traces(options.root)).filter((trace) => trace.partition === 'seed')
  expect(saved.map((trace) => trace.score).sort()).toEqual([0, 0.1])
  expect(new Set(saved.map((trace) => trace.executed_improver)).size).toBe(2)
}, 30_000)

it('locks I in the B baseline and carries no held-out feedback into proposals', async () => {
  const options = await experiment(2)
  options.protocol = { ...protocol, mode: 'fixed-improver' }
  const report = await runArenaExperiment(options)
  expect(report.epochs.every((epoch) => epoch.retained_improver === digest(initial.improver))).toBe(true)
  for (const call of options.model.calls.filter((entry) => entry.phase === 'propose')) {
    const input = JSON.parse(call.input)
    expect([...input.feedback, ...input.memory].every((row: { task: string }) => row.task === 'seed')).toBe(
      true,
    )
  }
}, 30_000)

it('resuming a completed experiment makes no new agent or game calls', async () => {
  const options = await experiment(1)
  const first = await runArenaExperiment(options)
  const calls = options.model.calls.length
  expect(await runArenaExperiment(options)).toEqual(first)
  expect(options.model.calls).toHaveLength(calls)
  expect(options.matches.calls).toBe(8)
  await expect(runArenaExperiment({ ...options, limits: { ...limits, matches: 101 } })).rejects.toThrow(
    'inputs changed',
  )
}, 30_000)

it('enforces a shared agent budget inside a forward evaluation and across epochs', async () => {
  const options = await experiment(3)
  options.limits = { ...limits, agent_calls: 10 }
  await expect(runArenaExperiment(options)).rejects.toThrow('agent_calls budget exhausted')
  expect(options.model.calls).toHaveLength(10)
  const report = JSON.parse(await readFile(join(options.root, 'report.json'), 'utf8'))
  expect(report.budget.charged.agent_calls).toBe(10)
  expect(report.epochs).toHaveLength(1)
}, 30_000)

it('enforces a global match cap before dispatch and never treats the missing game as a loss', async () => {
  const options = await experiment(1)
  options.limits = { ...limits, matches: 1 }
  await expect(runArenaExperiment(options)).rejects.toThrow('matches budget exhausted')
  expect(options.matches.calls).toBe(1)
  expect(await traces(options.root)).toEqual([])
}, 30_000)

it('rejects deeper evaluation and task-family leakage before any work', async () => {
  const options = await experiment(1)
  await expect(
    runArenaExperiment({ ...options, protocol: { ...protocol, lookaheadDepth: 2 as 1 } }),
  ).rejects.toThrow('Invalid Arena protocol')
  await expect(
    runArenaExperiment({
      ...options,
      protocol: { ...protocol, tasks: protocol.tasks.map((task) => ({ ...task, family: 'same' })) },
    }),
  ).rejects.toThrow('families')
  expect(options.model.calls).toHaveLength(0)
})

it('persists unresolved external work and refuses replay or budget reset after restart', async () => {
  const root = await directory(),
    path = join(root, 'budget.sqlite'),
    deadline = Date.now() + 10_000
  const budget = new ArenaBudget(path, limits, deadline)
  let calls = 0
  await expect(
    budget.execute('call', {}, { agent_calls: 1 }, async () => {
      calls++
      throw new Error('lost reply')
    }),
  ).rejects.toThrow('lost reply')
  budget.close()
  const recovered = new ArenaBudget(path, limits, deadline)
  await expect(
    recovered.execute('call', {}, { agent_calls: 1 }, async () => {
      calls++
      return { value: 1 }
    }),
  ).rejects.toBeInstanceOf(UnknownOperation)
  expect(recovered.summary().charged.agent_calls).toBe(1)
  expect(calls).toBe(1)
  recovered.close()
  expect(() => new ArenaBudget(path, limits, deadline + 1)).toThrow('cannot change')
})

it('reuses a confirmed receipt, rejects ID conflicts and retains invalid usage reservations', async () => {
  const root = await directory(),
    budget = new ArenaBudget(join(root, 'budget.sqlite'), limits, Date.now() + 10_000)
  let calls = 0
  const action = async () => {
    calls++
    return { value: { ok: true } }
  }
  expect(await budget.execute('x', {}, { agent_calls: 1 }, action)).toEqual({ ok: true })
  await budget.execute('x', {}, { agent_calls: 1 }, action)
  expect(calls).toBe(1)
  await expect(budget.execute('x', { changed: true }, { agent_calls: 1 }, action)).rejects.toThrow(
    'different inputs',
  )
  await expect(
    budget.execute('bad', {}, { agent_calls: 1 }, async () => ({ value: 1, actual: { agent_calls: 2 } })),
  ).rejects.toBeInstanceOf(BudgetError)
  expect(budget.summary().unknown).toEqual(['bad'])
  budget.close()
})

it('rejects requests after the persisted deadline before executing the callback', async () => {
  const budget = new ArenaBudget(join(await directory(), 'budget.sqlite'), limits, Date.now() - 1)
  const action = vi.fn(async () => ({ value: true }))
  await expect(budget.execute('late', {}, zero(), action)).rejects.toThrow('deadline')
  expect(action).not.toHaveBeenCalled()
  budget.close()
})

it('rejects unsupported MoneCraft round limits before model calls', async () => {
  const options = await experiment(1)
  await expect(
    runArenaExperiment({
      ...options,
      matches: {
        kind: 'monecraft',
        identity: 'actual-game-test',
        play: async () => {
          throw new Error('must not dispatch')
        },
      },
    }),
  ).rejects.toThrow('exactly 1000 rounds')
  expect(options.model.calls).toHaveLength(0)
})

it('validates the narrow target resource boundary', async () => {
  const root = await directory(),
    adapter = new ArenaHarnessAdapter()
  await adapter.prepare(root)
  await expect(adapter.check(root)).resolves.toBeUndefined()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'judge.py'), 'tamper')
  await expect(adapter.check(root)).rejects.toThrow('exactly')
})

it('recovers a lost Gear acknowledgment from durable provider evidence without repeating work', async () => {
  const options = await experiment(1)
  const original = ArenaProvider.prototype.submit
  vi.spyOn(ArenaProvider.prototype, 'submit').mockImplementationOnce(async function (
    this: ArenaProvider,
    request,
    signal,
  ) {
    await original.call(this, request, signal)
    throw new Error('lost acknowledgment after receipt commit')
  })
  await expect(runArenaExperiment(options)).rejects.toThrow('lost acknowledgment')
  const report = await runArenaExperiment(options)
  expect(report.status).toBe('completed')
  expect(report.budget.observed.agent_calls).toBe(9)
  expect(options.model.calls).toHaveLength(9)
  expect(options.matches.calls).toBe(8)
}, 30_000)

it('reserves model tokens before a nested call and settles measured usage', async () => {
  const root = await directory()
  const budget = new ArenaBudget(
    join(root, 'budget.sqlite'),
    { ...limits, model_requests: 10, tokens: 5 },
    Date.now() + 10_000,
  )
  const call = vi.fn(async () => ({ value: 'ok', actual: { tokens: 2 } }))
  await budget.execute('model-1', {}, { model_requests: 1, tokens: 3 }, call)
  await budget.execute('model-2', {}, { model_requests: 1, tokens: 3 }, call)
  await expect(budget.execute('model-3', {}, { model_requests: 1, tokens: 3 }, call)).rejects.toThrow(
    'tokens budget exhausted',
  )
  expect(call).toHaveBeenCalledTimes(2)
  expect(budget.summary().observed.tokens).toBe(4)
  budget.close()
})
