import type { AlgorithmDriver } from '../../domain/run.js'
import type { Operation } from '../../domain/algorithm-wire.js'

/** Trusted, fixed one-candidate schedule. All adaptive instructions belong to the sealed I. */
export const linearDriver: AlgorithmDriver = {
  async step(view, state) {
    const stage = Number(state.data.stage ?? 0)
    const tasks = view.tasks.map((task) => task.id)
    const common = {
      parent_id: null,
      task_ids: [],
      scope: 'global',
      rationale: 'Arena linear one-step protocol',
      payload: null,
    }
    if (view.completed.some((entry) => entry.kind === 'generate_candidate' && entry.status === 'failed'))
      return {
        state: { version: 1, data: { stage: stage + 1 } },
        operations: [{ ...common, kind: 'stop', candidate_id: null }],
        reason: 'Invalid proposal: retain the sealed parent without retry or candidate evaluation',
      }
    const operations: Operation[] = [
      { ...common, kind: 'evaluate_seed', candidate_id: view.anchor_id, task_ids: tasks },
      {
        ...common,
        kind: 'generate_candidate',
        candidate_id: 'child',
        parent_id: view.anchor_id,
        task_ids: tasks,
      },
      { ...common, kind: 'evaluate_seed', candidate_id: 'child', task_ids: tasks },
      { ...common, kind: 'nominate', candidate_id: 'child' },
    ]
    if (!operations[stage]) throw new Error('Linear schedule exhausted')
    return {
      state: { version: 1, data: { stage: stage + 1 } },
      operations: [operations[stage]],
      reason: common.rationale,
    }
  },
}
