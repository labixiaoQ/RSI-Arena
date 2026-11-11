#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { config } from './config.mjs';
import { preflight } from './execute.mjs';
import { Runner } from './worker.mjs';
import { RunnerClient } from './client.mjs';

const { values } = parseArgs({ options: { 'check-connection': { type: 'boolean' }, once: { type: 'boolean' }, poll: { type: 'boolean' }, preflight: { type: 'boolean' }, plan: { type: 'boolean' } }, strict: true });
if (Object.values(values).filter(Boolean).length !== 1) {
  console.error('Choose exactly one: --check-connection, --preflight, --plan, --once, or --poll. Default live execution is disabled.');
  process.exitCode = 2;
} else {
  const settings = config();
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error('Operator stopped runner'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    if (values['check-connection']) console.log(JSON.stringify(await new RunnerClient(settings).checkConnection(stop.signal)));
    else if (values.plan || values.preflight) console.log(JSON.stringify(await preflight(settings), null, 2));
    else {
      const runner = new Runner(settings);
      if (values.once) console.log(JSON.stringify(await runner.runOnce(stop.signal)));
      else await runner.poll(stop.signal);
    }
  } catch {
    // Detailed private checkpoints are retained locally; CLI never echoes headers, credentials or arbitrary provider errors.
    console.error('Runner stopped. Check local configuration, build, and private checkpoint. No automatic recovery was attempted.');
    process.exitCode = 1;
  }
}
