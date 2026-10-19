const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { AdminStore } = require('../lib/admin-store');
const { ManagedEngine, containsFixedPhrase } = require('../lib/managed-engine');
const { createAdminRouter } = require('../lib/admin-router');
const { resolveTicketIdentity } = require('../lib/ticket-identity');

const base = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(base, '.test-data-'));
  t.after(() => {
    assert.equal(path.dirname(dir), base);
    assert.ok(path.basename(dir).startsWith('.test-data-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new AdminStore(dir);
}
function product(store, name, extra = {}) {
  return store.saveProduct({ name, aliases:[name], queues:['Shared'], ...extra }, 'admin').id;
}
function entry(store, p, kind, value = {}) {
  const revision = store.product(p).revision;
  return store.saveEntry(p, kind, { title:'退款政策', category:'refund', content:'订阅退款期限为 7 天。', tags:['refund','退款'], stage:'all', ...value }, revision, 'admin').id;
}
function publish(store,p) {
  const c = store.content(p);
  return store.publish(p,{revision:c.revision,items:Object.entries(c.pending).flatMap(([kind,ids]) => ids.map(id=>({kind,id})))},'admin');
}

test('drafts, partial atomic publication, isolation, stale edits and rollback', t => {
  const s=fixture(t), a=product(s,'Alpha'), b=product(s,'Beta');
  const k=entry(s,a,'knowledge');
  const template=entry(s,a,'templates',{title:'退款回复',content:'We will review your request.',fixed:['We will review']});
  assert.equal(s.product(a).published.knowledge.length,0);
  assert.equal(s.product(b).draft.knowledge.length,0);
  assert.throws(()=>s.saveEntry(a,'knowledge',{title:'bad',content:'stale'},0,'other'),/刷新/);
  const c=s.content(a);
  s.publish(a,{revision:c.revision,items:[{kind:'knowledge',id:k}]},'admin');
  assert.equal(s.product(a).published.knowledge.length,1);
  assert.equal(s.product(a).published.templates.length,0);
  assert.deepEqual(s.content(a).pending.templates,[template]);
  assert.throws(()=>s.restore(a,{revision:s.product(a).revision,version:1},'admin'),/草稿/);
  publish(s,a);
  entry(s,a,'knowledge',{id:k,content:'期限改为 10 天。'});
  const before=s.product(a).published.knowledge[0].content;
  publish(s,a);
  assert.notEqual(s.product(a).published.knowledge[0].content,before);
  s.restore(a,{revision:s.product(a).revision,version:2},'admin');
  assert.equal(s.product(a).published.knowledge[0].content,before);
  assert.equal(s.product(a).version,4);
  assert.equal(s.content(a).history[0].snapshot,undefined);
  const copy=product(s,'Copy',{copyFrom:a});
  assert.equal(s.product(copy).published.knowledge.length,0);
  entry(s,copy,'knowledge',{id:k,content:'Copy independent.'});
  assert.equal(s.product(a).draft.knowledge[0].content,before);
  const disk=new AdminStore(s.directory);
  assert.equal(disk.product(a).version,4);
  assert.ok(disk.data.audit.some(a=>a.action==='restore'));
});

test('failed publication is transactional; deletion takes effect only on release', t=>{
  const s=fixture(t), p=product(s,'Alpha'), key=entry(s,p,'knowledge');publish(s,p);
  entry(s,p,'knowledge',{id:key,content:'new policy'});
  assert.throws(()=>s.publish(p,{revision:s.product(p).revision,items:[{kind:'knowledge',id:key},{kind:'rules',id:'missing'}]},'admin'));
  assert.equal(s.product(p).published.knowledge[0].content,'订阅退款期限为 7 天。');
  s.deleteEntry(p,'knowledge',key,s.product(p).revision,'admin');
  assert.equal(s.product(p).published.knowledge.length,1);publish(s,p);
  assert.equal(s.product(p).published.knowledge.length,0);
});

test('product identification: aliases, order names, shared queues and conflicts',t=>{
  const s=fixture(t), a=product(s,'Alpha',{aliases:['Photo AI'],orderNames:['SKU-photo']}), b=product(s,'Beta');
  assert.equal(s.resolveProduct({queue:'Shared'}).product,null);
  assert.equal(s.resolveProduct({queue:'Shared',thread_text:'Photo AI crashes'}).product.id,a);
  assert.equal(s.resolveProduct({order_context:'Purchased SKU-photo'}).product.id,a);
  assert.equal(s.resolveProduct({thread_text:'Alpha refund',order_context:'Beta'}).product,null);
  assert.equal(s.resolveProduct({thread_text:'Alphabet'}).product,null);
  assert.equal(s.resolveProduct({product_id:b,thread_text:'Alpha'}).product.id,b);
  assert.throws(()=>s.resolveProduct({product_id:'unknown'}),/不存在/);
});

test('preview excluded from telemetry; requests see immutable published snapshots',async t=>{
  const s=fixture(t), a=product(s,'Alpha'), b=product(s,'Beta');
  const key=entry(s,a,'knowledge');entry(s,a,'templates',{content:'Thank you for your refund request.'});entry(s,a,'rules',{content:'Do not promise a refund.'});publish(s,a);
  entry(s,b,'knowledge',{content:'BETA PRIVATE POLICY'});publish(s,b);
  let captured;
  const engine=new ManagedEngine(s,{provider:'test',completion:async system=>{
    captured=system;
    entry(s,a,'knowledge',{id:key,content:'NEW POLICY AFTER INFERENCE STARTED'});publish(s,a);
    return JSON.stringify({category:'refund',summary:'申请退款',draft_reply:'We will review your request.',used_ids:[key,'invented']});
  }});
  const result=await engine.run('generate-draft',{product_id:a,ticket_id:'host:42',thread_text:'refund please'});
  assert.ok(captured.includes('订阅退款期限为 7 天'));
  assert.ok(!captured.includes('BETA PRIVATE POLICY'));
  assert.equal(result.version,1);
  assert.equal(s.product(a).version,2);
  assert.deepEqual(result.used_ids,[key]);
  assert.equal(s.data.events[0].version,1);
  assert.equal(s.data.events[0].references.knowledge[0].content,'订阅退款期限为 7 天。');
  const preview=new ManagedEngine(s,{provider:'mock'});
  await preview.run('generate-draft',{product_id:a,thread_text:'refund'},{preview:true,draft:true});
  assert.equal(s.data.events.length,1);
  await assert.rejects(()=>preview.run('chat',{product_id:a,messages:[]}),/工单编号/);
});

test('ticket identity supports old panel subjects, nested metadata and Znuny semicolon URLs',()=>{
  assert.equal(resolveTicketIdentity({ticket_id:'tickets.internal:42'}),'tickets.internal:42');
  assert.equal(resolveTicketIdentity({thread_context:{ticket_id:'tickets.internal:43'}}),'tickets.internal:43');
  assert.equal(resolveTicketIdentity({source_url:'http://tickets.internal/otrs/index.pl?Action=AgentTicketZoom;TicketID=1194751#2911820'}),'tickets.internal:1194751');
  assert.equal(resolveTicketIdentity({thread_context:{source_url:'https://tickets.internal/index.pl?TicketID=%34%32&ArticleID=5'}}),'tickets.internal:42');
  assert.equal(resolveTicketIdentity({thread_context:{subject:'Ticket#2026040810000607 — Re: purchase'}}),'ticket-number:2026040810000607');
  assert.equal(resolveTicketIdentity({thread_context:{thread_structured:{ticket_subject:'[Ticket#2026040810000607] Re: purchase'}}}),'ticket-number:2026040810000607');
  assert.equal(resolveTicketIdentity({subject:'工单号：2026040810000607 退款'}),'ticket-number:2026040810000607');
  assert.equal(resolveTicketIdentity({thread_text:'Please refer to Ticket#2026040810000607'}),'');
  assert.equal(resolveTicketIdentity({subject:'My purchase was 2026040810000607'}),'');
  assert.equal(resolveTicketIdentity({source_url:'http://tickets.internal/?TicketID=%ZZ'}),'');
  assert.equal(resolveTicketIdentity({ticket_id:{fake:42}}),'');
});

test('old plugin requests without ticket_id still generate and deduplicate by real ticket number',async t=>{
  const s=fixture(t),p=product(s,'Alpha');entry(s,p,'knowledge');publish(s,p);
  const engine=new ManagedEngine(s,{provider:'mock'});
  const body={product_id:p,thread_context:{subject:'Ticket#2026040810000607 — Alpha refund',thread_text:'Please review my refund.'},messages:[{role:'user',content:'Summarize the issue'}]};
  await engine.run('chat',body);await engine.run('chat',body);
  assert.equal(s.data.events.length,2);
  assert.equal(s.data.events[0].ticketId,'ticket-number:2026040810000607');
  assert.equal(s.dashboard().tickets,1);
});

test('free chat preserves Chinese analysis even if the model also supplies an email draft',async t=>{
  const s=fixture(t),p=product(s,'Alpha');entry(s,p,'knowledge');publish(s,p);
  const engine=new ManagedEngine(s,{provider:'test',completion:async(system,messages)=>{
    assert.ok(system.includes('Follow the support agent\'s latest request'));
    assert.ok(system.includes('CURRENT ASSISTANT TASK: chat'));
    assert.equal(messages.at(-1).content,'分析一下这个工单，不要写邮件。');
    return JSON.stringify({summary:'客户申请退款，尚未核实订单。',reply:'需要先核查订单和退款资格，再提交审批。',draft_reply:'Dear Customer, thank you for your email.',used_ids:[]});
  }});
  const output=await engine.run('chat',{product_id:p,ticket_id:'host:42',messages:[{role:'user',content:'写一封回复'},{role:'assistant',content:'Dear Customer, ...'},{role:'user',content:'分析一下这个工单，不要写邮件。'}]});
  assert.equal(output.reply,'需要先核查订单和退款资格，再提交审批。');
  assert.equal(output.draft_reply,'');assert.equal(output.response_type,'analysis');
  assert.equal(s.data.events[0].output.reply,output.reply);
  const combinedReply='先核查订单再提交退款申请。\n\nDear Customer, we will review your request.';
  const combined=new ManagedEngine(s,{provider:'test',completion:async()=>JSON.stringify({response_type:'draft',reply:combinedReply,draft_reply:'Dear Customer, we will review your request.'})});
  const both=await combined.run('chat',{product_id:p,ticket_id:'host:42',messages:[{role:'user',content:'先分析，再给我一封回复。'}]});
  assert.equal(both.reply,combinedReply);
});

test('summary, missing questions and next-step tasks return analysis and include analysis-stage rules',async t=>{
  const s=fixture(t),p=product(s,'Alpha');entry(s,p,'knowledge');
  entry(s,p,'rules',{title:'分析专用规则',content:'必须先核查订单状态。',stage:'analyze-thread'});publish(s,p);
  const engine=new ManagedEngine(s,{provider:'test',completion:async(system)=>{
    assert.ok(system.includes('必须先核查订单状态'));
    return JSON.stringify({summary:'客户希望取消续订。',clarification_questions:['请提供购买邮箱。'],next_step:'查询订阅状态后提交取消申请。',reply:'Dear Customer, ...',draft_reply:'Dear Customer, ...',used_ids:[]});
  }});
  const base={product_id:p,ticket_id:'host:42'};
  for(const [task,answer] of [['summary','客户希望取消续订。'],['questions','- 请提供购买邮箱。'],['next_step','查询订阅状态后提交取消申请。']]){
    const output=await engine.run('chat',{...base,task});
    assert.equal(output.reply,answer);assert.equal(output.draft_reply,'');assert.equal(output.response_type,'analysis');
  }
  const mock=new ManagedEngine(s,{provider:'mock'});
  const summary=await mock.run('chat',{...base,task:'summary'});
  assert.equal(summary.draft_reply,'');assert.equal(summary.response_type,'analysis');
});

test('explicit email writing still returns a plain email; draft-only analysis responses are rejected',async t=>{
  const s=fixture(t),p=product(s,'Alpha');entry(s,p,'knowledge');publish(s,p);
  const engine=new ManagedEngine(s,{provider:'test',completion:async()=>JSON.stringify({summary:'客户申请退款。',reply:'以下为邮件草稿。',draft_reply:'Dear Customer,\n\nWe will review your request.\n\nBest regards,',used_ids:[]})});
  const output=await engine.run('chat',{product_id:p,ticket_id:'host:42',task:'draft'});
  assert.equal(output.reply,output.draft_reply);assert.equal(output.response_type,'draft');
  const wrong=new ManagedEngine(s,{provider:'test',completion:async()=>JSON.stringify({reply:'Dear Customer, ...',draft_reply:'Dear Customer, ...'})});
  await assert.rejects(()=>wrong.run('chat',{product_id:p,ticket_id:'host:42',task:'analysis'}),/未返回所请求的分析/);
});

test('fixed template phrases are validated; invalid provider output does not create events',async t=>{
  assert.equal(containsFixedPhrase('Dear Alice, we will review.', 'Dear {{customer_name}},'),true);
  assert.equal(containsFixedPhrase('We guarantee an instant refund.', 'We will review'),false);
  const s=fixture(t),p=product(s,'Alpha');
  const template=entry(s,p,'templates',{content:'We will review your refund request.',fixed:['We will review']});publish(s,p);
  const engine=new ManagedEngine(s,{provider:'test',completion:async()=>JSON.stringify({draft_reply:'Refund approved!',used_ids:[template]})});
  await assert.rejects(()=>engine.run('generate-draft',{product_id:p,ticket_id:'42',thread_text:'refund'}),/固定表述/);
  assert.equal(s.data.events.length,0);
  const malformed=new ManagedEngine(s,{provider:'test',completion:async()=>'<html>error</html>'});
  await assert.rejects(()=>malformed.run('chat',{product_id:p,ticket_id:'42'}),/格式/);
});

test('provider adapters parse raw REST output and preserve configured model names',async t=>{
  const s=fixture(t);const originalFetch=global.fetch;
  t.after(()=>{global.fetch=originalFetch;});
  let request;
  global.fetch=async(url,input)=>{request={url,body:JSON.parse(input.body)};return {ok:true,json:async()=>({output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:'{"reply":"ok"}'}]}]})};};
  const openai=new ManagedEngine(s,{provider:'openai',model:'gpt-5-mini'});
  assert.equal(await openai.complete('instructions',[{role:'user',content:'hello'}]),'{"reply":"ok"}');
  assert.equal(request.url,'https://api.openai.com/v1/responses');
  assert.equal(request.body.model,'gpt-5-mini');assert.equal(request.body.store,false);
  assert.equal(request.body.instructions,'instructions');assert.equal(request.body.max_tokens,undefined);
  global.fetch=async(url,input)=>{request={url,body:JSON.parse(input.body)};return {ok:true,json:async()=>({choices:[{message:{content:'{"reply":"deepseek"}'},finish_reason:'stop'}]})};};
  const deepseek=new ManagedEngine(s,{provider:'deepseek',model:'deepseek-v4-flash'});
  assert.equal(await deepseek.complete('instructions',[]),'{"reply":"deepseek"}');
  assert.equal(request.body.response_format.type,'json_object');
  global.fetch=async()=>({ok:false,status:429});
  await assert.rejects(()=>deepseek.complete('instructions',[]),/429/);
});

test('feedback updates do not inflate counts; unique tickets and unknown accuracy denominator', t=>{
  const s=fixture(t),p=product(s,'Alpha');
  const emit=(ticketId,action='chat')=>s.recordEvent({productId:p,ticketId,version:1,action,category:'refund',references:{},output:{}});
  const a=emit('same'),b=emit('same'),c=emit('other','analyze-thread');
  s.recordFeedback({event_id:a.id,feedback_key:a.feedbackKey,satisfaction:'satisfied',accuracy:'accurate'});
  s.recordFeedback({event_id:b.id,feedback_key:b.feedbackKey,accuracy:'unknown'});
  s.recordFeedback({event_id:c.id,feedback_key:c.feedbackKey,satisfaction:'unsatisfied',accuracy:'partial'});
  let d=s.dashboard();
  assert.equal(d.tickets,2);assert.equal(d.generations,2);assert.equal(d.analyses,1);
  assert.equal(d.accuracy,50);assert.equal(d.satisfaction,50);assert.equal(d.coverage,100);assert.equal(d.unknown,1);
  s.recordFeedback({event_id:a.id,feedback_key:a.feedbackKey,satisfaction:'neutral',accuracy:'inaccurate'});
  d=s.dashboard();assert.equal(d.evaluations,3);assert.equal(d.accuracy,0);
  assert.throws(()=>s.recordFeedback({event_id:a.id,feedback_key:'wrong',accuracy:'accurate'}),/凭证/);
  assert.equal(s.feedbackDetail(s.data.feedback[0].id).event.feedbackKey,undefined);
  assert.throws(()=>s.dashboard({days:'NaN'}),/时间范围/);
});

test('legacy import remains a draft and imports existing operational rules',t=>{
  const s=fixture(t);const p=s.importLegacy(path.resolve(__dirname,'../..'),'admin').id;
  assert.equal(s.product(p).published.knowledge.length,0);
  assert.equal(s.product(p).draft.knowledge.length,14);
  assert.ok(s.product(p).draft.rules.some(r=>r.content.includes('180')));
  assert.ok(s.product(p).draft.templates.length>6);
  assert.throws(()=>s.importLegacy(path.resolve(__dirname,'../..'),'admin'),/不能重复/);
});

test('administrator passwords are salted, last admin protected, persistence retained', t=>{
  const s=fixture(t);s.bootstrap('admin','a-strong-password-123');
  assert.equal(s.authenticate('ADMIN','a-strong-password-123').username,'admin');
  assert.equal(s.authenticate('admin','wrong'),null);
  assert.equal(s.authenticate('missing','wrong'),null);
  assert.equal(s.users()[0].hash,undefined);
  const user=s.users()[0];assert.throws(()=>s.updateUser(user.id,{enabled:false},'admin'),/至少一个/);
  s.updateUser(user.id,{password:'a-new-password-456'},'admin');
  assert.equal(s.authenticate('admin','a-strong-password-123'),null);
  assert.ok(new AdminStore(s.directory).authenticate('admin','a-new-password-456'));
  assert.ok(!fs.readFileSync(s.file,'utf8').includes('a-new-password-456'));
});

test('HTTP login, session, CSRF, static assets and copilot authorization',async t=>{
  const s=fixture(t);
  const oldToken=process.env.COPILOT_ACCESS_TOKEN;
  process.env.COPILOT_ACCESS_TOKEN='test-assistant-access-key';
  const router=createAdminRouter({directory:s.directory,provider:'mock',model:'mock'});
  if(oldToken===undefined)delete process.env.COPILOT_ACCESS_TOKEN;else process.env.COPILOT_ACCESS_TOKEN=oldToken;
  router.store.bootstrap('admin','a-strong-password-123');
  const server=http.createServer(async(req,res)=>{await router.handle(req,res,new URL(req.url,'http://localhost'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin='http://127.0.0.1:'+server.address().port;
  const call=(url,body,headers={})=>fetch(origin+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const asset=await call('/admin/');assert.equal(asset.status,200);assert.ok((await asset.text()).includes('管理后台'));assert.equal(asset.headers.get('access-control-allow-origin'),null);
  assert.equal((await call('/api/admin/products')).status,401);
  assert.equal((await call('/api/copilot/products')).status,401);
  assert.equal((await call('/api/admin/login',{username:'admin',password:'a-strong-password-123'},{Origin:'https://evil.test'})).status,403);
  const login=await call('/api/admin/login',{username:'admin',password:'a-strong-password-123'},{Origin:origin});
  assert.equal(login.status,200);const session=await login.json();const cookie=login.headers.get('set-cookie').split(';')[0];assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
  assert.equal((await call('/api/admin/products',{name:'Bad'},{Cookie:cookie})).status,403);
  const headers={Cookie:cookie,'X-CSRF-Token':session.csrf,Origin:origin};
  const p=await call('/api/admin/products',{name:'Alpha'},headers);assert.equal(p.status,200);
  const catalog=await call('/api/copilot/products',undefined,{Authorization:'Bearer test-assistant-access-key'});assert.equal((await catalog.json()).length,1);
  const extensionHeaders={Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop',Cookie:cookie,'Sec-Fetch-Site':'cross-site'};
  // A plugin token must be checked independently of an incidental admin cookie.
  assert.equal((await call('/api/copilot/products',undefined,{...extensionHeaders,Authorization:'Bearer test-assistant-access-key'})).status,200);
  assert.equal((await call('/api/copilot/products',undefined,{...headers,Authorization:'Bearer wrong-key'})).status,401);
  assert.equal((await call('/api/copilot/products',undefined,extensionHeaders)).status,401);
  assert.equal((await call('/api/admin/products',{name:'Forbidden'}, {...extensionHeaders,'X-CSRF-Token':session.csrf,Authorization:'Bearer test-assistant-access-key'})).status,403);
  const crosssite=await call('/api/admin/products',{name:'Bad'},{...headers,Origin:'https://evil.test'});assert.equal(crosssite.status,403);
  assert.equal((await call('/api/admin/logout',{},headers)).status,200);
  assert.equal((await call('/api/admin/products',undefined,{Cookie:cookie})).status,401);
  const wrong=await call('/api/admin/login',{username:'admin',password:'wrong'});assert.equal(wrong.status,401);
});

test('local plugin calls ignore admin cookies but retain browser origin protection',async t=>{
  const s=fixture(t);
  const names=['COPILOT_ACCESS_TOKEN','HOST','ADMIN_ORIGIN','ADMIN_SECURE_COOKIE','NODE_ENV'];
  const previous=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  let router;
  try {
    names.forEach(key=>delete process.env[key]);
    router=createAdminRouter({directory:s.directory,provider:'mock',model:'mock'});
  } finally {
    for(const key of names)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  }
  router.store.bootstrap('admin','a-strong-password-123');
  const server=http.createServer(async(req,res)=>{await router.handle(req,res,new URL(req.url,'http://localhost'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin='http://127.0.0.1:'+server.address().port;
  const call=(endpoint,body,headers={})=>fetch(origin+endpoint,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=await call('/api/admin/login',{username:'admin',password:'a-strong-password-123'},{Origin:origin});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const extension={Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop',Cookie:cookie,'Sec-Fetch-Site':'cross-site'};
  assert.equal((await call('/api/copilot/products',undefined,extension)).status,200);
  assert.equal((await call('/api/copilot/resolve-product',{thread_text:'hello'},extension)).status,200);
  assert.equal((await call('/api/copilot/products',undefined,{Origin:'moz-extension://1a2b-3456',Cookie:cookie})).status,200);
  assert.equal((await call('/api/copilot/products',undefined,{Origin:'https://evil.example',Cookie:cookie})).status,403);
  assert.equal((await call('/api/copilot/products',undefined,{Origin:'https://evil.example'})).status,403);
  assert.equal((await call('/api/admin/products',{name:'Forbidden'},extension)).status,403);
});

test('actual server entrypoint boots with initial administrator and serves health/admin',async t=>{
  const s=fixture(t);
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{
    cwd:path.resolve(__dirname,'../..'),windowsHide:true,
    env:{...process.env,AI_PROVIDER:'mock',HOST:'127.0.0.1',PORT:'0',ADMIN_DATA_DIR:s.directory,
      ADMIN_USERNAME:'startup-admin',ADMIN_PASSWORD:'startup-password-12345',COPILOT_ACCESS_TOKEN:'startup-assistant-key-12345',ADMIN_SECURE_COOKIE:'false',ADMIN_ORIGIN:''},
    stdio:['ignore','pipe','pipe']
  });
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}});
  const port=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('Startup timeout: '+output)),10000);
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/listening on http:\/\/127.0.0.1:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    child.stderr.on('data',chunk=>{output+=chunk;});child.on('error',reject);
    child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+output));});
  });
  const origin='http://127.0.0.1:'+port;
  const health=await(await fetch(origin+'/health')).json();assert.equal(health.mode,'mock');assert.equal(health.productCount,0);
  const login=await fetch(origin+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'startup-admin',password:'startup-password-12345'})});
  assert.equal(login.status,200);
  const index=await fetch(origin+'/');assert.ok((await index.text()).includes('/admin/app.js'));
  assert.equal((await fetch(origin+'/unknown')).status,404);
});
