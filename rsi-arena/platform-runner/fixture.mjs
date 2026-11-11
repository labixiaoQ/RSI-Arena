import { digest } from './core.mjs';

const stage = (text) => Number(text.match(/controlled-generation:(\d+)/u)?.[1] || 0);
export function fixtureBackends() {
  return {
    model: {
      kind: 'fixture', identity: digest({ fixtureModel: 1 }),
      allowance: () => ({ model_requests: 0, tokens: 0 }),
      async complete(request, signal) {
        signal.throwIfAborted();
        const input = JSON.parse(request.input), parent = input.harness;
        let output;
        if (request.phase === 'propose') output = { ...parent, improver: input.mode === 'fixed-improver' ? parent.improver : { version: 1, instruction: `Controlled fixture only; controlled-generation:${stage(parent.improver.instruction) + 1}` } };
        else if (request.phase === 'lookahead') output = { ...parent, executor: { version: 1, instruction: `Controlled fixture only; controlled-generation:${stage(request.system)}` }, improver: { version: 1, instruction: 'Discard this temporary fixture improver' } };
        else output = { policy: `controlled-policy-${stage(request.system)}` };
        return { output: JSON.stringify(output), usage: { model_requests: 0, tokens: 0 } };
      },
    },
    matches: {
      kind: 'fixture', identity: digest({ fixtureMatches: 1 }),
      async compile(_request, signal) { signal.throwIfAborted(); return { status: 'ready', diagnostics: 'Controlled fixture: no C++ compiler or game was invoked.' }; },
      async play(request, signal) {
        signal.throwIfAborted();
        const score = Math.min(1, Number(request.policy.match(/controlled-policy-(\d+)/u)?.[1] || 0) / 10);
        return { status: 'complete', score, replay: null, details: { controlled: true, own_behavior: { unique_positions: 1, final_gold: 0, final_mines: 0 } } };
      },
    },
  };
}
