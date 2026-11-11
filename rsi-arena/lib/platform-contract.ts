export const BUDGET_KEYS = ['agent_calls','model_requests','tokens','episodes','matches'] as const;
export type Budget = Record<typeof BUDGET_KEYS[number], number>;
export type Snapshot = { observed: Budget; charged: Budget };
export const ZERO: Budget = {agent_calls:0,model_requests:0,tokens:0,episodes:0,matches:0};
export const CAPS: Budget = {agent_calls:50,model_requests:50,tokens:1638400,episodes:12,matches:72};
export const PROFILE = {
 protocol_digest:'sha256:1fb80c81895de8b523ba65bbf196a3e9b24d8340d38456e1d2297b8c3ed96cb6', gear_implementation_digest:'sha256:342f86065934819779d6f82295d661b14baec6520082f5b6f4996174c8fc7e43',
 protocol_id:'arena-v3', model_profile_id:'deepseek-flash', runner_profile_id:'development-container-v1',
 image_digest:'sha256:363c67d8186b9a13cb4898f191389ade38d2d534f74dca7e2632659a341cf6f7',
 epochs:1, audit_seeds:[31,47], duration_ms:3600000,
};
export function canonical(value: unknown): string {
 if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value);
}
export async function digest(value: unknown) { return 'sha256:'+await hash(canonical(value)); }
export async function hash(value: string|ArrayBuffer) {
 const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function validateSnapshot(next: Snapshot, previous: Snapshot, caps: Budget) {
 for(const key of BUDGET_KEYS) {
  const a=next.observed?.[key],b=next.charged?.[key];
  if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<a||b>caps[key]||a<previous.observed[key]) throw new Error('预算快照无效或超出批准额度');
 }
}
export function counts(b:Budget) {return {modelRequests:b.model_requests,tokens:b.tokens,matches:b.matches,episodes:b.episodes};}
