import { DatabaseSync } from 'node:sqlite'
import { digest } from './contracts.js'

export const dimensions = ['agent_calls', 'model_requests', 'tokens', 'episodes', 'matches'] as const
export type Dimension = (typeof dimensions)[number]
export type Counts = Record<Dimension, number>
export type Allowance = Partial<Counts>
export const zero = (): Counts => ({ agent_calls: 0, model_requests: 0, tokens: 0, episodes: 0, matches: 0 })
export class BudgetError extends Error {}
export class UnknownOperation extends Error {}

/** One experiment-wide ledger, including every Gear epoch and nested evaluation. */
export class ArenaBudget {
  private readonly db: DatabaseSync
  constructor(
    path: string,
    readonly limits: Counts,
    readonly deadline: number,
  ) {
    for (const key of dimensions)
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new Error(`Invalid ${key} limit`)
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('Invalid deadline')
    this.db = new DatabaseSync(path)
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL, reserved TEXT NOT NULL, actual TEXT, result TEXT);',
    )
    const identity = digest({ limits, deadline })
    const existing = this.db.prepare('SELECT digest FROM config WHERE id=1').get()
    if (existing && existing.digest !== identity) {
      this.db.close()
      throw new Error('Budget cannot change on resume')
    }
    this.db.prepare('INSERT OR IGNORE INTO config VALUES (1, ?)').run(identity)
  }
  close() {
    this.db.close()
  }
  summary(prefix = '') {
    const charged = zero(),
      observed = zero(),
      unknown: string[] = []
    for (const row of this.db.prepare('SELECT * FROM operations').all()) {
      if (!String(row.id).startsWith(prefix)) continue
      const reservation = JSON.parse(String(row.reserved)) as Counts
      const actual = row.actual === null ? null : (JSON.parse(String(row.actual)) as Counts)
      for (const key of dimensions) {
        charged[key] += actual?.[key] ?? reservation[key]
        observed[key] += actual?.[key] ?? 0
      }
      if (row.state !== 'complete') unknown.push(String(row.id))
    }
    return { limits: this.limits, charged, observed, unknown, deadline: this.deadline }
  }
  hasUnknown(prefix: string): boolean {
    return this.db
      .prepare("SELECT id FROM operations WHERE state != 'complete'")
      .all()
      .some((row) => String(row.id).startsWith(prefix))
  }
  /** Called under experiment.owner before a generation starts, or resumes. */
  ensureAvailable(allowance: Allowance) {
    if (Date.now() >= this.deadline) throw new BudgetError('Experiment deadline exhausted')
    const current = this.summary()
    if (current.unknown.length) throw new UnknownOperation('Unresolved work retains its allowance')
    for (const key of dimensions) {
      const required = allowance[key] ?? 0
      if (!Number.isSafeInteger(required) || required < 0) throw new Error(`Invalid ${key} admission`)
      if (current.charged[key] + required > this.limits[key])
        throw new BudgetError(`Insufficient ${key} for a complete generation`)
    }
  }
  /** An absent receipt after submission is ambiguous. Never turn it into a free retry. */
  async execute<T>(
    id: string,
    request: unknown,
    allowance: Allowance,
    action: () => Promise<{ value: T; actual?: Allowance }>,
  ): Promise<T> {
    const reserved = { ...zero(), ...allowance }
    for (const key of dimensions)
      if (!Number.isSafeInteger(reserved[key]) || reserved[key] < 0)
        throw new Error(`Invalid ${key} reservation`)
    const identity = digest({ request, reserved })
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id)
      if (prior) {
        if (prior.request !== identity) throw new Error('Operation ID reused with different inputs')
        if (prior.state !== 'complete') throw new UnknownOperation(`Unresolved execution: ${id}`)
        this.db.exec('COMMIT')
        return JSON.parse(String(prior.result)) as T
      }
      if (Date.now() >= this.deadline) throw new BudgetError('Experiment deadline exhausted')
      const summary = this.summary()
      if (summary.unknown.length) throw new UnknownOperation('Unresolved work retains its allowance')
      for (const key of dimensions)
        if (summary.charged[key] + reserved[key] > this.limits[key])
          throw new BudgetError(`Experiment ${key} budget exhausted`)
      this.db
        .prepare('INSERT INTO operations VALUES (?, ?, ?, ?, NULL, NULL)')
        .run(id, identity, 'submitted', JSON.stringify(reserved))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    // Errors deliberately retain the full reservation. The external side effect may have happened.
    const { value, actual: measurements } = await action()
    const actual = { ...reserved, ...measurements }
    for (const key of dimensions)
      if (!Number.isSafeInteger(actual[key]) || actual[key] < 0 || actual[key] > reserved[key])
        throw new BudgetError(`Provider exceeded or misreported ${key}; reservation retained`)
    this.db
      .prepare("UPDATE operations SET state='complete', actual=?, result=? WHERE id=?")
      .run(JSON.stringify(actual), JSON.stringify(value), id)
    return value
  }
}
