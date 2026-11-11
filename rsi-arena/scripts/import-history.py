"""Whitelist importer: no raw logs, policies, user paths or environment values are published."""
import json,hashlib,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
SRC=ROOT.parent/'gear/arena-runs/comparison-v2-pilot-20261111'
OUT=ROOT/'public/data'; OUT.mkdir(parents=True,exist_ok=True)
(OUT/'replays').mkdir(exist_ok=True)
def read(p):
 try:return json.loads(p.read_text())
 except json.JSONDecodeError:return {}
sha=lambda p:'sha256:'+hashlib.sha256(p.read_bytes()).hexdigest()
report=read(SRC/'invalid-proposal-recovery/report.json'); frozen=read(SRC/'invalid-proposal-recovery/frozen.json')
ID='monecraft-pilot-20261111';meta={}; matches=[]; replayIndex={}
def visit(value,arm,phase):
 if isinstance(value,list):
  for v in value:visit(v,arm,phase)
 if isinstance(value,dict):
  if isinstance(value.get('replay'),str) and value['replay'].endswith('result.txt'):
   meta[pathlib.Path(value['replay']).parent.name]=(arm,phase)
  for k,v in value.items():visit(v,arm,'training' if k=='training' else phase)
for arm in ['B','C']:
 for p in (SRC/arm).rglob('*.json'):
  if p.stat().st_size<5000000:visit(read(p),arm,'audit' if '/audit/' in str(p) else 'development')
for p in (SRC/'invalid-proposal-recovery/reconstructed-C').rglob('*.json'):
 if p.stat().st_size<5000000:visit(read(p),'C','development')
for p in sorted((SRC/'jobs').glob('*/result.txt')):
 d=read(p); req=read(p.parent/'request.json'); rec=read(p.parent/'receipt.json')
 arm,phase=meta.get(p.parent.name,('search','training' if '/train-' in req['id'] else 'development'))
 mid='mc-'+p.parent.name[:16]; seed=req['seed']; seat=req['seat']
 board=[[0 if d['map']['terrain'][x*31+y]=='.' else 1 for x in range(31)] for y in range(31)]
 initialPlayers=[{k:v[k] for k in ['id','x','y']} for v in d['init-players']]
 initialMines=[{k:v[k] for k in ['id','x','y','owner']} for v in d['init-mines']]
 for v in initialPlayers+initialMines:assert board[v['y']][v['x']]==0
 frames=[dict(round=f['rounds']+1,players=[dict(id=v['id'],x=v['x'],y=v['y'],blinkCd=v['blink-cd']) for v in f['players']],mines=[dict(id=v['id'],owner=v['owner'],point=v['point'],protection=v['ptc-round']) for v in f['mines']],gold=[v['golds'] for v in sorted(f['ginfo'],key=lambda v:v['id'])],mineCounts=[v['mine-num'] for v in sorted(f['ginfo'],key=lambda v:v['id'])],observers=[{k:v[k] for k in ['id','x','y','owner']} for v in f['OB']]) for f in d['rounds-info']]
 replay=dict(id=mid,experimentId=ID,title=f'{arm} · {phase} · seed {seed} · seat {seat}',board=board,initialPlayers=initialPlayers,initialMines=initialMines,frames=frames,winner=d['result']['winner'],seed=seed,seat=seat,rounds=len(frames),sourceDigest=sha(p))
 (OUT/'replays'/f'{mid}.json').write_text(json.dumps(replay,separators=(',',':'))+'\n')
 replayIndex[mid]={**replay,'frames':[],'dataUrl':f'/data/replays/{mid}.json'}
 matches.append(dict(id=mid,experimentId=ID,arm=arm,phase=phase,seed=seed,seat=seat,score=rec['score'],opponent='固定公开对手',rounds=len(frames),replayUrl=f'/replays/{mid}'))
assert len(matches)==42
h=frozen[0]['digest']; instructionDigest=lambda v:'sha256:'+hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
e=instructionDigest(frozen[0]['target']['executor']);i=instructionDigest(frozen[0]['target']['improver'])
# E/I digest schema is explicitly site-json-v1, H is Gear native.
nodes=[dict(id='initial',label='共同初始 H₀',arm='B/C',epoch=0,state='initial',executor=e,improver=i,note='E/I 文本摘要采用 site-json-v1；H 摘要采用 Gear canonical。')]
edges=[]
for arm,gate in [('B','rejected'),('C','invalid')]:
 nodes.append(dict(id=arm+'-candidate',label='候选未接纳' if arm=='B' else '候选无效',arm=arm,epoch=1,state=gate,executor=e,improver=i,note='展示保留的父代 E/I；B 候选开发分数未超过父代。' if arm=='B' else '展示保留的父代 E/I；C 提案 E 为 2287 字节，超过 2048 上限。'))
 nodes.append(dict(id=arm+'-frozen',label=arm+' 冻结 H₀',arm=arm,epoch=1,state='retained',executor=e,improver=i,note='继续继承初始 H；后续审计未参与选择。'))
 edges.extend([dict(from_='initial',to=arm+'-candidate'),dict(from_=arm+'-candidate',to=arm+'-frozen')])
usage=report['budget']['observed'];caps=report['plan']['total'];counts=lambda v:dict(modelRequests=v['model_requests'],tokens=v['tokens'],matches=v['matches'],episodes=v['episodes'])
experiment=dict(id=ID,title='MoneCraft · 首次真实 B/C 对照',summary='固定模型与额度，比较固定改进器 B 和递归改进器 C。两组都保留了初始 H，后续分数差只反映重复审计波动。',game='MoneCraft',status='completed',evidence='live',protocolId='arena-v2',model='deepseek-flash',createdAt=read(SRC/'authorization.json')['recorded_at'],classification='same_harness_repeat',sameHarness=True,amendment=report['amendment'],metricScope='4 次审计学习 episode、16 局计分对战；分数为胜 1 / 平 0.5 / 负 0 的均值。训练对局不计分。公开种子探索性试验。',usage=counts(usage),limits=counts(caps),arms=[dict(id=a['label'],label='固定改进器' if a['label']=='B' else '递归改进器',mode='fixed-improver' if a['label']=='B' else 'recursive',score=a['result']['mean_score'],gate='rejected' if a['label']=='B' else 'invalid_proposal',retainedHarness=h,initialImprover=i,finalImprover=i,scores=a['result']['episodes']) for a in report['audits']],nodes=nodes,edges=[{'from':x['from_'],'to':x['to']} for x in edges],matches=matches,notes=['两组最终 H 完全相同，C−B=0.125 不能归因于递归 RSI。','本次采用 development-container-v1，尚未达到公开不可信代码的生产隔离标准。','C 的超长提案经已确认回执在本地重建；重建新增模型请求和对局均为 0。原始失败证据保留。','种子 31、47 为公开探索性审计，未实现正式隐藏测试；没有统计显著性或普遍优越性的结论。','本页 42 局来自该新增试验。更早试验的 17 次请求、27,393 token、27 局另行留账，不混入本页。'],artifacts=[])
manifest={'schema_version':1,'evidence_kind':'live','amendment':report['amendment'],'same_harness':True,'general_rsi_superiority':'not_established','metric_scope':experiment['metricScope'],'budget':report['budget'],'plan':report['plan'],'reconstruction_physical_cost':report['reconstruction_physical_cost'],'sources':{'original_comparison':sha(SRC/'comparison.json'),'final_report':sha(SRC/'invalid-proposal-recovery/report.json'),'recovery_manifest':sha(SRC/'invalid-proposal-recovery/manifest.json')},'replays':[{'id':m['id'],'source_digest':replayIndex[m['id']]['sourceDigest'],'public_digest':sha(OUT/'replays'/f"{m['id']}.json")} for m in matches]}
(OUT/'pilot-evidence.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
experiment['artifacts']=[dict(title='可核验的证据清单',url='/data/pilot-evidence.json',digest=sha(OUT/'pilot-evidence.json'))]
(ROOT/'lib/data/history.json').write_text(json.dumps({'experiments':[experiment],'replays':replayIndex},ensure_ascii=False,separators=(',',':'))+'\n')
print(f'Imported {len(matches)} real replays; frames={sum(m["rounds"] for m in matches)}; source paths excluded')
