import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { startServer } from '../server/index.js';
import { APP_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { normalizeRemoteUrl } from '../shared/connect.js';
import { probeRemoteGame, remoteWsUrl, remoteHealth, remoteAssetTargets, resolveRemoteRedirects, remoteBases,
  createRemoteRouter, createProxyState, createWsProxy, loadRecordsDoc, ingestRecords, trimRecordsDoc,
  saveRecordsDoc, RECORDS_LIMITS } from '../server/http/remote.js';
import { isLocalHostHeader } from '../server/http/hostGuard.js';
import { selectRemoteTarget, readRemoteArtMode } from '../public/js/remote-session.js';

const fields = { ok:true, app: APP_VERSION, version:PROTOCOL_VERSION, ...remoteHealth() };
const page = '<div id="app"></div><script type="module" src="/js/main.js"></script>';
const fakeFetch=(health=fields,body=page)=>async url=>new Response(String(url).includes('healthz') ? JSON.stringify(health):body, { status: 200 });
const probe=(options={})=>probeRemoteGame('https://game.example.test/',{fetchFn:fakeFetch(),checkWs:async()=>true,...options});

test('URL validation blocks loopback, credentials, invalid schemes and empty ports; accepts IPv6 and custom ports',()=>{
  for(const url of ['http://localhost','http://127.0.0.1','http://127.2.3.4','http://[::1]','http://[::ffff:127.0.0.1]','file://game.test','https://u:p@game.test','https://game.test:','https://game.test:0','http://0x7f000001','http://2130706433']) assert.equal(normalizeRemoteUrl(url),null,url);
  assert.ok(normalizeRemoteUrl('https://[2001:db8::2]:8443/'));
  assert.equal(remoteWsUrl('https://game.test:8443/'),'wss://game.test:8443/ws');
  assert.equal(remoteWsUrl('ws://game.test:8080/ws'),'ws://game.test:8080/ws');
  assert.deepEqual(remoteBases('https://game.test/Stronghold-Protocol/'),['https://game.test/Stronghold-Protocol/','https://game.test/']);
});

test('redirect resolver follows a bounded cross-origin chain and rejects local/private hops',async()=>{
  const chain=async url=>{
    const u=String(url);
    if(u==='https://join.example/room') return new Response('',{status:302,headers:{location:'/step'}});
    if(u==='https://join.example/step') return new Response('',{status:302,headers:{location:'https://game.example.test/'}});
    return new Response(page,{status:200});
  };
  const resolved=await resolveRemoteRedirects('https://join.example/room',{fetchFn:chain});
  assert.equal(resolved.ok,true);
  assert.equal(resolved.url,'https://game.example.test/');
  assert.equal(resolved.chain.length,2);
  assert.equal((await resolveRemoteRedirects('https://join.example/room',{fetchFn:async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1:3000/'}})})).reason,'local-or-invalid-redirect');
  assert.equal((await resolveRemoteRedirects('https://join.example/room',{fetchFn:async()=>new Response('',{status:302,headers:{location:'http://192.168.1.9:3000/'}})})).reason,'private-redirect');
  let n=0;
  const loop=async()=>new Response('',{status:302,headers:{location:'https://loop.example/'}});
  assert.equal((await resolveRemoteRedirects('https://loop.example/',{fetchFn:loop,maxRedirects:2})).reason,'redirect-loop');
});

test('probe admits a verified game, a vanilla game, and a redirect target; rejects non-game pages',async()=>{
  const ok=await probe();
  assert.equal(ok.valid,true); assert.equal(ok.verification,'verified'); assert.equal(ok.finalUrl,'https://game.example.test/');
  assert.equal(ok.assetMatch,true);

  const vanilla=await probe({fetchFn:fakeFetch({ok:true,app:APP_VERSION,version:PROTOCOL_VERSION})});
  assert.equal(vanilla.valid,true); assert.equal(vanilla.verification,'compatible-unknown');
  assert.equal(vanilla.compatible,null); assert.ok(vanilla.warnings.includes('health-fingerprint-missing'));

  const mismatch=await probe({fetchFn:fakeFetch({...fields,app:'9.0.0'})});
  assert.equal(mismatch.valid,true); assert.equal(mismatch.verification,'compatible-unknown');
  assert.ok(mismatch.warnings.includes('version-mismatch'));

  const noWs=await probe({checkWs:async()=>false});
  assert.equal(noWs.valid,false); assert.equal(noWs.game,true); assert.equal(noWs.reason,'ws-unavailable');

  const badPage=await probe({fetchFn:fakeFetch(fields,'<script type="module" src="other.js"></script>')});
  assert.equal(badPage.valid,false); assert.equal(badPage.game,false); assert.equal(badPage.reason,'invalid-game-page');

  const unhealthy=await probe({fetchFn:fakeFetch({...fields,ok:false})});
  assert.equal(unhealthy.valid,true); assert.equal(unhealthy.verification,'incompatible');

  const redirect=await probeRemoteGame('https://join.example/room',{fetchFn:async url=>{
    const u=String(url);
    if(u==='https://join.example/room') return new Response('',{status:302,headers:{location:'https://game.example.test/'}});
    if(u.includes('healthz')) return new Response(JSON.stringify(fields),{status:200});
    return new Response(page,{status:200});
  },checkWs:async base=>base==='https://game.example.test/'});
  assert.equal(redirect.valid,true); assert.equal(redirect.finalUrl,'https://game.example.test/');
  assert.ok(redirect.redirectOrigins.includes('https://game.example.test'));

  const tls=await probe({fetchFn:async()=>{throw new Error('certificate verification failed');}});
  assert.equal(tls.blocked,true); assert.equal(tls.valid,false);
  const loop=await probeRemoteGame('https://join.example/room',{fetchFn:async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/'}})});
  assert.equal(loop.reason,'local-or-invalid-redirect'); assert.equal(loop.blocked,false);
});

test('host guard accepts loopback/LAN Host headers and rejects a rebinding host',()=>{
  const req=(host,local,port='3000')=>({headers:{host},socket:{localAddress:local,localPort:port}});
  assert.equal(isLocalHostHeader(req('127.0.0.1:3000','127.0.0.1')),true);
  assert.equal(isLocalHostHeader(req('localhost:3000','127.0.0.1')),true);
  assert.equal(isLocalHostHeader(req('10.0.2.15:3000','10.0.2.15')),true);
  assert.equal(isLocalHostHeader(req('evil.example:3000','127.0.0.1')),false);
  assert.equal(isLocalHostHeader(req('[::1]:3000','::1')),true);
});

test('control routes reject LAN callers, hostile Origin, missing token and disabled proxy',async()=>{
  const proxy=createProxyState();
  const router=createRemoteRouter({host:'0.0.0.0',getPort:()=>3000,proxy,wsProxy:true,
    probe:async()=>({reachable:true,valid:true,proxyable:false,game:true,verification:'verified',
      finalUrl:'https://game.test/',reason:'game'}),
    assetTargets:async()=>({origins:['https://game.test'],prefixes:[''],manifests:[],finalUrl:'https://game.test/',assetMatch:null})});
  async function call(address,url,origin,headers={}){
    const req={method:'GET',socket:{remoteAddress:address},headers:{host:'127.0.0.1:3000',...(origin?{origin}:{}),...headers}};
    const res={setHeader(){},writeHead(status){this.statusCode=status;},end(v){this.body=JSON.parse(v);}};
    const u=new URL(url,'http://local/');await router(req,res,{rawPath:u.pathname,query:u.search.slice(1)});return res;
  }
  assert.equal((await call('127.0.0.1','/connect/info')).body.lanAvailable,true);
  assert.equal((await call('192.168.0.2','/sp-remote?url=https://game.test')).statusCode,403);
  assert.equal((await call('127.0.0.1','/sp-remote?url=https://game.test','https://evil.test')).statusCode,403);
  assert.equal((await call('127.0.0.1','/sp-remote?url=https://game.test')).statusCode,409);
  assert.equal(proxy.target,null);
  const token=(await call('127.0.0.1','/connect/token')).body.token;
  assert.equal((await call('127.0.0.1','/connect/session?url=https://game.test')).statusCode,403);
  assert.equal((await call('127.0.0.1','/connect/session?url=https://game.test',null,{'x-sp-control':token})).body.ok,true);
  const res={setHeader(){},writeHead(status){this.statusCode=status;},end(v){this.body=JSON.parse(v);}};
  await createRemoteRouter({proxy})({method:'GET',socket:{remoteAddress:'127.0.0.1'},headers:{}},res,{rawPath:'/sp-remote',query:''});assert.equal(res.statusCode,404);
});

test('proxy queues early hello and forwards text/binary; clearing closes both sockets',async()=>{
  const upstream=http.createServer();const echo=new WebSocketServer({noServer:true});
  upstream.on('upgrade',(req,sock,head)=>setTimeout(()=>echo.handleUpgrade(req,sock,head,ws=>{
    ws.on('message',(data,binary)=>ws.send(data,{binary}));
  }),120));
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const state=createProxyState();state.target=`ws://127.0.0.1:${upstream.address().port}/ws`;
  const server=http.createServer();const bridge=createWsProxy({proxy:state,enabled:true});server.on('upgrade',(req,sock,head)=>bridge.upgrade(req,sock,head));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);client.on('error',()=>{});
  try {
    await once(client,'open');
    let received=once(client,'message');client.send('hello-before-upstream');let [data,binary]=await received;assert.equal(data.toString(),'hello-before-upstream');assert.equal(binary,false);
    received=once(client,'message');client.send(Buffer.from([0,255,34]));[data,binary]=await received;assert.deepEqual([...data],[0,255,34]);assert.equal(binary,true);
    const closed=once(client,'close');state.clear();await closed;assert.equal(state.sockets.size,0);
  } finally {client.terminate();bridge.close();for(const socket of echo.clients)socket.terminate();echo.close();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));}
});

test('queue overflow terminates pending remote handshakes',async()=>{
  const upstream=http.createServer();const pending=new Set();upstream.on('upgrade',(_req,socket)=>{pending.add(socket);socket.on('error',()=>{});});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const state=createProxyState();state.target=`ws://127.0.0.1:${upstream.address().port}/ws`;
  const server=http.createServer();const bridge=createWsProxy({proxy:state,enabled:true,limits:{timeoutMs:500,frames:1,bytes:20,payload:65536}});server.on('upgrade',(req,sock,head)=>bridge.upgrade(req,sock,head));server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);client.on('error',()=>{});
  await once(client,'open');const closed=once(client,'close');client.send('one');client.send('two');await closed;assert.equal(state.sockets.size,0);bridge.close();for(const socket of pending)socket.destroy();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));
});

test('injected upstream server preserves health, static resources and normal hello protocol',async()=>{
  const server=await startServer({host:'127.0.0.1',port:0,quiet:true});let client;
  try {
    const health=await (await fetch(`${server.url}/healthz`)).json();assert.equal(health.app,APP_VERSION);assert.equal(health.version,PROTOCOL_VERSION);assert.equal(health.protocol,PROTOCOL_VERSION);assert.match(health.compat,/^[a-f0-9]{64}$/);
    assert.equal((await fetch(`${server.url}/`)).status,200);
    assert.equal((await fetch(`${server.url}/js/connect.js`)).status,200);
    const info=await (await fetch(`${server.url}/connect/info`)).json();assert.equal(info.port,server.port);assert.ok(Array.isArray(info.lan));assert.equal(info.lanAvailable,false);
    assert.equal((await fetch(`${server.url}/sp-remote?url=`)).status,404);
    client=new WebSocket(server.url.replace('http:','ws:')+'/ws');client.on('error',()=>{});await once(client,'open');const welcome=once(client,'message');client.send(JSON.stringify({t:'hello',rid:1,name:'Doctor',version:PROTOCOL_VERSION}));assert.equal(JSON.parse((await welcome)[0]).t,'welcome');
  } finally {client?.terminate();await server.close();}
});

test('asset targets discover an absolute art host and its path prefix from the remote manifests',async()=>{
  const fetchFn=async (url)=>{
    const path=new URL(String(url)).pathname;
    const body=path.endsWith('local-assets.json')
      ? {groups:{'emoticon/basic':{x:{path:'https://local.example/Stronghold-Protocol/assets/local/x.png'}}}}
      : {chars:{x:{avatar:'https://local.example/Stronghold-Protocol/assets/char/x.png'}}};
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  };
  const targets=await remoteAssetTargets('https://game.example/Stronghold-Protocol/',{fetchFn});
  assert.ok(targets.origins.includes('https://local.example'));
  assert.ok(targets.origins.includes('https://game.example'));
  assert.ok(targets.prefixes.includes('/Stronghold-Protocol'));
  assert.deepEqual(targets.manifests.sort(),['assets.json','local-assets.json']);
});

test("asset targets honor the remote build's js/asset-cdn.js CDN declaration",async()=>{
  const fetchFn=async (url)=>{
    const u=String(url);
    if(u.endsWith('/js/asset-cdn.js')) return {ok:true,url:u,async text(){return `export const ASSETS_CDN = "https://local.example/Game";\nexport const DATA_CDN = "https://local.example/Game";\n`;}};
    if(u==='https://local.example/Game/data/assets.json') return {ok:true,url:u,async json(){return {chars:{x:{avatar:'https://local.example/Game/assets/char/x.png'}}};}};
    if(u==='https://local.example/Game/data/local-assets.json') return {ok:true,url:u,async json(){return {groups:{x:{path:'https://local.example/Game/assets/local/x.png'}}};}};
    return {ok:false,url:u,async text(){return '';},async json(){return {};}};
  };
  const targets=await remoteAssetTargets('https://game.example/',{fetchFn});
  assert.ok(targets.origins.includes('https://local.example'));
  assert.ok(targets.prefixes.includes('/Game'));
  assert.ok(targets.manifests.includes('assets.json'));
});

test('asset targets follow an http to https redirect and keep the final origin',async()=>{
  const fetchFn=async (url)=>({
    ok:true,
    url:String(url).replace('http://game.example/','https://game.example/'),
    async json(){return {chars:{x:{avatar:'/assets/char/x.png'}}};},
  });
  const targets=await remoteAssetTargets('http://game.example/',{fetchFn});
  assert.ok(targets.origins.includes('http://game.example'));
  assert.ok(targets.origins.includes('https://game.example'));
  assert.ok(targets.prefixes.includes(''));
});

test('asset targets use the remote manifest hash to confirm strict art matching',async()=>{
  const fetchFn=async (url)=>{
    const u=String(url);
    if(u.endsWith('/data/assets.json')) return new Response(JSON.stringify({version:1,hash:'d885b22d8f78',chars:{x:{avatar:'/assets/char/x.png'}}}),{status:200});
    if(u.endsWith('/data/local-assets.json')) return new Response(JSON.stringify({version:1,groups:{}}),{status:200});
    return new Response('',{status:404});
  };
  const targets=await remoteAssetTargets('https://game.example/',{fetchFn,expectedAssetHash:'d885b22d8f78'});
  assert.equal(targets.assetMatch,true);
  const other=await remoteAssetTargets('https://game.example/',{fetchFn,expectedAssetHash:'000000000000'});
  assert.equal(other.assetMatch,false);
});

test('remote art mode defaults to local-first and strict stays explicit',()=>{
  assert.equal(readRemoteArtMode(),'local-first');
});

test('verified connections pass the requested entry URL and final origin to the Android bridge',async()=>{
  const calls=[];
  const bridge={openRemoteWithArt(url,mode,match,payload){calls.push([url,mode,match,JSON.parse(payload)]);return true;}};
  const options={bridge,probe:async()=>({valid:true,game:true,verification:'verified',finalUrl:'https://game.test/',
    origins:['https://game.test','https://cdn.test'],prefixes:['','/Stronghold-Protocol'],manifests:['assets.json'],assetMatch:true}),
    discover:async()=>({origins:['https://game.test'],prefixes:[''],manifests:[],assetMatch:null}),
    configure:async()=>{throw new Error('proxy must not be used');},clear:async()=>({ok:true}),
    confirm:async()=>{throw new Error('verified servers do not prompt');},alert:async()=>{throw new Error('no alert');},
    navigate:()=>{throw new Error('Android bridge must open the page');},localUrl:'http://127.0.0.1:3000/'};
  assert.equal(await selectRemoteTarget('https://join.test/room',options),'remote-art');
  assert.equal(calls[0][0],'https://join.test/room');
  assert.equal(calls[0][1],'local-first');
  assert.equal(calls[0][2],true);
  assert.equal(calls[0][3].finalUrl,'https://game.test/');
  assert.equal(calls[0][3].gameOrigin,'https://game.test');
  assert.deepEqual(calls[0][3].assetOrigins,['https://game.test','https://cdn.test']);
  assert.equal(calls[0][3].collectStats,true);
});

test('unknown servers prompt once per origin per app run; non-game pages are rejected',async()=>{
  const store=new Map();
  globalThis.sessionStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),clear:()=>store.clear()};
  let prompts=0;const calls=[];
  const bridge={openRemoteWithArt(url,mode,match,payload){calls.push(url);return true;}};
  const unknown={bridge,probe:async()=>({valid:true,game:true,verification:'compatible-unknown',finalUrl:'https://game.test/',
    origins:['https://game.test'],prefixes:['']}),confirm:async()=>{prompts++;return true;},alert:async()=>{},
    clear:async()=>({ok:true}),localUrl:'http://127.0.0.1:3000/'};
  assert.equal(await selectRemoteTarget('https://join.test/a',unknown),'remote-art');
  assert.equal(await selectRemoteTarget('https://join.test/b',unknown),'remote-art');
  assert.equal(prompts,1);
  let alerts=0;const rejected={...unknown,probe:async()=>({valid:false,game:false,reason:'invalid-game-page',finalUrl:'https://evil.test/'}),alert:async()=>{alerts++;}};
  assert.equal(await selectRemoteTarget('https://evil.test/',rejected),'rejected');
  assert.equal(alerts,1);assert.equal(calls.length,2);
  const loop={...unknown,probe:async()=>({valid:false,reachable:true,reason:'local-or-invalid-redirect',finalUrl:'http://127.0.0.1:3000/'})};
  assert.equal(await selectRemoteTarget('https://join.test/c',loop),'rejected');
  store.clear();
});

test('legacy bridge opens the requested URL directly; a failed bridge is reported, never a generic page',async()=>{
  let opened='';const legacy={bridge:{openRemote(url){opened=url;}},probe:async()=>({valid:true,game:true,verification:'verified',finalUrl:'https://game.test/'}),
    clear:async()=>({ok:true}),localUrl:'http://127.0.0.1:3000/'};
  assert.equal(await selectRemoteTarget('https://join.test/room',legacy),'remote-page');
  assert.equal(opened,'https://join.test/room');
  let alerts=0;const failed={...legacy,bridge:{openRemoteWithArt(){return false;}},alert:async()=>{alerts++;}};
  assert.equal(await selectRemoteTarget('https://join.test/room',failed),'failed');assert.equal(alerts,1);
});

test('title retains upstream default and only loopback gets dual entry; Android guide is not duplicated',async()=>{
  const title=await fs.readFile(new URL('../public/js/screens/title.js',import.meta.url),'utf8');
  const lobby=await fs.readFile(new URL('../public/js/screens/lobby.js',import.meta.url),'utf8');
  const settings=await fs.readFile(new URL('../public/js/ui/settings.js',import.meta.url),'utf8');
  const entry=await fs.readFile(new URL('../public/js/ui/remote-entry.js',import.meta.url),'utf8');
  assert.ok(title.includes('isLoopbackHost() ? html`'));assert.ok(title.includes("${t('开始')}"));assert.ok(title.includes('androidBridge() ? html`<${RemoteGuideButton}'));
  assert.ok(lobby.includes('isLoopbackHost() && !androidBridge()'));
  assert.ok(settings.includes('RemoteSettingsSection'));
  assert.ok(!entry.includes('entry-art-mode'));
});

test('Android art interceptor answers CORS: ACAO on 200/206 and an OPTIONS preflight branch',async()=>{
  const java=await fs.readFile(new URL('../mobile/android/java/io/prts/stronghold/MainActivity.java',import.meta.url),'utf8');
  const start=java.indexOf('private WebResourceResponse interceptLocalArt');
  const end=java.indexOf('/** L0 is served straight from the APK');
  assert.ok(start>0&&end>start);
  const cors=java.slice(start,end);
  assert.ok(cors.includes('boolean preflight = "OPTIONS"'));
  assert.ok(cors.includes('if (preflight) return preflightResponse(request);'));
  assert.equal((cors.match(/addCorsHeaders\(headers\);/g)||[]).length,2);
  assert.ok(cors.includes('headers.put("Access-Control-Allow-Origin", "*");'));
  assert.ok(cors.includes('headers.put("Access-Control-Expose-Headers"'));
  assert.ok(cors.includes('headers.put("Cross-Origin-Resource-Policy", "cross-origin");'));
  assert.ok(cors.includes('headers.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");'));
  assert.ok(cors.includes('headers.put("Access-Control-Max-Age", "86400");'));
  assert.ok(cors.includes('headerValue(request, "Access-Control-Request-Headers")'));
});

test('records archive: guards, ingest dedupe, caps and the token-guarded route shapes',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sp-rec-'));
  const file=path.join(dir,'remote-records.json');
  assert.deepEqual(loadRecordsDoc(file),{servers:{}});
  const payload={origin:'https://game.test',host:'game.test',app:'0.3.0',verification:'compatible-unknown',
    records:[{id:'a',t:1},{id:'b',t:2},{id:'a',t:9}]};
  const first=ingestRecords(loadRecordsDoc(file),payload);
  assert.equal(first.added,2);
  saveRecordsDoc(file,first.doc);
  assert.equal(ingestRecords(loadRecordsDoc(file),payload).added,0);
  assert.equal(ingestRecords(loadRecordsDoc(file),{origin:'notaurl',records:[{id:'z'}]}).added,0);
  const doc=loadRecordsDoc(file);
  assert.equal(doc.servers['https://game.test'].records.length,2);
  assert.equal(doc.servers['https://game.test'].app,'0.3.0');
  const many={origin:'https://game.test',records:Array.from({length:RECORDS_LIMITS.perServer+40},(_,i)=>({id:'x'+i}))};
  const trimmed=trimRecordsDoc(ingestRecords(doc,many).doc);
  assert.equal(trimmed.servers['https://game.test'].records.length,RECORDS_LIMITS.perServer);
  const crowded={servers:Object.fromEntries(Array.from({length:RECORDS_LIMITS.servers+3},(_,i)=>[`https://s${i}.test`,{host:'s'+i,lastSeen:i,records:[]}] ))};
  const evicted=trimRecordsDoc(crowded);
  assert.equal(Object.keys(evicted.servers).length,RECORDS_LIMITS.servers);
  assert.ok(!evicted.servers['https://s0.test']);
  const mirror=path.join(dir,'remote-records-mirror.json');
  const router=createRemoteRouter({host:'127.0.0.1',getPort:()=>3000,proxy:createProxyState(),recordsFile:file,recordsMirrorFile:mirror});
  async function call(address,url,origin,headers={},method='GET',body=null){
    const req={method,socket:{remoteAddress:address},headers:{host:'127.0.0.1:3000',...(origin?{origin}:{}),...headers},
      on(ev,cb){ if(ev==='data'&&body)cb(Buffer.from(body)); if(ev==='end')setImmediate(cb); return req; },destroy(){}};
    const res={setHeader(){},writeHead(status){this.statusCode=status;},end(v){this.body=v?JSON.parse(v):null;}};
    const u=new URL(url,'http://local/');await router(req,res,{rawPath:u.pathname,query:u.search.slice(1)});return res;
  }
  assert.equal((await call('192.168.0.2','/connect/records')).statusCode,403);
  assert.equal((await call('127.0.0.1','/connect/records','https://evil.test')).statusCode,403);
  assert.equal((await call('127.0.0.1','/connect/records')).statusCode,403);
  const token=(await call('127.0.0.1','/connect/token')).body.token;
  const auth={'x-sp-control':token};
  const ids=await call('127.0.0.1','/connect/records?ids=1&origin=https://game.test',null,auth);
  assert.deepEqual([...ids.body.ids].sort(),['a','b']);
  const posted=await call('127.0.0.1','/connect/records',null,auth,'POST',JSON.stringify({origin:'https://game.test',records:[{id:'c'}]}));
  assert.equal(posted.body.added,1);
  assert.ok(JSON.parse(await fs.readFile(mirror,'utf8')).servers['https://game.test'].records.some((r)=>r.id==='c'));
  await fs.rm(file);
  const fromMirror=await call('127.0.0.1','/connect/records?ids=1&origin=https://game.test',null,auth);
  assert.ok(fromMirror.body.ids.includes('c'));
  assert.equal((await call('127.0.0.1','/connect/records',null,auth,'POST','{')).statusCode,400);
  const deleted=await call('127.0.0.1','/connect/records?origin=https://game.test',null,auth,'DELETE');
  assert.equal(deleted.body.ok,true);
  assert.deepEqual(loadRecordsDoc(file).servers,{});
  assert.deepEqual(JSON.parse(await fs.readFile(mirror,'utf8')).servers,{});
  await fs.rm(dir,{recursive:true,force:true});
});

test('records archive keeps a .bak and an external mirror; repairs prefer the freshest copy',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sp-rec-mirror-'));
  const file=path.join(dir,'remote-records.json');
  const mirror=path.join(dir,'external','remote-records.json');
  const first={servers:{'https://game.test':{host:'game.test',lastSeen:1,records:[{id:'a',collectedAt:1,raw:{id:'a'}}]}}};
  const second={servers:{'https://game.test':{host:'game.test',lastSeen:2,records:[{id:'a',collectedAt:1,raw:{id:'a'}},{id:'b',collectedAt:2,raw:{id:'b'}}]}}};
  saveRecordsDoc(file,first,mirror);
  saveRecordsDoc(file,second,mirror);
  assert.deepEqual(loadRecordsDoc(file,mirror),second);
  assert.deepEqual(loadRecordsDoc(`${file}.bak`,null),first);
  assert.deepEqual(loadRecordsDoc(mirror,null),second);
  await fs.rm(file);
  assert.deepEqual(loadRecordsDoc(file,mirror),second,'the mirror is newer than .bak');
  await fs.writeFile(file,'{not json','utf8');
  assert.deepEqual(loadRecordsDoc(file,mirror),second);
  const damaged=(await fs.readdir(dir)).filter((x)=>x.startsWith('remote-records.json.damaged-'));
  assert.equal(damaged.length,1);
  const bakBefore=await fs.readFile(`${file}.bak`,'utf8');
  saveRecordsDoc(file,first,mirror);
  assert.equal(await fs.readFile(`${file}.bak`,'utf8'),bakBefore,'a corrupt primary must not replace a good .bak');
  await fs.rm(dir,{recursive:true,force:true});
});

test('Android stats bridge is authoritative and survives a WebView storage wipe',async()=>{
  const { loadStats, saveStats }=await import('../public/js/ui/stats.js');
  const previousLS=globalThis.localStorage;
  const previousBridge=globalThis.SP_BRIDGE;
  const storage=new Map();
  const ls={
    getItem:(k)=>(storage.has(k)?storage.get(k):null),
    setItem:(k,v)=>{storage.set(k,String(v));},
    removeItem:(k)=>{storage.delete(k);},
    clear:()=>storage.clear(),
  };
  let bridgeRaw=null;
  let writeOk=true;
  const bridge={
    readLocalStats:()=>bridgeRaw,
    writeLocalStats:(raw)=>{if(!writeOk)return false;bridgeRaw=String(raw);return true;},
    removeLocalStats:()=>{bridgeRaw=null;return true;},
  };
  const record={id:'r1.bridge',v:2,t:1,end:'settled',victory:true,roundsPassed:1,reason:'victory',
    modeId:'mode_single_funny',difficulty:'FUNNY',stageId:'act1autochess_m01',selfId:'me',
    players:[{playerId:'me',seat:0,name:'Doctor',isBot:false,alive:true,victory:true,roundsPassed:1,lp:28,stats:{}}]};
  try{
    globalThis.localStorage=ls;
    globalThis.SP_BRIDGE=bridge;
    assert.equal(saveStats({v:2,records:[record]}),true);
    assert.ok(bridgeRaw.includes('r1.bridge'));
    assert.ok(storage.get('sp.pref.stats').includes('r1.bridge'));
    // the WebView store is wiped (update / origin change); the device file still answers
    storage.clear();
    assert.equal(loadStats().records[0].id,'r1.bridge');
    // a user clear writes an empty envelope; the old localStorage copy must not resurrect records
    assert.equal(saveStats({v:2,records:[]}),true);
    assert.equal(JSON.parse(bridgeRaw).records.length,0);
    storage.set('sp.pref.stats',JSON.stringify({v:2,records:[record]}));
    assert.equal(loadStats().records.length,0);
    // a rejected bridge write falls back to browser storage instead of losing the save
    writeOk=false;
    storage.clear();
    assert.equal(saveStats({v:2,records:[record]}),true);
    assert.ok(storage.get('sp.pref.stats').includes('r1.bridge'));
    // without the bridge the module is the plain browser implementation
    writeOk=true;
    globalThis.SP_BRIDGE=undefined;
    storage.clear();
    assert.equal(saveStats({v:2,records:[record]}),true);
    assert.ok(storage.get('sp.pref.stats').includes('r1.bridge'));
    assert.equal(loadStats().records[0].id,'r1.bridge');
  }finally{
    globalThis.localStorage=previousLS;
    globalThis.SP_BRIDGE=previousBridge;
  }
});

test('remote records view groups by server and merged records keep their source tag',async()=>{
  const { groupServers, prepareMerge }=await import('../public/js/ui/remote-records.js');
  const doc={servers:{
    'https://b.test':{host:'b.test',lastSeen:5,records:[{id:'1',collectedAt:5,raw:{id:'1',t:5,victory:true,difficulty:1,roomMode:'solo',roundsPassed:3,selfId:'me',players:[{playerId:'me',seat:1,name:'Doctor',isBot:false,alive:true,victory:true,roundsPassed:3,lp:28,stats:{}}]}}]},
    'https://a.test':{host:'a.test',lastSeen:9,records:[{id:'2',collectedAt:9,raw:{id:'2',t:9}}]}}};
  const groups=groupServers(doc);
  assert.equal(groups[0].origin,'https://a.test');
  assert.equal(groups[1].label,'b.test');
  const payload=prepareMerge(groups[1]);
  assert.equal(payload.kind,'local-stats');
  assert.equal(payload.records[0].src.origin,'https://b.test');
  assert.equal(payload.records[0].src.collectedAt,5);
  const { migrateStats, compactRecord }=await import('../public/js/ui/stats.js');
  const migrated=migrateStats(payload);
  assert.equal(migrated.newer,false);
  assert.equal(migrated.stats.records[0].src.host,'b.test');
  assert.equal(compactRecord(migrated.stats.records[0]).src.host,'b.test');
});

test('staged sources carry the collection engine, the stats entry and the i18n keys',async()=>{
  const java=await fs.readFile(new URL('../mobile/android/java/io/prts/stronghold/MainActivity.java',import.meta.url),'utf8');
  for(const marker of ['[sp-stats-dirty]','installRemoteStatsHook','runStatsPull','collectStats','/connect/records',
    '正在同步服务器对战数据',':(?:443|80)$']) assert.ok(java.includes(marker),marker);
  for(const marker of ['local-stats.json','readLocalStats','writeLocalStats','removeLocalStats','migrateLocalStats',
    '[stats-store]','SP_EXTERNAL_FILES','isLocalBridgeAllowed','exportStats','MediaStore.Downloads',
    'ACTION_CREATE_DOCUMENT','onShowFileChooser','onActivityResult','blocked remote file chooser',
    'deleteRecursively(new File(dir, part))']) assert.ok(java.includes(marker),marker);
  const screen=await fs.readFile(new URL('../public/js/screens/stats.js',import.meta.url),'utf8');
  assert.ok(screen.includes('RemoteRecordsTab'));
  assert.ok(screen.includes("id: 'remote'"));
  assert.ok(screen.includes('stats-remote'));
  assert.ok(screen.includes('openStats(tab'));
  assert.ok(screen.includes("empty && tab !== 'remote'"));
  assert.ok(screen.includes('removeLocalStats'));
  assert.ok(screen.includes('bridge.exportStats'));
  const ui=await fs.readFile(new URL('../public/js/ui/stats.js',import.meta.url),'utf8');
  assert.ok(ui.includes('rec.src'));
  assert.ok(ui.includes("'testActions', 'src']"));
  assert.ok(ui.includes('readLocalStats'));
  assert.ok(ui.includes('writeLocalStats'));
  const remote=await fs.readFile(new URL('../server/http/remote.js',import.meta.url),'utf8');
  assert.ok(remote.includes('recordsMirrorFile'));
  const en=await fs.readFile(new URL('../public/i18n/en.json',import.meta.url),'utf8');
  assert.ok(en.includes('"远程记录"'));
  assert.ok(en.includes('"导出失败"'));
  const routes=await fs.readFile(new URL('../server/http/routes.js',import.meta.url),'utf8');
  const mount=routes.indexOf('await handleRemote(req, res, parts)');
  const gate=routes.indexOf("req.method !== 'GET'");
  assert.ok(mount > -1 && gate > -1 && mount < gate,'handleRemote must mount before the GET/HEAD method gate');
});
