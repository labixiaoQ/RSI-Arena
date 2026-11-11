import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, claimWorkspace, emptyBudget, readJson, timestamp, validateJob } from './core.mjs';
import { executeJob, readBudget } from './execute.mjs';
import { publicArtifacts } from './publish.mjs';
import { RunnerClient } from './client.mjs';

export class Runner {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.client = dependencies.client || new RunnerClient(config);
    this.execute = dependencies.execute || executeJob;
    this.artifacts = dependencies.artifacts || publicArtifacts;
    this.budgetReader = dependencies.readBudget || readBudget;
    this.log = dependencies.log || ((entry) => console.log(JSON.stringify(entry)));
  }
  async runOnce(signal = new AbortController().signal) {
    signal.throwIfAborted();
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.config.root, 'runner.owner');
    const lock = await open(lockPath, 'wx', 0o600);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, workerId: this.config.workerId, startedAt: new Date().toISOString() }));
      await lock.sync();
      const claimPath = join(this.config.root, 'pending-claim.json');
      let claim;
      try { claim = await readJson(claimPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; claim = { claimId: randomUUID() }; await atomicJson(claimPath, claim); }
      let response;
      try { response = await this.client.claim(claim.claimId, signal); }
      catch (error) {
        if (!signal.aborted && (!Number.isInteger(error?.status) || error.status >= 500)) {
          const pending = new Error('Claim response is unknown; preserve the same claim ID');
          pending.retryableClaim = true;
          throw pending;
        }
        throw error;
      }
      const { job } = response;
      // Once a response is recorded, a restarted process must not invent a new workspace for that task.
      await atomicJson(join(this.config.root, 'last-claim.json'), { claimId: claim.claimId, jobId: job?.id || null, receivedAt: new Date().toISOString() });
      await rm(claimPath);
      if (!job) return { status: 'idle' };
      return await this.runJob(job, signal);
    } finally { await lock.close(); await rm(lockPath); }
  }
  async runJob(job, externalSignal) {
    let root, seq = 0, phase = 'validating', budget = emptyBudget(), started = false, cancelled = false, leaseLost = false;
    let leaseUntil = timestamp(job.leaseUntil), watchdog, heartbeatTask;
    const controller = new AbortController(), heartbeatStop = new AbortController();
    const signal = AbortSignal.any([controller.signal, externalSignal || new AbortController().signal]);
    const guard = () => {
      signal.throwIfAborted();
      if (Date.now() >= leaseUntil) { leaseLost = true; controller.abort(new Error('lease_expired')); throw controller.signal.reason; }
    };
    const setWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { leaseLost = true; controller.abort(new Error('lease_expired')); }, Math.max(1, leaseUntil - Date.now()));
    };
    const snapshot = async () => {
      if (root) {
        try { budget = await this.budgetReader(root); }
        catch {
          // A damaged/unreadable ledger is not proof of zero spend.
          if (started) budget = { observed: budget.observed, charged: { ...job.manifest.caps }, unknown: ['runner:ledger_unreadable'] };
          else throw new Error('ledger_unreadable');
        }
      }
      return { observed: budget.observed, charged: budget.charged };
    };
    const performHeartbeat = async () => {
      guard();
      const response = await this.client.heartbeat(job, { seq: ++seq, phase, budget: await snapshot(), unknownOperations: budget.unknown });
      const nextLease = timestamp(response.leaseUntil);
      if (!Number.isFinite(nextLease) || nextLease <= Date.now()) throw new Error('invalid_lease_response');
      leaseUntil = nextLease; setWatchdog();
      if (response.cancel) { cancelled = true; controller.abort(new Error('cancel_requested')); }
      guard();
    };
    let heartbeatChain = Promise.resolve();
    const beat = () => { heartbeatChain = heartbeatChain.then(performHeartbeat); return heartbeatChain; };
    const stopHeartbeat = async () => {
      heartbeatStop.abort();
      await heartbeatTask;
      await heartbeatChain.catch(() => {});
    };
    let durationTimer;
    try {
      validateJob(job, this.config);
      root = await claimWorkspace(this.config.root, job);
      setWatchdog();
      await beat();
      heartbeatTask = (async () => {
        try {
          while (!heartbeatStop.signal.aborted && !signal.aborted) {
            await delay(this.config.heartbeatMs, undefined, { signal: heartbeatStop.signal });
            if (!heartbeatStop.signal.aborted && !signal.aborted) await beat();
          }
        } catch {
          if (!heartbeatStop.signal.aborted && !cancelled) { leaseLost = true; controller.abort(new Error('heartbeat_lost')); }
        }
      })();
      durationTimer = setTimeout(() => controller.abort(new Error('job_deadline_exceeded')), job.manifest.duration_ms);
      phase = 'executing'; started = true;
      await atomicJson(join(root, 'runner-state.json'), { state: 'running', manifestDigest: job.manifestDigest, startedAt: new Date().toISOString() });
      const result = await this.execute(job, this.config, root, guard, signal);
      guard();
      phase = 'uploading';
      await beat();
      const { experiment, replays } = await this.artifacts(job, result, root);
      const replayArtifacts = [];
      for (const replay of replays) { guard(); replayArtifacts.push((await this.client.artifact(job, 'replay', replay)).digest); }
      guard();
      const experimentArtifact = (await this.client.artifact(job, 'experiment', experiment)).digest;
      const finalBudget = await snapshot();
      if (budget.unknown.length) throw new Error('unresolved_operations');
      await stopHeartbeat();
      guard();
      const completion = { seq: ++seq, budget: finalBudget, experimentArtifact, replayArtifacts };
      await atomicJson(join(root, 'publication.json'), completion);
      await this.client.finalize(job, completion);
      await atomicJson(join(root, 'runner-state.json'), { state: 'completed', experimentArtifact, replayArtifacts, budget, finishedAt: new Date().toISOString() });
      this.log({ jobId: job.id, status: 'completed', evidence: job.manifest.evidence_kind, observed: budget.observed });
      return { status: 'completed', jobId: job.id, experimentArtifact, budget };
    } catch (error) {
      await stopHeartbeat();
      controller.abort(new Error('execution_stopped'));
      // executeJob settles before this point; its Docker adapter verifies process cleanup in finally.
      const knownBudget = await snapshot().catch(() => ({ observed: budget.observed, charged: { ...job.manifest?.caps } }));
      let unknown = [...budget.unknown];
      if (!root && error.code === 'EEXIST') {
        root = join(this.config.root, job.id);
        budget = await this.budgetReader(root).catch(() => ({ observed: emptyBudget().observed, charged: { ...job.manifest.caps }, unknown: ['runner:ledger_unreadable'] }));
        unknown = [...budget.unknown, 'runner:existing_workspace_requires_operator_recovery'];
        knownBudget.observed = budget.observed; knownBudget.charged = budget.charged;
      }
      if (leaseLost) unknown.push('runner:lease_lost');
      if (phase === 'uploading') unknown.push('runner:publication_incomplete');
      const reason = leaseLost ? 'lease_lost' : cancelled ? 'cancel_requested' : externalSignal?.aborted ? 'runner_interrupted' : started ? 'execution_failed' : 'admission_rejected';
      let notified = false;
      try {
        await this.client.fail(job, { seq: ++seq, budget: knownBudget, reason, unknownOperations: unknown, cancelled: (cancelled || Boolean(externalSignal?.aborted)) && unknown.length === 0 });
        notified = true;
      } catch { /* Preserve local evidence; stale leases and lost acknowledgments cannot be retried as new work. */ }
      const state = unknown.length || !notified ? 'needs_recovery' : cancelled || externalSignal?.aborted ? 'cancelled' : 'failed';
      if (root) await atomicJson(join(root, 'runner-state.json'), { state, reason, unknownOperations: unknown, budget: knownBudget, failureReported: notified, stoppedAt: new Date().toISOString() });
      this.log({ jobId: job.id, status: state, reason });
      return { status: state, jobId: job.id, reason, budget: knownBudget };
    } finally {
      clearTimeout(durationTimer); clearTimeout(watchdog);
      heartbeatStop.abort();
      await heartbeatTask;
    }
  }
  async poll(signal = new AbortController().signal) {
    let claimFailures = 0;
    while (!signal.aborted) {
      try { await this.runOnce(signal); claimFailures = 0; }
      catch (error) {
        if (signal.aborted) break;
        // Only replay the durable idempotent claim, before any task has started.
        // Execution/heartbeat failures never enter this retry path.
        if (!error.retryableClaim || claimFailures >= 3) throw error;
        this.log({ status: 'claim_pending', retry: ++claimFailures, replay: 'same_claim_id' });
      }
      if (!signal.aborted) await delay(this.config.pollMs, undefined, { signal }).catch(() => {});
    }
  }
}
