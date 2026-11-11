import { sha256 } from './core.mjs';
import { createWindowsProxyFetch } from './windows-proxy.mjs';

export class RunnerClient {
  constructor(config, fetcher) { this.config = config; this.fetcher = fetcher || (config.transport==='windows-proxy'?createWindowsProxyFetch({timeoutMs:config.requestTimeoutMs}):fetch); }
  async request(path, body, { method = 'POST', headers = {}, signal } = {}) {
    if (!this.config.token) throw new Error('Runner token is missing');
    const combined = AbortSignal.any([AbortSignal.timeout(this.config.requestTimeoutMs), ...(signal ? [signal] : [])]);
    const response = await this.fetcher(`${this.config.siteUrl}${path}`, {
      method, redirect: 'error', signal: combined,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}`, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    // Never include remote response bodies: they may contain private data.
    if (!response.ok) { const error = new Error(`Runner API rejected request (${response.status})`); error.status = response.status; throw error; }
    return response.json();
  }
  checkConnection(signal) { return this.request('/api/runner/health', undefined, { method: 'GET', signal }); }
  claim(claimId, signal) { return this.request('/api/runner/claim', { workerId: this.config.workerId, claimId, ...(this.config.allowedJobId ? { jobId: this.config.allowedJobId } : {}), capabilities: ['arena-v3', 'controlled-fixture', ...(this.config.liveEnabled ? ['deepseek-flash'] : [])] }, { signal }); }
  heartbeat(job, payload) { return this.request(`/api/runner/jobs/${job.id}/heartbeat`, { leaseId: job.leaseId, leaseEpoch: job.leaseEpoch, ...payload }); }
  async artifact(job, kind, data) {
    const body = JSON.stringify({ kind, data });
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Artifact exceeds 4 MiB');
    const hash = sha256(body);
    const response = await this.request(`/api/runner/jobs/${job.id}/artifacts/${hash}`, body, { method: 'PUT', headers: { 'X-Lease-Id': job.leaseId, 'X-Lease-Epoch': String(job.leaseEpoch) } });
    return { digest: hash, ...response };
  }
  async finalize(job, payload) {
    const path = `/api/runner/jobs/${job.id}/finalize`, body = { leaseId: job.leaseId, leaseEpoch: job.leaseEpoch, ...payload };
    try { return await this.request(path, body); }
    catch (error) {
      // Only the exact idempotent completion receipt is retried, never an external model/game operation.
      if (error.status && error.status < 500) throw error;
      return this.request(path, body);
    }
  }
  fail(job, payload) { return this.request(`/api/runner/jobs/${job.id}/fail`, { leaseId: job.leaseId, leaseEpoch: job.leaseEpoch, ...payload }); }
}
