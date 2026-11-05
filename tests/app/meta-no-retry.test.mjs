import { test } from 'node:test';
import assert from 'node:assert/strict';
// Isolated test-file process. Force dummy/unreachable BEFORE loading the credential-aware adapter.
process.env.META_BASE_URL='http://127.0.0.1:1/v1';
process.env.META_API_KEY='DUMMY';
process.env.META_MODEL_RETRIES='1';
const {client}=await import('../../backend/lib/meta.js');
const failure=()=>new Response(JSON.stringify({error:{message:'model was not found'}}),{status:404,headers:{'content-type':'application/json'}});

test('per-call maxRetries zero also disables the model-404 retry layer',async()=>{
  const original=client.fetch;let calls=0;
  client.fetch=async()=>{calls++;if(calls>1)throw Error('local fake-call cap');return failure();};
  try {
    await assert.rejects(client.responses.create({model:'sam-3.1',input:[]},{maxRetries:0}));
    assert.equal(calls,1);
  } finally {client.fetch=original;}
});
test('ordinary calls retain the configured model-404 retry behaviour',async()=>{
  const original=client.fetch;let calls=0;
  client.fetch=async()=>{calls++;return calls===1?failure():new Response('{"id":"synthetic-success"}',{headers:{'content-type':'application/json'}});};
  try {
    const result=await client.responses.create({model:'sam-3.1',input:[]});
    assert.equal(result.id,'synthetic-success');assert.equal(calls,2);
  } finally {client.fetch=original;}
});
