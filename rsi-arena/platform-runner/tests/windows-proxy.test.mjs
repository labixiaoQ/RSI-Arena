import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createWindowsProxyFetch} from '../windows-proxy.mjs';
function child(){const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.killed=false;c.kill=()=>{c.killed=true;};return c;}
test('Windows proxy puts credentials only on stdin, preserves status, and never follows redirects',async()=>{
 const c=child();let args,payload='';c.stdin.on('data',v=>payload+=v);c.stdin.on('finish',()=>{c.stdout.write(JSON.stringify({status:307,body:'redirect'}));c.emit('close',0);});
 const fetcher=createWindowsProxyFetch({launch:(file,argv)=>{args={file,argv};return c;}});
 const r=await fetcher('https://arena.example/api/runner/claim',{method:'POST',headers:{Authorization:'Bearer private-test-token'},body:'{"claimId":"one"}'});
 assert.equal(r.status,307);assert.equal(await r.text(),'redirect');assert.equal(JSON.stringify(args).includes('private-test-token'),false);assert.equal(JSON.parse(payload).headers.Authorization,'Bearer private-test-token');
 await assert.rejects(fetcher('http://arena.example'),/HTTPS/);
});
test('Windows transport aborts without retry and treats malformed output as unknown',async()=>{
 const c=child();const controller=new AbortController();let count=0;
 const request=createWindowsProxyFetch({launch:()=>{count++;queueMicrotask(()=>controller.abort());return c;}})('https://arena.example/api/runner/claim',{signal:controller.signal});
 await assert.rejects(request,/outcome may be unknown/);assert.equal(c.killed,true);assert.equal(count,1);
 const bad=child();bad.stdin.on('finish',()=>{bad.stdout.write('not JSON');bad.emit('close',0);});
 await assert.rejects(createWindowsProxyFetch({launch:()=>bad})('https://arena.example'),/outcome may be unknown/);
});
