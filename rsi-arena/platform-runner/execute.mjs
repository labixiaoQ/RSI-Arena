import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson, canonical, counts, DIMENSIONS, emptyBudget, validateJob } from './core.mjs';
import { fixtureBackends } from './fixture.mjs';
import { IMAGE } from './config.mjs';

export async function loadGear(config) {
  const build = config.gearBuild || join(config.gearRoot, 'lib');
  const api = await import(pathToFileURL(join(build, 'arena.js')).href);
  const { digest: gearDigest } = await import(pathToFileURL(join(build, 'adapters/arena/contracts.js')).href);
  const { implementationDigest } = await import(pathToFileURL(join(build, 'adapters/arena/coordinator.js')).href);
  return { ...api, gearDigest, implementationDigest };
}
export async function protocol(config) {
  const own = join(config.gearRoot, 'examples/arena');
  const [stop, sdk, opponent, rules] = await Promise.all([
    readFile(join(own, 'policies/stop.cpp'), 'utf8'), readFile(join(config.gameRoot, 'backend/logic/src/include/sdk.h'), 'utf8'),
    readFile(join(config.gameRoot, 'public_sdk/ai.cpp'), 'utf8'), readFile(join(own, 'monecraft-contract.txt'), 'utf8'),
  ]);
  return {
    version: 3, mode: 'recursive', lookaheadDepth: 1, initialPolicy: stop, sdk, opponents: [stop, opponent], rounds: 1000,
    tasks: [{ id: 'dev-7', family: 'dev', split: 'seed', seed: 7 }, { id: 'gate-23', family: 'gate', split: 'held_out', seed: 23 }],
    learning: { rules, trainingSeeds: [1], trainingOpponents: [stop], maxPolicyCalls: 3, maxTokensPerCall: 32768 },
  };
}
export async function preflight(config, dependencies = {}) {
  const gear = dependencies.gear || await loadGear(config);
  const p = await protocol(config);
  return {
    protocol_id: 'arena-v3', protocol_digest: gear.gearDigest(p), gear_implementation_digest: await gear.implementationDigest(),
    image_digest: IMAGE, runner_profile_id: 'development-container-v1', live_enabled: config.liveEnabled,
    model_profile_id: 'deepseek-flash', model_credential_present: Boolean(process.env[config.keyEnv]),
    plans: { live: gear.comparisonPlan(p, 'live', 1, [31, 47]), controlled: gear.comparisonPlan(p, 'fixture', 1, [31, 47]) },
    isolation: 'experimental-dedicated-host-manual-approval', performs_external_calls: false,
  };
}
export async function readBudget(root) {
  const total = emptyBudget();
  for (const arm of ['B', 'C']) for (const phase of ['search', 'audit']) {
    const path = join(root, 'gear', arm, phase, 'budget.sqlite');
    let database;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      for (const row of database.prepare('SELECT id,state,reserved,actual FROM operations').all()) {
        const reserved = counts(JSON.parse(String(row.reserved)));
        const actual = row.actual === null ? null : counts(JSON.parse(String(row.actual)));
        for (const key of DIMENSIONS) { total.charged[key] += actual?.[key] ?? reserved[key]; total.observed[key] += actual?.[key] ?? 0; }
        if (row.state !== 'complete') total.unknown.push(`${arm}/${phase}/${row.id}`);
      }
    } catch (error) {
      // An absent ledger means the stage has not started. Other read failures cannot be treated as zero consumption.
      if (error.code !== 'ERR_SQLITE_ERROR' || !String(error.message).includes('unable to open database file')) throw error;
      const { stat } = await import('node:fs/promises');
      try { await stat(path); throw error; } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
    } finally { database?.close(); }
  }
  return total;
}
export async function executeJob(job, config, root, guard, signal, dependencies = {}) {
  const initial = validateJob(job, config);
  const gear = dependencies.gear || await loadGear(config);
  const p = await protocol(config), m = job.manifest;
  const implementation = await gear.implementationDigest();
  if (m.protocol_digest && m.protocol_digest !== gear.gearDigest(p)) throw new Error('Protocol digest mismatch');
  if (m.gear_implementation_digest && m.gear_implementation_digest !== implementation) throw new Error('Gear implementation digest mismatch');
  if (m.image_digest !== IMAGE) throw new Error('Pinned image mismatch');
  if (m.evidence_kind === 'live' && (!m.protocol_digest || !m.gear_implementation_digest)) throw new Error('Live execution requires pinned protocol and Gear implementation');
  const plan = gear.comparisonPlan(p, m.evidence_kind === 'live' ? 'live' : 'fixture', m.epochs, m.audit_seeds);
  // Exact plan caps prevent visitor-supplied optional actions or silent budget expansion.
  const authorizedPlans = [plan.total];
  // The operator may reserve the conservative live profile cap for a controlled job.
  // Gear still receives the zero-request/token fixture plan, so simulated calls never become physical API consumption.
  if (m.evidence_kind === 'controlled') authorizedPlans.push(gear.comparisonPlan(p, 'live', m.epochs, m.audit_seeds).total);
  if (!authorizedPlans.some((candidate) => canonical(candidate) === canonical(m.caps))) throw new Error('Approval does not match complete comparison plan');
  guard();
  let backends;
  if (m.evidence_kind === 'live') {
    if (!process.env[config.keyEnv]) throw new Error('Configured model credential is absent');
    const model = new gear.HttpModel(config.endpoint, config.model, config.keyEnv, 4096);
    const matches = await gear.MoneCraftDocker.create(IMAGE, join(root, 'games'), config.dockerContext, config.apparmor);
    guard();
    backends = { model, matches };
  } else backends = fixtureBackends();
  await atomicJson(join(root, 'execution-profile.json'), {
    protocol_digest: gear.gearDigest(p), gear_implementation_digest: implementation,
    image_digest: m.evidence_kind === 'live' ? IMAGE : null, model_identity: backends.model.identity,
    match_identity: backends.matches.identity, evidence_kind: m.evidence_kind, plan,
  });
  const recordings = [];
  const wrappedModel = {
    kind: backends.model.kind, identity: backends.model.identity,
    allowance: (request) => backends.model.allowance(request),
    complete: async (request, operationSignal) => { guard(); return backends.model.complete(request, AbortSignal.any([signal, operationSignal])); },
  };
  const wrappedMatches = {
    kind: backends.matches.kind, identity: backends.matches.identity,
    compile: async (request, operationSignal) => { guard(); return backends.matches.compile(request, AbortSignal.any([signal, operationSignal])); },
    play: async (request, operationSignal) => {
      guard();
      const receipt = await backends.matches.play(request, AbortSignal.any([signal, operationSignal]));
      const entry = { request, receipt };
      recordings.push(entry);
      await atomicJson(join(root, 'recordings', `${String(recordings.length).padStart(4, '0')}.json`), entry);
      return receipt;
    },
  };
  const report = await gear.runArenaComparison({
    root: join(root, 'gear'), initial, protocol: p, epochs: m.epochs, auditSeeds: m.audit_seeds,
    limitsPerArm: plan.per_arm, limitsPerAudit: plan.per_audit, durationMs: m.duration_ms,
    model: wrappedModel, matches: wrappedMatches, signal,
  });
  guard();
  return { report, recordings, initial, gearDigest: gear.gearDigest, protocol: p };
}
export async function readRecordings(root) {
  const directory = join(root, 'recordings');
  const names = (await readdir(directory)).filter((name) => /^\d+\.json$/u.test(name)).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
}
