import {db,ApiError} from './authz';
import {CAPS,PROFILE,ZERO,digest,counts,validateSnapshot,type Budget,type Snapshot} from './platform-contract';
import type {Submission,RunState} from './arena-types';
export type Job = {id:string;owner:string;title:string;description:string;executor:string;improver:string;visibility:number;status:RunState;created_at:string;updated_at:string;manifest:string;manifest_digest:string;idempotency_key:string;request_digest:string;approval:string|null;rejection_reason:string|null;worker_id:string|null;claim_id:string|null;lease_id:string|null;lease_epoch:number;lease_until:number|null;seq:number;phase:string|null;budget:string;unknown_operations:string;finalization_digest:string|null;experiment_artifact:string|null;finished_at:string|null};
export const now=()=>new Date().toISOString();
export const sql=(query:string,...args:(string|number|null)[])=>db().prepare(query).bind(...args);
export async function getJob(id:string){return sql('SELECT * FROM jobs WHERE id=?',id).first<Job>();}
export function submission(j:Job):Submission{return {id:j.id,title:j.title,description:j.description,status:j.status,createdAt:j.created_at,public:!!j.visibility,protocolId:JSON.parse(j.manifest).protocol_id,model:JSON.parse(j.manifest).model_profile_id,plan:counts(JSON.parse(j.manifest).caps),experimentId:j.experiment_artifact?j.id:null,rejectionReason:j.rejection_reason,manifestDigest:j.manifest_digest,executor:j.executor,improver:j.improver,evidence:JSON.parse(j.manifest).evidence_kind};}
export async function expireLeases(){await sql("UPDATE jobs SET status='needs_recovery',rejection_reason='runner 租约失效；保留额度，禁止自动重跑',updated_at=? WHERE status IN ('running','uploading','cancel_requested') AND lease_until < ?",now(),Date.now()).run();}
export async function event(job:string,kind:string,actor:string,data:unknown){await sql('INSERT INTO job_events(job_id,kind,actor,at,data) VALUES(?,?,?,?,?)',job,kind,actor,now(),JSON.stringify(data)).run();}
export async function runnerState(){const row=await sql('SELECT MAX(last_seen) AS seen FROM runners').first<{seen:number|null}>();return {online:!!row?.seen&&Date.now()-row.seen<90000,lastSeen:row?.seen?new Date(row.seen).toISOString():null};}
export async function createJob(owner:string,input:{title:string;description:string;executor:string;improver:string;public:boolean;idempotencyKey:string;evidence?:'controlled'}){
 const requestDigest=await digest(input);const previous=await sql('SELECT * FROM jobs WHERE owner=? AND idempotency_key=?',owner,input.idempotencyKey).first<Job>();
 if(previous){if(previous.request_digest!==requestDigest)throw new ApiError(409,'同一个提交标识已用于不同内容');return previous;}
 const pending=await sql("SELECT COUNT(*) AS n FROM jobs WHERE owner=? AND status IN ('awaiting_approval','queued','running','uploading','cancel_requested')",owner).first<{n:number}>();
 if((pending?.n??0)>=10)throw new ApiError(429,'最多同时保留 10 个待处理提交');
 const id='run-'+crypto.randomUUID();const target={executor:{version:1,instruction:input.executor},improver:{version:1,instruction:input.improver}};
 const manifest={schema_version:1,job_id:id,submission_digest:await digest(target),...PROFILE,caps:input.evidence==='controlled'?{...CAPS,model_requests:0,tokens:0}:CAPS,evidence_kind:input.evidence??'live',model_profile_id:input.evidence==='controlled'?'controlled-fixture':PROFILE.model_profile_id};
 const manifestDigest=await digest(manifest),created=now();
 await sql('INSERT INTO jobs(id,owner,title,description,executor,improver,visibility,status,created_at,updated_at,manifest,manifest_digest,idempotency_key,request_digest,budget) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,idempotency_key) DO NOTHING',id,owner,input.title,input.description,input.executor,input.improver,input.public?1:0,'awaiting_approval',created,created,JSON.stringify(manifest),manifestDigest,input.idempotencyKey,requestDigest,JSON.stringify({observed:ZERO,charged:ZERO})).run();
 const actual=await sql('SELECT * FROM jobs WHERE owner=? AND idempotency_key=?',owner,input.idempotencyKey).first<Job>();
 if(!actual||actual.request_digest!==requestDigest)throw new ApiError(409,'提交标识冲突');return actual;
}
export async function lease(id:string,leaseId:string,epoch:number){const j=await getJob(id);if(!j)throw new ApiError(404,'任务不存在');if(j.lease_id!==leaseId||j.lease_epoch!==epoch||!j.lease_until||j.lease_until<Date.now()||!['running','uploading','cancel_requested'].includes(j.status))throw new ApiError(409,'租约已失效，禁止继续执行');return j;}
export function snapshot(j:Job,budget:Snapshot){try{validateSnapshot(budget,JSON.parse(j.budget),JSON.parse(j.manifest).caps as Budget);}catch{throw new ApiError(409,'预算快照下降、无效或超过批准上限');}}
