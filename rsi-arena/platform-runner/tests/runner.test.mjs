import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { config, IMAGE } from '../config.mjs';
import { digest, zero, emptyBudget, validateJob, claimWorkspace, atomicJson } from '../core.mjs';
import { Runner } from '../worker.mjs';
import { RunnerClient } from '../client.mjs';
import { executeJob, loadGear, preflight } from '../execute.mjs';
import { normalizeReplay, publicArtifacts } from '../publish.mjs';
import { validateArtifact } from '../../lib/artifact-validation.ts';
import { digest as cloudDigest } from '../../lib/platform-contract.ts';
import { sha256 } from '../core.mjs';

async function workspace(t) { const path = await mkdtemp(join(tmpdir(), 'arena-runner-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function makeJob(overrides = {}) {
  const initial = { executor: { version: 1, instruction: 'Improve the policy.' }, improver: { version: 1, instruction: 'Improve learning instructions.' } };
  const manifest = {
    schema_version: 1, job_id: 'run-test-job', submission_digest: digest(initial), protocol_id: 'arena-v3',
    model_profile_id: 'controlled-fixture', runner_profile_id: 'development-container-v1', epochs: 1,
    audit_seeds: [31, 47], duration_ms: 60000,
    caps: { agent_calls: 50, model_requests: 0, tokens: 0, episodes: 12, matches: 72 },
    evidence_kind: 'controlled', image_digest: IMAGE, ...overrides,
  };
  const manifestDigest = digest(manifest);
  return { id: manifest.job_id, manifest, manifestDigest, executor: initial.executor.instruction, improver: initial.improver.instruction, approval: { manifestDigest, caps: manifest.caps, approvedAt: new Date().toISOString() }, leaseId: 'lease-test-job', leaseEpoch: 1, leaseUntil: Date.now() + 90000 };
}
function stubClient(job, overrides = {}) {
  const calls = { failure: null, finalized: false, heartbeat: 0 };
  return {
    calls,
    claim: async () => ({ job }),
    heartbeat: async () => { calls.heartbeat++; return { leaseUntil: Date.now() + 90000, cancel: false }; },
    artifact: async (_job, kind, data) => ({ digest: sha256(JSON.stringify({ kind, data })) }),
    finalize: async () => { calls.finalized = true; },
    fail: async (_job, payload) => { calls.failure = payload; },
    ...overrides,
  };
}

test('manifest hashing agrees with cloud and approval binds exact instructions/caps', async () => {
  const job = makeJob();
  assert.equal(job.manifestDigest, await cloudDigest(job.manifest));
  assert.equal(validateJob(job).executor.instruction, job.executor);
  assert.throws(() => validateJob({ ...job, executor: 'modified' }), /Submission digest/);
  assert.throws(() => validateJob({ ...job, approval: null }), /approval/);
  assert.throws(() => validateJob(makeJob({ evidence_kind: 'live', model_profile_id: 'deepseek-flash' })), /disabled/);
  assert.throws(() => validateJob(makeJob({ endpoint: 'https://other.example' })), /Unsupported manifest/);
  assert.throws(() => config({ ARENA_SITE_URL: 'https://user:secret@example.com' }), /Site URL/);
  assert.throws(() => config({ ARENA_SITE_URL: 'http://remote.example' }), /Site URL/);
});

test('real Gear fixture completes HTTP claim, heartbeat, schema-valid artifact and finalization with zero provider calls', async (t) => {
  const root = await workspace(t), job = makeJob();
  let lastSeq = 0, experiment, final, claimed = false;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer test-runner-token');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString(), body = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/runner/claim') { assert.equal(claimed, false); claimed = true; assert.deepEqual(body.capabilities, ['arena-v3', 'controlled-fixture']); res.end(JSON.stringify({ job })); return; }
      if (req.url.endsWith('/heartbeat')) { assert.equal(body.leaseId, job.leaseId); assert.ok(body.seq > lastSeq); lastSeq = body.seq; res.end(JSON.stringify({ leaseUntil: Date.now() + 90000, cancel: false })); return; }
      if (req.method === 'PUT') { const hash = req.url.split('/').at(-1); assert.equal(hash, sha256(raw)); assert.equal(req.headers['x-lease-id'], job.leaseId); const artifact = validateArtifact(body); assert.equal(artifact.kind, 'experiment'); experiment = artifact.data; res.end(JSON.stringify({ digest: hash })); return; }
      if (req.url.endsWith('/finalize')) { assert.ok(body.seq > lastSeq); lastSeq = body.seq; assert.deepEqual(body.budget.observed, body.budget.charged); final = body; res.end('{"status":"completed"}'); return; }
      throw new Error(`Unexpected endpoint ${req.url}`);
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve)));
  const settings = { ...config(), root, token: 'test-runner-token', siteUrl: `http://127.0.0.1:${server.address().port}`, heartbeatMs: 100 };
  const result = await new Runner(settings, { log() {} }).runOnce();
  assert.equal(result.status, 'completed'); assert.ok(final); assert.ok(experiment);
  assert.equal(experiment.evidence, 'controlled'); assert.equal(experiment.model, 'controlled-fixture');
  assert.equal(experiment.usage.modelRequests, 0); assert.equal(experiment.usage.tokens, 0);
  assert.deepEqual(experiment.matches, []); assert.equal(experiment.classification, 'controlled_validation');
  const [b, c] = experiment.arms;
  assert.equal(b.initialImprover, b.finalImprover); assert.notEqual(c.initialImprover, c.finalImprover);
  assert.ok(experiment.arms.every((arm) => arm.scores.every((entry) => entry.status === 'completed' && entry.failureReason === null)));
  assert.ok(c.score > b.score); assert.equal(experiment.sameHarness, false);
  const checkpoint = JSON.parse(await readFile(join(root, job.id, 'runner-state.json'), 'utf8'));
  assert.equal(checkpoint.state, 'completed'); assert.equal(checkpoint.budget.unknown.length, 0);
});

test('heartbeat failure aborts in-flight execution and reports recovery without dispatching a next action', async (t) => {
  const root = await workspace(t), job = makeJob(); let calls = 0, dispatched = 0, aborted = false;
  const client = stubClient(job, { heartbeat: async () => { if (++calls > 1 && dispatched) throw new Error('network lost'); return { leaseUntil: Date.now() + 90000, cancel: false }; } });
  const runner = new Runner({ ...config(), root, heartbeatMs: 5 }, {
    client, log() {}, readBudget: async () => ({ observed: zero(), charged: { ...zero(), model_requests: 1, tokens: 100 }, unknown: ['submitted-model-request'] }),
    execute: async (_job, _config, _root, guard, signal) => { guard(); dispatched++; await delay(1000, undefined, { signal }).catch(() => { aborted = true; }); guard(); dispatched++; },
  });
  const result = await runner.runJob(job);
  assert.equal(result.status, 'needs_recovery'); assert.equal(aborted, true); assert.equal(dispatched, 1);
  assert.equal(client.calls.finalized, false); assert.ok(client.calls.failure.unknownOperations.includes('submitted-model-request'));
  assert.equal(client.calls.failure.budget.charged.model_requests, 1);
});

test('lease watchdog aborts even without a heartbeat response; immediate cancellation dispatches nothing', async (t) => {
  const root = await workspace(t), job = makeJob(); let executed = false;
  const client = stubClient(job, { heartbeat: async () => ({ leaseUntil: Date.now() + 30, cancel: false }) });
  const runner = new Runner({ ...config(), root, heartbeatMs: 1000 }, { client, log() {}, readBudget: async () => emptyBudget(), execute: async (_j, _c, _r, guard, signal) => { executed = true; await delay(1000, undefined, { signal }).catch(() => {}); guard(); } });
  assert.equal((await runner.runJob(job)).status, 'needs_recovery'); assert.equal(executed, true);
  const other = makeJob({ job_id: 'cancel-test-job' }); let invoked = false;
  const cancellation = stubClient(other, { heartbeat: async () => ({ leaseUntil: Date.now() + 90000, cancel: true }) });
  const cancelled = new Runner({ ...config(), root }, { client: cancellation, log() {}, execute: async () => { invoked = true; } });
  assert.equal((await cancelled.runJob(other)).status, 'cancelled'); assert.equal(invoked, false); assert.equal(cancellation.calls.failure.cancelled, true);
});

test('existing workspace cannot restart work or reset its budget', async (t) => {
  const root = await workspace(t), job = makeJob(); await claimWorkspace(root, job); let called = false;
  const client = stubClient(job);
  const runner = new Runner({ ...config(), root }, { client, log() {}, readBudget: async () => ({ observed: { ...zero(), matches: 5 }, charged: { ...zero(), matches: 6 }, unknown: ['lost-match'] }), execute: async () => { called = true; } });
  const result = await runner.runJob(job);
  assert.equal(result.status, 'needs_recovery'); assert.equal(called, false);
  assert.equal(client.calls.failure.budget.charged.matches, 6);
});

test('runner owner lock remains held throughout asynchronous execution', async (t) => {
  const root = await workspace(t), job = makeJob(), client = stubClient(job);
  let started, finish;
  const entered = new Promise((resolve) => { started = resolve; });
  const release = new Promise((resolve) => { finish = resolve; });
  const runner = new Runner({ ...config(), root }, { client, log() {}, readBudget: async () => emptyBudget(), execute: async () => { started(); await release; throw new Error('controlled stop'); } });
  const pending = runner.runOnce(); await entered;
  assert.equal((await stat(join(root, 'runner.owner'))).isFile(), true);
  await assert.rejects(runner.runOnce(), { code: 'EEXIST' });
  finish(); await pending;
  await assert.rejects(stat(join(root, 'runner.owner')), { code: 'ENOENT' });
});

test('live entry binds local model/image, exact approved caps, implementation and cancellation without real providers', async (t) => {
  const root = await workspace(t), settings = { ...config(), liveEnabled: true, keyEnv: 'ARENA_TEST_ONLY_SECRET' };
  const gear = await loadGear(settings), info = await preflight(settings, { gear });
  const job = makeJob({ evidence_kind: 'live', model_profile_id: 'deepseek-flash', caps: info.plans.live.total, protocol_digest: info.protocol_digest, gear_implementation_digest: info.gear_implementation_digest });
  let modelArgs, dockerArgs, runOptions, modelCalls = 0;
  process.env.ARENA_TEST_ONLY_SECRET = 'fixture-not-a-real-key'; t.after(() => { delete process.env.ARENA_TEST_ONLY_SECRET; });
  const injected = {
    ...gear,
    HttpModel: class { kind = 'live'; identity = 'test-model'; constructor(...args) { modelArgs = args; } allowance() { return { model_requests: 1, tokens: 10 }; } async complete(_request, signal) { signal.throwIfAborted(); modelCalls++; return { output: '{}', usage: { model_requests: 1, tokens: 2 } }; } },
    MoneCraftDocker: { create: async (...args) => { dockerArgs = args; return { kind: 'monecraft', identity: 'test-game', compile: async () => ({ status: 'ready', diagnostics: '' }), play: async () => ({ status: 'complete', score: 0, replay: null, details: {} }) }; } },
    runArenaComparison: async (options) => { runOptions = options; await options.model.complete({ phase: 'learn', system: '', input: '{}' }, options.signal); return { status: 'completed' }; },
  };
  const control = new AbortController();
  await executeJob(job, settings, root, () => control.signal.throwIfAborted(), control.signal, { gear: injected });
  assert.deepEqual(modelArgs, [settings.endpoint, 'deepseek-flash', 'ARENA_TEST_ONLY_SECRET', 4096]);
  assert.equal(dockerArgs[0], IMAGE); assert.equal(dockerArgs[1], join(root, 'games'));
  assert.deepEqual(runOptions.limitsPerArm, info.plans.live.per_arm); assert.deepEqual(runOptions.limitsPerAudit, info.plans.live.per_audit); assert.equal(modelCalls, 1);
  control.abort(); await assert.rejects(runOptions.model.complete({}, control.signal)); assert.equal(modelCalls, 1);
  await assert.rejects(executeJob({ ...job, manifest: { ...job.manifest, image_digest: 'tampered' } }, settings, root, () => {}, new AbortController().signal, { gear: injected }), /approval/);
});

test('finalization retries only the same receipt after a lost response', async () => {
  const bodies = []; let request = 0;
  const client = new RunnerClient({ ...config(), token: 'test-token' }, async (_url, options) => {
    bodies.push(options.body); if (++request === 1) throw new Error('response lost'); return new Response('{"status":"completed"}', { status: 200 });
  });
  await client.finalize(makeJob(), { seq: 5, experimentArtifact: 'a'.repeat(64), budget: { observed: zero(), charged: zero() } });
  assert.equal(request, 2); assert.equal(bodies[0], bodies[1]);
});

test('failed publication requires recovery and retains completed local work', async (t) => {
  const root = await workspace(t), job = makeJob();
  const client = stubClient(job, { artifact: async () => { throw new Error('upload acknowledgement lost'); } });
  const runner = new Runner({ ...config(), root }, { client, log() {}, readBudget: async () => emptyBudget(), execute: async () => ({}), artifacts: async () => ({ experiment: {}, replays: [] }) });
  assert.equal((await runner.runJob(job)).status, 'needs_recovery');
  assert.ok(client.calls.failure.unknownOperations.includes('runner:publication_incomplete'));
  assert.equal(client.calls.finalized, false);
  assert.equal(JSON.parse(await readFile(join(root, job.id, 'runner-state.json'), 'utf8')).state, 'needs_recovery');
});

test('policy failures retain charged match rows without inventing replay; completed game missing replay rejects publication', async (t) => {
  const root = await workspace(t), job = makeJob({ evidence_kind: 'live', model_profile_id: 'deepseek-flash' });
  const initial = { executor: { version: 1, instruction: 'E0' }, improver: { version: 1, instruction: 'I0' } };
  const target = join(root, 'target'); await atomicJson(join(target, 'executor.json'), initial.executor);
  const result = {
    initial, gearDigest: digest, protocol: { opponents: ['stop'] },
    report: { same_harness: true, budget: { observed: { ...zero(), matches: 1 } },
      arms: ['B', 'C'].map((label) => ({ label, frozen_harness: digest(initial), epochs: [{ epoch: 0, exported_target: target, retained_improver: digest(initial.improver), gate: 'rejected', run_id: `run-${label}` }] })),
      audits: ['B', 'C'].map((label) => ({ label, result: { mean_score: 0, episodes: [{ seed: 31, score: 0, status: 'complete', failure_reason: null }, { seed: 47, score: 0, status: 'task_failed', failure_reason: 'invalid_harness' }] } })),
    },
    recordings: [{ request: { id: 'run-B/trial/match', seed: 7, seat: 0, opponent: 'stop' }, receipt: { status: 'policy_failed', score: 0, replay: null } }],
  };
  const { experiment, replays } = await publicArtifacts(job, result, root);
  assert.equal(experiment.matches.length, 1); assert.equal(experiment.matches[0].status, 'policy_failed'); assert.equal(experiment.matches[0].replayUrl, null); assert.deepEqual(replays, []);
  for (const arm of experiment.arms) {
    assert.deepEqual(arm.scores, [{ seed: 31, score: 0, status: 'completed', failureReason: null }, { seed: 47, score: 0, status: 'task_failed', failureReason: 'invalid_harness' }]);
    assert.equal(arm.score, 0);
  }
  validateArtifact({ kind: 'experiment', data: experiment });
  result.recordings[0].receipt.status = 'complete';
  await assert.rejects(publicArtifacts(job, result, root), /replay is missing/);
});

test('replay normalization emits only schema-allowed fields and correct terminal frame', () => {
  const terrain = Array(31 * 31).fill('.'); terrain[2 * 31 + 5] = '#';
  const mines = Array.from({ length: 6 }, (_, id) => ({ id, x: 10 + id, y: 10, owner: -1, point: 0, 'ptc-round': 0 }));
  const data = { map: { width: 31, height: 31, terrain: terrain.join('') }, 'init-players': [{ id: 0, x: 1, y: 1, 'blink-cd': 2 }, { id: 1, x: 2, y: 2 }], 'init-mines': mines, 'rounds-info': [{ rounds: 0, players: [{ id: 0, x: 1, y: 1 }, { id: 1, x: 2, y: 2 }], mines, ginfo: [], OB: [] }], result: { winner: 0 }, private: 'not exported' };
  const replay = normalizeReplay(Buffer.from(JSON.stringify(data)), 'run-test', { id: 'match-test', arm: 'B', phase: 'audit', seed: 31, seat: 0 });
  validateArtifact({ kind: 'replay', data: replay }); assert.equal(replay.frames[0].round, 1); assert.equal('blinkCd' in replay.initialPlayers[0], false); assert.equal('private' in replay, false);
  assert.equal(replay.board[5][2], 1); assert.equal(replay.board[2][5], 0);
});


test('connection check reads readiness with auth and never claims a task', async () => {
  const requests=[];
  const client=new RunnerClient({...config(),token:'readiness-token'},async(url,options)=>{
    requests.push({url,options});
    return Response.json({status:'ready',claimsJob:false});
  });
  assert.equal((await client.checkConnection()).status,'ready');
  assert.equal(requests.length,1);
  assert.equal(new URL(requests[0].url).pathname,'/api/runner/health');
  assert.equal(requests[0].options.method,'GET');
  assert.equal(requests[0].options.body,undefined);
  assert.equal(requests[0].options.headers.Authorization,'Bearer readiness-token');
});

test('pinned job scope is sent to the server and enforced before any local execution', async () => {
  const job = makeJob();
  const pinned = config({ARENA_JOB_ID:job.id});
  assert.equal(pinned.allowedJobId,job.id);
  assert.equal(validateJob(job,pinned).executor.instruction,job.executor);
  assert.throws(()=>validateJob(job,{allowedJobId:'run-different'}),/pinned task/);
  assert.throws(()=>config({ARENA_JOB_ID:'../invalid'}),/pinned job/);
  let sent;
  const client = new RunnerClient({...pinned,token:'test-token'},async (_url, options)=>{sent=JSON.parse(options.body);return Response.json({job:null});});
  await client.claim('pinned-claim-test');
  assert.equal(sent.jobId,job.id);
});

test('poll retries only the same uncertain claim before starting any task', async (t) => {
 const root=await workspace(t),stop=new AbortController(),ids=[];let executed=0;
 const runner=new Runner({...config(),root,pollMs:1},{log:()=>{},client:{claim:async id=>{ids.push(id);if(ids.length===1)throw new Error('lost claim response');stop.abort();return {job:null};}},execute:async()=>{executed++;}});
 await runner.poll(stop.signal);
 assert.equal(ids.length,2);assert.equal(new Set(ids).size,1);assert.equal(executed,0);
 await assert.rejects(stat(join(root,'pending-claim.json')),e=>e.code==='ENOENT');
});

test('poll stops on a rejected claim or after three transport retries, preserving its ID', async (t) => {
 for(const status of [409,503]){
  const root=await workspace(t),ids=[];
  const runner=new Runner({...config(),root,pollMs:1},{log:()=>{},client:{claim:async id=>{ids.push(id);const e=new Error('rejected');e.status=status;throw e;}}});
  await assert.rejects(runner.poll());
  assert.equal(ids.length,status===409?1:4);assert.equal(new Set(ids).size,1);
  assert.equal(JSON.parse(await readFile(join(root,'pending-claim.json'),'utf8')).claimId,ids[0]);
 }
});
