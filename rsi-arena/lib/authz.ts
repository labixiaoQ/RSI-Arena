import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { hash } from './platform-contract';
export class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
export function db(){if(!env.DB)throw new ApiError(503,'数据库尚未连接');return env.DB;}
export function bucket(){if(!env.BUCKET)throw new ApiError(503,'产物存储尚未连接');return env.BUCKET;}
export async function identity(required=true){const user=await getChatGPTUser();if(required&&!user)throw new ApiError(401,'请先登录');return user;}
export function isAdmin(user:{email:string}|null){return !!user&&!!env.ARENA_ADMIN_EMAIL&&user.email.toLowerCase()===env.ARENA_ADMIN_EMAIL.toLowerCase();}
export async function admin(){const u=await identity();if(!isAdmin(u))throw new ApiError(403,'仅运营人员可以操作');return u!;}
export async function runnerAuth(req:Request){const token=env.ARENA_RUNNER_TOKEN;const supplied=req.headers.get('authorization')?.replace(/^Bearer /,'');if(!token||!supplied||await hash(token)!==await hash(supplied))throw new ApiError(401,'runner 身份无效');}
export function sameOrigin(req:Request){const origin=req.headers.get('origin');if(!origin||origin!==new URL(req.url).origin)throw new ApiError(403,'请从本站提交请求');}
export async function readJson(req:Request,limit=16000){const text=await req.text();if(new TextEncoder().encode(text).length>limit)throw new ApiError(413,'请求过大');try{return JSON.parse(text);}catch{throw new ApiError(400,'JSON 格式无效');}}
export function response(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
export async function endpoint(fn:()=>Promise<Response>){try{return await fn();}catch(e){if(e instanceof ApiError)return response({error:e.message},e.status); if(e instanceof Error&&e.name==='ZodError')return response({error:'字段不符合接口约定'},400); console.error('Arena API failure',e instanceof Error?e.message:'unknown');return response({error:'服务暂时不可用，请稍后重试'},500);}}
