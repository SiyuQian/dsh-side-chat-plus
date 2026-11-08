import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHandler} from '../src/http.js';

async function request({headers={},body={action:'models'},method='POST',remoteAddress='127.0.0.1',service}={}) {
  let status, result;
  const req=Readable.from([typeof body==='string'?body:JSON.stringify(body)]);
  Object.assign(req,{headers:{host:'127.0.0.1:63901',origin:'http://127.0.0.1:63901','sec-fetch-site':'same-origin','content-type':'application/json',...headers},method,socket:{remoteAddress}});
  const res={writeHead(s){status=s;},end(text){result=JSON.parse(text);}};
  await createHandler(service ?? {models:async()=>[{provider:'p',model:'m'}]})(req,res);
  return {status,...result};
}

test('same-origin loopback JSON requests reach the explicit operation allowlist',async()=>{
  assert.deepEqual(await request(),{status:200,ok:true,value:[{provider:'p',model:'m'}]});
  assert.equal((await request({body:{action:'constructor'}})).status,400);
  assert.equal((await request({body:{action:'dispose'}})).status,400);
});
test('HTTP rejects cross-origin ports, opaque origins, rebinding hosts, missing origins and remote sockets',async()=>{
  for(const changes of [{headers:{origin:'http://127.0.0.1:63902'}},{headers:{origin:'null'}},{headers:{origin:'https://127.0.0.1:63901'}}, {headers:{host:'evil.example',origin:'http://evil.example'}},{headers:{origin:undefined}},{remoteAddress:'192.168.1.2'},{headers:{'sec-fetch-site':'cross-site'}}]) {
    assert.equal((await request(changes)).status,403);
  }
});
test('HTTP rejects non-POST, simple-form bodies, malformed JSON and oversized requests',async()=>{
  assert.equal((await request({method:'GET'})).status,405);
  assert.equal((await request({headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await request({body:'{bad'})).status,400);
  assert.equal((await request({body:'x'.repeat(100000)})).status,413);
});
test('service errors return controlled messages without stacks',async()=>{
  const result=await request({service:{models:async()=>{throw Error('catalog offline');}}});
  assert.equal(result.ok,false);
  assert.equal(result.error,'catalog offline');
  assert.equal('stack' in result,false);
});
