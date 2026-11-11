import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const executable='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export function createWindowsProxyFetch({timeoutMs=10000,launch=spawn,scriptPath=new URL('./windows-proxy.ps1',import.meta.url)}={}) {
 return async (url,options={})=>{
  options.signal?.throwIfAborted();
  if(new URL(url).protocol!=='https:')throw new Error('Windows proxy transport requires HTTPS');
  const source=await readFile(scriptPath,'utf8');
  const encoded=Buffer.from(source,'utf16le').toString('base64');
  return new Promise((resolve,reject)=>{
   const child=launch(executable,['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{stdio:['pipe','pipe','pipe'],windowsHide:true});
   let output='',size=0,done=false;
   const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(value);};
   const abort=()=>{child.kill();finish(new Error('Windows proxy request interrupted; outcome may be unknown'));};
   const timer=setTimeout(abort,timeoutMs+2000);
   options.signal?.addEventListener('abort',abort,{once:true});
   if(options.signal?.aborted){abort();return;}
   child.on('error',()=>finish(new Error('Cannot launch Windows proxy transport')));
   child.stdin.on('error',()=>finish(new Error('Windows proxy input failed')));
   child.stderr.on('data',()=>{});
   child.stdout.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){abort();return;}output+=chunk.toString('utf8');});
   child.on('close',code=>{
    if(code!==0){finish(new Error('Windows proxy request failed; outcome may be unknown'));return;}
    try{const result=JSON.parse(output.trim());if(!Number.isInteger(result.status)||result.status<200||result.status>599||typeof result.body!=='string')throw new Error();finish(null,new Response(result.body,{status:result.status,headers:{'Content-Type':'application/json'}}));}
    catch{finish(new Error('Invalid Windows proxy response; outcome may be unknown'));}
   });
   child.stdin.end(JSON.stringify({url,method:options.method??'GET',headers:options.headers??{},body:options.body??null,timeoutMs}));
  });
 };
}
