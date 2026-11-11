// Controlled plumbing validation. No LLM calls and no claimed autonomous improvement.
import { createHash } from 'node:crypto'
export class FixtureModel {
  kind = 'fixture'
  constructor(policies) {
    this.policies = policies
    this.identity =
      'sha256:' +
      createHash('sha256')
        .update(JSON.stringify({ fixture: 1, policies }))
        .digest('hex')
  }
  allowance() {
    return { model_requests: 0, tokens: 0 }
  }
  async complete(request) {
    const input = JSON.parse(request.input)
    const match = request.system.match(/fixture-stage:(\d+)/u)
    if (!match) throw new Error('Fixture model accepts only explicitly marked fixture instructions')
    const stage = Number(match[1])
    let output
    if (request.phase === 'propose') {
      output = {
        ...input.harness,
        improver: {
          version: 1,
          instruction: `fixture-stage:${input.mode === 'fixed-improver' ? stage : Math.min(stage + 1, this.policies.length - 1)}`,
        },
      }
    } else if (request.phase === 'lookahead') {
      output = { ...input.harness, executor: { version: 1, instruction: `fixture-stage:${stage}` } }
    } else output = { policy: this.policies[stage] }
    return { output: JSON.stringify(output), usage: { model_requests: 0, tokens: 0 } }
  }
}
