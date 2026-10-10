import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { startServer } from '../server/index.js';
import { APP_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { normalizeRemoteUrl } from '../shared/connect.js';
import { probeRemoteGame, remoteWsUrl, remoteHealth, createRemoteRouter, createProxyState, createWsProxy } from '../server/http/remote.js';
import { selectRemoteTarget } from '../public/js/remote-session.js';

const fields = { ok:true, app: APP_VERSION, version:PROTOCOL_VERSION, ...remoteHealth() };
const page = '<div id="app"></div><script type="module" src="/js/main.js"></script>';
const fakeFetch=(health=fields,body=page)=>async url=>new Response(String(url).includes('healthz') ? JSON.stringify(health):body);
const probe=(options={})=>probeRemoteGame('https://game.example.test/',{fetchFn:fakeFetch(),checkWs:async()=>true,...options});

test('URL validation blocks loopback, credentials, invalid schemes and empty ports; accepts IPv6 and custom ports',()=>{
  for(const url of ['http://localhost','http://127.0.0.1','http://127.2.3.4','http://[::1]','http://[::ffff:127.0.0.1]','file://game.test','https://u:p@game.test','https://game.test:','https://game.test:0','http://0x7f000001','http://2130706433']) assert.equal(normalizeRemoteUrl(url),null,url);
  assert.ok(normalizeRemoteUrl('https://[2001:db8::2]:8443/'));
  assert.equal(remoteWsUrl('https://game.test:8443/'),'wss://game.test:8443/ws');
  assert.equal(remoteWsUrl('ws://game.test:8080/ws'),'ws://game.test:8080/ws');
});

test('strict probe checks numeric protocol, compatibility, assets, game page and real WS availability',async()=>{
  assert.equal((await probe()).proxyable,true);
  for(const change of [{app:'9.0.0'},{version:99,protocol:99},{compat:'different'}]) assert.equal((await probe({fetchFn:fakeFetch({...fields,...change})})).reason,'version-mismatch');
  const missing={...fields};delete missing.compat;
  assert.equal((await probe({fetchFn:fakeFetch(missing)})).reason,'health-missing');
  const assets=await probe({fetchFn:fakeFetch({...fields,assets:'other-assets'})});
  assert.equal(assets.proxyable,true);assert.equal(assets.assetMatch,false);
  assert.equal((await probe({fetchFn:fakeFetch(fields,'<script type="module" src="other.js"></script>')})).reason,'invalid-game-page');
  assert.equal((await probe({checkWs:async()=>false})).reason,'ws-unavailable');
  const tls=await probe({fetchFn:async()=>{throw new Error('certificate verification failed');}});
  assert.equal(tls.blocked,true);assert.equal(tls.proxyable,false);
  assert.equal((await probe({fetchFn:async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/'}})})).reason,'local-or-invalid-redirect');
});

test('control routes reject LAN callers, hostile Origin and disabled proxy; validate before changing target',async()=>{
  const proxy=createProxyState();const router=createRemoteRouter({proxy,wsProxy:true,probe:async()=>({proxyable:false,reason:'version-mismatch'})});
  async function call(address,url,origin){
    const req={method:'GET',socket:{remoteAddress:address},headers:{host:'127.0.0.1:3000',...(origin?{origin}:{})}};
    const res={setHeader(){},writeHead(status){this.statusCode=status;},end(v){this.body=JSON.parse(v);}};
    const u=new URL(url,'http://local/');await router(req,res,{rawPath:u.pathname,query:u.search.slice(1)});return res;
  }
  assert.equal((await call('192.168.0.2','/sp-remote?url=https://game.test')).statusCode,403);
  assert.equal((await call('127.0.0.1','/sp-remote?url=https://game.test','https://evil.test')).statusCode,403);
  assert.equal((await call('127.0.0.1','/sp-remote?url=https://game.test')).statusCode,409);assert.equal(proxy.target,null);
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
    const info=await (await fetch(`${server.url}/connect/info`)).json();assert.equal(info.port,server.port);assert.ok(Array.isArray(info.lan));
    assert.equal((await fetch(`${server.url}/sp-remote?url=`)).status,404);
    client=new WebSocket(server.url.replace('http:','ws:')+'/ws');client.on('error',()=>{});await once(client,'open');const welcome=once(client,'message');client.send(JSON.stringify({t:'hello',rid:1,name:'Doctor',version:PROTOCOL_VERSION}));assert.equal(JSON.parse((await welcome)[0]).t,'welcome');
  } finally {client?.terminate();await server.close();}
});

test('compatible Android connection keeps local page; fallback needs explicit confirmation',async()=>{
  let opened=0;let target='';let confirmed=0;
  const options={bridge:{openRemote(){opened++;}},probe:async()=>({valid:true,proxyable:true}),configure:async()=>({ok:true}),clear:async()=>({ok:true}),localUrl:'http://127.0.0.1:3000/',navigate:url=>{target=url;}};
  assert.equal(await selectRemoteTarget('https://game.test/?join=ABCD',options),'proxy');assert.equal(target,'http://127.0.0.1:3000/?join=ABCD');assert.equal(opened,0);
  const failed={...options,probe:async()=>({valid:false,reason:'version-mismatch'}),confirm:async()=>{confirmed++;return false;}};
  assert.equal(await selectRemoteTarget('https://game.test/',failed),'cancelled');assert.equal(opened,0);assert.equal(confirmed,1);
  assert.equal(await selectRemoteTarget('https://game.test/',{...failed,confirm:async()=>true}),'fallback');assert.equal(opened,1);
});

test('title retains upstream default and only loopback gets dual entry; Android guide is not duplicated',async()=>{
  const title=await fs.readFile(new URL('../public/js/screens/title.js',import.meta.url),'utf8');
  const lobby=await fs.readFile(new URL('../public/js/screens/lobby.js',import.meta.url),'utf8');
  assert.ok(title.includes('isLoopbackHost() ? html`'));assert.ok(title.includes("${t('开始')}"));assert.ok(title.includes('androidBridge() ? html`<${RemoteGuideButton}'));
  assert.ok(lobby.includes('isLoopbackHost() && !androidBridge()'));
});
