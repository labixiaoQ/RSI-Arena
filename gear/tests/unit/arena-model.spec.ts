import { afterEach, expect, it, vi } from 'vitest'
import { HttpModel } from '../../src/adapters/arena/model.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
const request = { phase: 'learn' as const, system: 'Return JSON', input: '{"sdk":"公开"}' }
const signal = new AbortController().signal

it('uses the configured DeepSeek interface and measured usage without exposing tools', async () => {
  vi.stubEnv('ARENA_TEST_KEY', 'local-test-placeholder')
  const fetch = vi.fn(async () =>
    Response.json({
      choices: [{ message: { content: '{"policy":"x"}' }, finish_reason: 'stop' }],
      usage: { total_tokens: 42 },
    }),
  )
  vi.stubGlobal('fetch', fetch)
  const model = new HttpModel(
    'https://api.deepseek.com/chat/completions',
    'deepseek-flash',
    'ARENA_TEST_KEY',
    100,
  )
  expect(model.allowance(request).tokens).toBeGreaterThan(100)
  expect(await model.complete(request, signal)).toEqual({
    output: '{"policy":"x"}',
    usage: { model_requests: 1, tokens: 42 },
  })
  const call = fetch.mock.calls[0] as unknown as [string, RequestInit]
  const body = JSON.parse(String(call[1].body))
  expect(body.model).toBe('deepseek-flash')
  expect(body.max_tokens).toBe(100)
  expect(body.thinking).toEqual({ type: 'disabled' })
  expect(body.response_format).toEqual({ type: 'json_object' })
  expect(body.tools).toBeUndefined()
})

it('never invents token usage when the provider omits it', async () => {
  vi.stubEnv('ARENA_TEST_KEY', 'local-test-placeholder')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ choices: [{ message: { content: '{}' } }] })),
  )
  const model = new HttpModel('https://api.deepseek.com/chat/completions', 'deepseek-flash', 'ARENA_TEST_KEY')
  await expect(model.complete(request, signal)).rejects.toThrow('measured token usage')
})

it('fails on absent credentials before attempting an external request', async () => {
  vi.stubEnv('ARENA_TEST_KEY', '')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const model = new HttpModel('https://api.deepseek.com/chat/completions', 'deepseek-flash', 'ARENA_TEST_KEY')
  await expect(model.complete(request, signal)).rejects.toThrow('Missing model credential')
  expect(fetch).not.toHaveBeenCalled()
})
