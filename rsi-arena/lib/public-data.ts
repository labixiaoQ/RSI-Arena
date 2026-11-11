import history from './data/history.json';
import {db,bucket,isAdmin} from './authz';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import type {Experiment,Replay} from './arena-types';
import type {Job} from './job-store';
export async function canReadJob(job:Pick<Job,'visibility'|'owner'>){if(job.visibility)return true;const user=await getChatGPTUser();return !!user&&(user.userId===job.owner||isAdmin(user));}
export async function getExperiments():Promise<Experiment[]>{
 const saved=history.experiments as Experiment[];
 try{const jobs=await db().prepare("SELECT experiment_artifact FROM jobs WHERE visibility=1 AND status='completed' ORDER BY finished_at DESC LIMIT 50").all<{experiment_artifact:string}>();const items=await Promise.all(jobs.results.map(async j=>{const o=await bucket().get('artifacts/'+j.experiment_artifact);return o?(await o.json<{data:Experiment}>()).data:null;}));return [...items.filter((v):v is Experiment=>!!v),...saved];}catch{return saved;}
}
export async function getExperiment(id:string):Promise<Experiment|null>{
 const old=history.experiments.find(x=>x.id===id);if(old)return old as Experiment;
 const job=await db().prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<Job>();if(!job?.experiment_artifact||job.status!=='completed'||!await canReadJob(job))return null;
 const obj=await bucket().get('artifacts/'+job.experiment_artifact);return obj?(await obj.json<{data:Experiment}>()).data:null;
}
export async function getReplay(id:string):Promise<Replay|null>{
 const old=(history.replays as Record<string,Replay>)[id];if(old)return old;
 const a=await db().prepare("SELECT a.digest,j.visibility,j.owner FROM artifacts a JOIN jobs j ON a.job_id=j.id WHERE a.kind='replay' AND a.object_id=? AND j.status='completed'").bind(id).first<{digest:string;visibility:number;owner:string}>();
 if(!a||!await canReadJob(a))return null;const obj=await bucket().get('artifacts/'+a.digest);if(!obj)return null;return (await obj.json<{data:Replay}>()).data;
}
