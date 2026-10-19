// Optional end-to-end smoke test using an installed Chrome/Edge; no npm dependencies.
// Runs against isolated data in mock mode and never calls a model service.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createAdminRouter } = require('../lib/admin-router');

const base = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(base, '.test-data-'));
const artifactDir = path.join(base, '.cache', 'admin-preview');
fs.mkdirSync(artifactDir, { recursive:true });
const secret = require('node:crypto').randomBytes(24).toString('hex');
process.env.COPILOT_ACCESS_TOKEN = secret;
const router = createAdminRouter({ directory:path.join(dir,'data'), provider:'mock', model:'mock-engine' });
const username='browser-admin', password=require('node:crypto').randomBytes(20).toString('hex');
router.store.bootstrap(username,password);
const server=http.createServer(async(req,res)=>{
  try {
    if (req.url.startsWith('/test-extension/')) {
      const name=req.url.slice('/test-extension/'.length);
      if (!['panel.html','panel.js','panel.css'].includes(name)) {res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
      res.end(fs.readFileSync(path.resolve(base,'../extension',name)));return;
    }
    if (!await router.handle(req,res,new URL(req.url,'http://localhost'))) {res.writeHead(404);res.end();}
  } catch(error) {res.writeHead(500);res.end(error.message);}
});
let browser, socket;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pending=new Map();let sequence=0;const errors=[];
function command(method,params={}) {
  return new Promise((resolve,reject)=>{
    const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},12000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject});socket.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);
  return result.result?.value;
}
async function waitFor(expression) {
  const start=Date.now();
  while(Date.now()-start<10000) {if(await evaluate(expression))return;await sleep(80);}
  throw new Error('UI timeout: '+expression+'\n'+await evaluate('document.body.innerText.slice(-2000)'));
}
async function click(selector){await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function fill(selector,value){await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
async function screenshot(name){const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(artifactDir,name),Buffer.from(result.data,'base64'));}
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const executable=process.env.BROWSER_EXECUTABLE_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>fs.existsSync(p));
  if(!executable)throw new Error('Set BROWSER_EXECUTABLE_PATH to an installed Chrome or Edge.');
  browser=spawn(executable,['--headless=new','--remote-debugging-port=0','--user-data-dir='+path.join(dir,'browser'),'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  browser.on('error',error=>errors.push(error.message));
  const debuggerURL=await new Promise((resolve,reject)=>{
    let buffer='';const timer=setTimeout(()=>reject(new Error('Browser did not start: '+buffer.slice(-500))),12000);
    browser.stderr.on('data',chunk=>{buffer+=chunk.toString();const match=buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    browser.once('error',reject);
  });
  const debugOrigin='http://'+new URL(debuggerURL).host;
  const targets=await(await fetch(debugOrigin+'/json/list')).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await once(socket,'open');
  socket.addEventListener('message',event=>{
    const data=JSON.parse(event.data);
    if(data.id&&pending.has(data.id)){const p=pending.get(data.id);pending.delete(data.id);data.error?p.reject(new Error(data.error.message)):p.resolve(data.result);}
    if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text);
  });
  await command('Runtime.enable');await command('Page.enable');await command('Network.enable');
  await command('Network.setBlockedURLs',{urls:['*fonts.googleapis.com*','*fonts.gstatic.com*']});
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:origin+'/admin/'});await waitFor('!!document.querySelector("#loginForm")');
  await screenshot('login.png');await fill('#username',username);await fill('#password',password);await evaluate('document.querySelector("#loginForm").requestSubmit()');
  await waitFor('!!document.querySelector(".stats")');
  await click('[data-page="products"]');await waitFor('!!document.querySelector("#newProduct")');await click('#newProduct');
  await fill('#pName','Photo AI');await fill('#pAliases','Photo AI');await fill('#pQueues','Shared Support');await evaluate('document.querySelector("#productForm").requestSubmit()');
  await waitFor('!!document.querySelector("[data-manage]") && !document.querySelector("dialog").open');await click('[data-manage]');await waitFor('!!document.querySelector("#eTitle")');
  const markdownSource='## 退款政策\n\n**7 天内**申请；先核查订单。\n\n- 不得提前承诺退款\n- 提交审批\n\n| 套餐 | 期限 |\n| --- | --- |\n| 订阅 | 7 天 |';
  await fill('#eTitle','退款政策');await fill('#eCategory','refund');await fill('#eTags','refund, 退款');await fill('#eContent',markdownSource);await fill('#eInternal','需在工单系统中提交退款审批。');await evaluate('document.querySelector("#entryForm").requestSubmit()');
  await waitFor('!!document.querySelector("#openPublish") && !!document.querySelector(".entry-item")');await screenshot('knowledge.png');
  await waitFor('!document.querySelector("#knowledgePreview").hidden && !!document.querySelector("#knowledgePreview table")');
  assert.equal(await evaluate('document.querySelector("#knowledgePreview strong").textContent'),'7 天内');
  await click('#markdownEdit');assert.equal(await evaluate('document.querySelector("#eContent").hidden'),false);
  assert.equal(await evaluate('document.querySelector("#eContent").value'),markdownSource);
  await click('#markdownPreview');assert.equal(await evaluate('document.querySelector("#eContent").hidden'),true);
  await click('[data-page="templates"]');await waitFor('!!document.querySelector("#eFixed")');
  await fill('#eTitle','收到退款申请');await fill('#eCategory','refund');await fill('#eTags','refund');await fill('#eContent','Thank you for contacting us. We will review your refund request.');await fill('#eFixed','We will review your refund request.');await evaluate('document.querySelector("#entryForm").requestSubmit()');
  await waitFor('document.querySelector(".entry-title")?.textContent === "收到退款申请"');
  await click('#openPublish');await waitFor('!!document.querySelector("#publishForm")');
  assert.equal(await evaluate('document.querySelectorAll("input[name=release]").length'),2);
  await fill('#releaseNote','首次发布');await evaluate('document.querySelector("#publishForm").requestSubmit()');
  await waitFor('!document.querySelector("dialog").open && !document.querySelector("#openPublish")');
  await click('[data-page="test"]');await waitFor('!!document.querySelector("#testThread")');await fill('#testThread','Photo AI: I would like a refund for my subscription.');await evaluate('document.querySelector("#testForm").requestSubmit()');
  await waitFor('document.querySelector("#testOutput")?.textContent.includes("We will review")');await screenshot('test-workbench.png');
  await click('[data-tab="references"]');await waitFor('!!document.querySelector("#testOutput .markdown-body table")');
  assert.equal(router.store.data.events.length,0);
  await click('[data-page="settings"]');await waitFor('!!document.querySelector("#newUser")');
  await click('[data-page="history"]');await waitFor('!!document.querySelector("#publishNow")');
  assert.ok(await evaluate('document.querySelector("#page").textContent.includes("首次发布")'));
  await click('[data-view-version]');await waitFor('document.querySelector("dialog").open && document.querySelector("dialog").textContent.includes("退款政策")');await click('[data-close]');
  // Exercise the actual extension panel with a minimal Chrome API fixture.
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`window.chrome={storage:{local:{get:async()=>(${JSON.stringify({backendUrl:origin,copilotToken:secret})}),set:async()=>{}}},tabs:{query:async()=>[{id:1,url:'http://tickets.internal/otrs/index.pl?TicketID=42'}],sendMessage:async()=>({ticket_id:'tickets.internal:42',queue:'Shared Support',subject:'Photo AI refund',thread_text:'I would like a refund for Photo AI.',thread_structured:{active_article_body:'I would like a refund for Photo AI.'}})},webNavigation:{getAllFrames:async()=>[{frameId:0}]}};`});
  await command('Page.navigate',{url:origin+'/test-extension/panel.html'});await waitFor('document.querySelector("#productSelect")?.options.length===2');await click('#captureBtn');
  assert.deepEqual(await evaluate(`resolveCapturedTicket({subject:'Photo AI refund',frame_url:'about:blank'},[{ticket_id:'tickets.internal:99'}],{url:'http://tickets.internal/index.pl?Action=AgentTicketZoom;TicketID=42#article'})`),{id:'tickets.internal:42',url:'http://tickets.internal/index.pl?Action=AgentTicketZoom;TicketID=42#article'});
  assert.equal(await evaluate(`resolveCapturedTicket({subject:'Ticket#2026040810000607 — Photo AI refund'},[],{url:'about:blank'}).id`),'ticket-number:2026040810000607');
  await waitFor('document.querySelector("#productSelect")?.value && document.querySelector("#status").textContent === "captured"');
  await click('[data-task="draft"]');await waitFor('!!document.querySelector(".assistant-feedback")');
  assert.ok(await evaluate('document.querySelector(".chat-message-assistant .chat-bubble").textContent.includes("We will review")'));
  assert.equal(await evaluate('document.querySelector("#chatQuickActions").style.display'),'');
  await click('[data-task="summary"]');await waitFor('document.querySelectorAll(".assistant-feedback").length === 2');
  assert.ok(await evaluate('[...document.querySelectorAll(".chat-message-assistant .chat-bubble")].at(-1).textContent.includes("未调用 AI")'));
  await fill('.assistant-feedback [name=satisfaction]','satisfied');await fill('.assistant-feedback [name=accuracy]','accurate');await evaluate('document.querySelector(".assistant-feedback").requestSubmit()');
  await waitFor('document.querySelector(".assistant-feedback").textContent.includes("已评价")');
  assert.equal(router.store.dashboard().tickets,1);assert.equal(router.store.dashboard().satisfaction,100);
  await command('Page.navigate',{url:origin+'/admin/'});await waitFor('!!document.querySelector(".stats")');await screenshot('dashboard.png');
  assert.ok(await evaluate('document.querySelector(".stats").textContent.includes("100%")'));
  await click('[data-feedback]');await waitFor('document.querySelector("dialog").open');await click('[data-close]');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await screenshot('dashboard-mobile.png');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  assert.deepEqual(errors,[]);
  console.log('Browser smoke passed: login → product → knowledge/template → publish → preview → extension capture/chat/feedback → dashboard; desktop and mobile.');
  console.log('Screenshots: '+artifactDir);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(socket?.readyState===1){try{await command('Browser.close');}catch{}socket.close();}
  if(browser){if(browser.exitCode===null)browser.kill();await Promise.race([once(browser,'exit').catch(()=>{}),sleep(1000)]);}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  assert.equal(path.dirname(dir),base);assert.ok(path.basename(dir).startsWith('.test-data-'));
  for(let attempt=0;attempt<4;attempt++){try{fs.rmSync(dir,{recursive:true,force:true});break;}catch{await sleep(300);}}
});
