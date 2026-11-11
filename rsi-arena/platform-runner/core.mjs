import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DIMENSIONS = ['agent_calls', 'model_requests', 'tokens', 'episodes', 'matches'];
export const zero = () => Object.fromEntries(DIMENSIONS.map((key) => [key, 0]));
export const emptyBudget = () => ({ observed: zero(), charged: zero(), unknown: [] });
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('Invalid canonical JSON');
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const digest = (value) => `sha256:${sha256(canonical(value))}`;
export const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value);
export const timestamp = (value) => typeof value === 'number' ? value : Date.parse(value);
export function counts(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !DIMENSIONS.includes(key))) throw new Error('Invalid budget');
  for (const key of DIMENSIONS) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('Invalid budget');
  return { ...value };
}
export function instruction(value) {
  const text = typeof value === 'string' ? value : value?.version === 1 ? value.instruction : null;
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || Buffer.byteLength(text) > 2048) throw new Error('Invalid instruction');
  return { version: 1, instruction: text };
}
export function validateJob(job, { liveEnabled = false, allowedJobId = null } = {}) {
  if (!job || !safeId(job.id) || !safeId(job.leaseId) || !Number.isSafeInteger(job.leaseEpoch) || job.leaseEpoch < 1 || !(timestamp(job.leaseUntil) > Date.now())) throw new Error('Invalid job lease');
  if (allowedJobId && job.id !== allowedJobId) throw new Error('Job does not match the pinned task');
  const m = job.manifest;
  const allowed = ['schema_version', 'job_id', 'submission_digest', 'protocol_id', 'model_profile_id', 'runner_profile_id', 'epochs', 'audit_seeds', 'duration_ms', 'caps', 'evidence_kind', 'image_digest', 'protocol_digest', 'gear_implementation_digest'];
  if (!m || Object.keys(m).some((key) => !allowed.includes(key)) || m.schema_version !== 1 || m.job_id !== job.id || m.protocol_id !== 'arena-v3' || m.runner_profile_id !== 'development-container-v1' || m.epochs !== 1 || JSON.stringify(m.audit_seeds) !== '[31,47]' || !Number.isSafeInteger(m.duration_ms) || m.duration_ms < 1000 || m.duration_ms > 3600000) throw new Error('Unsupported manifest profile');
  if (!['live', 'controlled'].includes(m.evidence_kind) || m.model_profile_id !== (m.evidence_kind === 'live' ? 'deepseek-flash' : 'controlled-fixture')) throw new Error('Unsupported model profile');
  if (m.evidence_kind === 'live' && !liveEnabled) throw new Error('Live execution is disabled');
  counts(m.caps);
  const initial = { executor: instruction(job.executor), improver: instruction(job.improver) };
  if (m.submission_digest !== digest(initial)) throw new Error('Submission digest mismatch');
  const expected = digest(m);
  if (job.manifestDigest !== expected || job.approval?.manifestDigest !== expected || canonical(counts(job.approval?.caps)) !== canonical(m.caps) || !Number.isFinite(Date.parse(job.approval?.approvedAt))) throw new Error('Missing or mismatched approval');
  return initial;
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
export async function claimWorkspace(root, job) {
  const path = join(root, job.id);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const file = await open(join(path, 'runner-checkpoint.json'), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ version: 1, jobId: job.id, manifestDigest: job.manifestDigest, leaseId: job.leaseId, leaseEpoch: job.leaseEpoch, state: 'claimed', createdAt: new Date().toISOString() }, null, 2));
    await file.sync();
  } finally { await file.close(); }
  await atomicJson(join(path, 'approved-job.json'), job);
  return path;
}
export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
