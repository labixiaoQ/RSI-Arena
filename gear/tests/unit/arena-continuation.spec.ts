import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { ArenaBudget } from '../../src/adapters/arena/budget.js'
import { digest } from '../../src/adapters/arena/contracts.js'

const modulePath = pathToFileURL(resolve('examples/arena/continuation.mjs')).href
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const caps = { agent_calls: 20, model_requests: 20, tokens: 100, episodes: 20, matches: 40 }
const requests = [
  { phase: 'lookahead', system: 'I0', input: 'harness' },
  { phase: 'learn', system: 'E1', input: 'SDK' },
]
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arena-continuation-'))
  roots.push(root)
  const source = join(root, 'old'),
    target = join(root, 'new')
  await mkdir(source)
  const inner = {
    identity: digest('test-live-model'),
    kind: 'live',
    allowance: () => ({ model_requests: 1, tokens: 10 }),
    complete: vi.fn(async () => ({ output: '{}', usage: { model_requests: 1, tokens: 5 } })),
  }
  const budget = new ArenaBudget(join(source, 'budget.sqlite'), caps, Date.now() + 100000)
  await budget.execute('episode', {}, { episodes: 1 }, async () => ({ value: true }))
  for (let n = 0; n < 2; n++)
    await budget.execute(
      `model-${n}`,
      { request: requests[n], model: inner.identity },
      { agent_calls: 1, ...inner.allowance() },
      async () => ({
        value: { output: `{"index":${n}}`, usage: { model_requests: 1, tokens: 5 } },
        actual: { tokens: 5 },
      }),
    )
  await expect(
    budget.execute('failed-match', {}, { matches: 1 }, async () => {
      throw new Error('terminated')
    }),
  ).rejects.toThrow()
  await writeFile(
    join(source, 'report.json'),
    JSON.stringify({ status: 'needs_recovery', epochs: [], budget: budget.summary() }),
  )
  const initial = { name: 'initial' },
    protocol = { name: 'protocol' }
  await writeFile(
    join(source, 'experiment.json'),
    JSON.stringify({ identity: 'old-identity', model_kind: 'live', initial, protocol, limits: caps }),
  )
  budget.close()
  return { root, source, target, inner, initial, protocol }
}

it('subtracts all previous charges and consumes each confirmed model reply only once', async () => {
  const { prepareContinuation } = await import(modulePath)
  const f = await fixture()
  const continuation = await prepareContinuation(f.source, f.target, f.inner, caps, f.initial, f.protocol)
  expect(continuation.limits).toEqual({
    agent_calls: 18,
    model_requests: 18,
    tokens: 90,
    episodes: 19,
    matches: 39,
  })
  for (let n = 0; n < 2; n++) {
    expect(continuation.model.allowance(requests[n])).toEqual({ model_requests: 0, tokens: 0 })
    const reply = await continuation.model.complete(requests[n], new AbortController().signal)
    expect(reply.replayed_from).toBe(`model-${n}`)
    expect(reply.usage.tokens).toBe(0)
  }
  await continuation.model.complete(requests[0], new AbortController().signal)
  expect(f.inner.complete).toHaveBeenCalledTimes(1)
})

it('refuses changed prompts, protocol and a second continuation destination', async () => {
  const { prepareContinuation } = await import(modulePath)
  const f = await fixture()
  await expect(
    prepareContinuation(f.source, f.target, f.inner, caps, f.initial, { changed: true }),
  ).rejects.toThrow('unchanged')
  const continuation = await prepareContinuation(f.source, f.target, f.inner, caps, f.initial, f.protocol)
  expect(() => continuation.model.allowance({ ...requests[0], system: 'changed' })).toThrow('input mismatch')
  expect(f.inner.complete).not.toHaveBeenCalled()
  await expect(
    prepareContinuation(f.source, join(f.root, 'another'), f.inner, caps, f.initial, f.protocol),
  ).rejects.toThrow()
})

it('restores consumed replay position from durable receipts after restart', async () => {
  const { prepareContinuation } = await import(modulePath)
  const f = await fixture()
  const first = await prepareContinuation(f.source, f.target, f.inner, caps, f.initial, f.protocol)
  const budget = new ArenaBudget(join(f.target, 'budget.sqlite'), first.limits, Date.now() + 100000)
  await budget.execute('replay-0', requests[0], { agent_calls: 1 }, async () => ({
    value: await first.model.complete(requests[0], new AbortController().signal),
  }))
  budget.close()
  const resumed = await prepareContinuation(f.source, f.target, f.inner, caps, f.initial, f.protocol)
  expect((await resumed.model.complete(requests[1], new AbortController().signal)).replayed_from).toBe(
    'model-1',
  )
  expect(f.inner.complete).not.toHaveBeenCalled()
})

it('does not replay an unresolved model request or increase an authorization cap', async () => {
  const { prepareContinuation } = await import(modulePath)
  const f = await fixture()
  await expect(
    prepareContinuation(f.source, f.target, f.inner, { ...caps, tokens: 101 }, f.initial, f.protocol),
  ).rejects.toThrow('authorization cap')
  const db = new DatabaseSync(join(f.source, 'budget.sqlite'))
  db.prepare("UPDATE operations SET state='submitted' WHERE id='model-1'").run()
  db.close()
  await expect(prepareContinuation(f.source, f.target, f.inner, caps, f.initial, f.protocol)).rejects.toThrow(
    'pre-game',
  )
})
