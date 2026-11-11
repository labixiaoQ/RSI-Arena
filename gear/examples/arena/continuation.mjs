// Narrow repair path: before the first scored game only. Never reset old usage.
import { DatabaseSync } from 'node:sqlite'
import { readFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { digest } from '../../lib/adapters/arena/contracts.js'
import { zero, dimensions } from '../../lib/adapters/arena/budget.js'
import { publishFile } from '../../lib/adapters/storage/atomic.js'
import { withFileLock } from '../../lib/adapters/storage/file-lock.js'
const implementation = digest(await readFile(new URL(import.meta.url), 'utf8'))

function rows(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT * FROM operations ORDER BY rowid').all()
  } finally {
    db.close()
  }
}

export class ConfirmedPrefixModel {
  kind = 'live'
  constructor(inner, records, consumed = 0) {
    this.inner = inner
    this.records = records
    this.position = consumed
    this.identity = digest({
      type: 'confirmed-prefix-once-v1',
      implementation,
      inner: inner.identity,
      records,
    })
    if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > records.length)
      throw new Error('Invalid replay position')
  }
  check(request) {
    const record = this.records[this.position]
    if (!record) return null
    const identity = digest({
      request: { request, model: this.inner.identity },
      reserved: { ...zero(), agent_calls: 1, ...this.inner.allowance(request) },
    })
    if (identity !== record.request)
      throw new Error('Confirmed prefix input mismatch; no new model call allowed')
    return record
  }
  allowance(request) {
    return this.check(request) ? { model_requests: 0, tokens: 0 } : this.inner.allowance(request)
  }
  async complete(request, signal) {
    signal.throwIfAborted()
    const record = this.check(request)
    if (!record) return this.inner.complete(request, signal)
    this.position++
    return { ...record.reply, usage: { model_requests: 0, tokens: 0 }, replayed_from: record.id }
  }
}

export async function prepareContinuation(source, root, inner, caps, initial, protocol) {
  source = resolve(source)
  root = resolve(root)
  if (source === root) throw new Error('Repair requires a new experiment directory')
  const prior = JSON.parse(await readFile(join(source, 'report.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(source, 'experiment.json'), 'utf8'))
  const oldRows = rows(join(source, 'budget.sqlite'))
  const unknown = oldRows.filter((row) => row.state !== 'complete')
  if (
    prior.status !== 'needs_recovery' ||
    prior.epochs.length ||
    manifest.model_kind !== 'live' ||
    prior.budget.observed.matches !== 0 ||
    prior.budget.observed.episodes !== 1 ||
    !unknown.length ||
    unknown.some((row) => JSON.parse(row.reserved).matches !== 1) ||
    digest(initial) !== digest(manifest.initial) ||
    digest(protocol) !== digest(manifest.protocol)
  )
    throw new Error(
      'Continuation only supports a terminated pre-game infrastructure failure with unchanged prompts/protocol',
    )
  const records = oldRows
    .filter((row) => row.state === 'complete' && JSON.parse(row.actual).model_requests === 1)
    .map((row) => ({ id: row.id, request: row.request, reply: JSON.parse(row.result) }))
  if (records.length !== 2) throw new Error('Expected exactly two confirmed initial model replies')
  const limits = Object.fromEntries(
    dimensions.map((key) => {
      if (
        !Number.isSafeInteger(caps[key]) ||
        caps[key] > manifest.limits[key] ||
        caps[key] < prior.budget.charged[key]
      )
        throw new Error(`Invalid total ${key} authorization cap`)
      return [key, caps[key] - prior.budget.charged[key]]
    }),
  )
  const identity = {
    source,
    target: root,
    source_identity: manifest.identity,
    source_budget: prior.budget,
    total_caps: caps,
    remaining_caps: limits,
    inner_model: inner.identity,
    replay_digest: digest(records),
  }
  await mkdir(root, { recursive: true })
  await withFileLock(join(source, 'continuation.owner'), async () => {
    await publishFile(join(source, 'continuation-target.json'), JSON.stringify(identity), { immutable: true })
    await publishFile(join(root, 'continuation.json'), JSON.stringify(identity, null, 2), { immutable: true })
  })
  let consumed = 0
  try {
    const replayed = rows(join(root, 'budget.sqlite'))
      .filter((row) => row.state === 'complete')
      .map((row) => JSON.parse(row.result).replayed_from)
      .filter(Boolean)
    if (replayed.some((id, i) => id !== records[i]?.id)) throw new Error('Invalid replay evidence')
    consumed = replayed.length
  } catch (error) {
    // A new run has no ledger yet; every other SQLite error must fail closed.
    const { stat } = await import('node:fs/promises')
    try {
      await stat(join(root, 'budget.sqlite'))
      throw error
    } catch (missing) {
      if (missing.code !== 'ENOENT') throw missing
    }
  }
  return {
    limits,
    model: new ConfirmedPrefixModel(inner, records, consumed),
    async writeSummary() {
      const current = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))
      const charged = Object.fromEntries(
        dimensions.map((key) => [key, prior.budget.charged[key] + current.budget.charged[key]]),
      )
      const observed = Object.fromEntries(
        dimensions.map((key) => [key, prior.budget.observed[key] + current.budget.observed[key]]),
      )
      if (dimensions.some((key) => charged[key] > caps[key]))
        throw new Error('Combined authorization budget exceeded')
      await publishFile(
        join(root, 'authorization-budget.json'),
        JSON.stringify(
          {
            total_caps: caps,
            charged,
            observed,
            retired_unconfirmed: prior.budget.unknown,
            current_unconfirmed: current.budget.unknown,
            source,
            current: root,
          },
          null,
          2,
        ),
      )
    },
  }
}
