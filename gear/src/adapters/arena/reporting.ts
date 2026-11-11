import type { ArenaProtocol, MatchBackend, ModelBackend } from './contracts.js'

/** Descriptive evidence labels, not a claim that an experiment demonstrated RSI gains. */
export function publicResultMetadata(
  protocol: ArenaProtocol,
  modelKind: ModelBackend['kind'],
  matchKind: MatchBackend['kind'],
) {
  return {
    protocol_version: protocol.version,
    evidence_kind: `${modelKind}-model-${matchKind}-matches`,
    amendment: null,
    metric_scope: {
      metric: 'episode_score',
      completed_episode: 'mean paired game score: win=1, draw=0.5, loss=0',
      invalid_lookahead: protocol.version === 3 ? 'zero_score_task_failure' : 'terminates_run',
      population: 'configured seeds and fixed opponent pool',
      formal_hidden_benchmark: false,
      inference: 'descriptive_only',
    },
  }
}
