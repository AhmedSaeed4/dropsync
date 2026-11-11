import {register,createRequire} from 'node:module';import fs from 'node:fs';import vm from 'node:vm';import {test} from 'node:test';import assert from 'node:assert/strict';
register('./helpers/hook-module-loader.mjs',import.meta.url);
const require=createRequire(import.meta.url),React=require('react'),ts=require('typescript'),{createRoot}=require('react-dom/client'),{JSDOM}=await import('jsdom');
const readout=await import('../src/lib/editorialNarrowWindowReadout.ts');
let hook=null;if(fs.existsSync(new URL('../src/hooks/useMobileViewMounts.ts',import.meta.url)))hook=await import('../src/hooks/useMobileViewMounts.ts');
const dom=new JSDOM('<body></body>',{url:'http://localhost/',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
let hidden=false,reduced=false,nav,capture={},events=[];
Object.defineProperty(document,'hidden',{get:()=>hidden});
const queue=new Map();let serial=0;
const raf=f=>{queue.set(++serial,f);return serial;},cancel=n=>queue.delete(n);
Object.assign(globalThis,{requestAnimationFrame:raf,cancelAnimationFrame:cancel});
function child(name){return function Child(p){
 const [draft,setDraft]=React.useState('draft');capture[name]=p;
 React.useEffect(()=>{events.push('mount:'+name);return()=>events.push('unmount:'+name);},[]);
 return React.createElement('section',{'data-view':name},React.createElement('input',{value:draft,onChange:e=>setDraft(e.target.value)}));
};}
const deps={'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'motion/react':{useReducedMotion:()=>reduced},'../editorialTheme':{getEditorialThemeColors:()=>({})},'./MobileNavbar':{MobileNavbar:p=>{nav=p;return null;}},'./MobileDropsView':{MobileDropsView:child('drops')},'./MobileCreateView':{MobileCreateView:child('create')},'./MobileSearchView':{MobileSearchView:child('search')},'@/hooks/useMobileViewMounts':hook,'@/lib/editorialNarrowWindowReadout':readout};
const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/components/editorial/mobile/EditorialMobileShell.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>deps[id]??new Proxy({},{get:()=>()=>null}),window,document,localStorage:window.localStorage,console,process,requestAnimationFrame:raf,cancelAnimationFrame:cancel,setTimeout,clearTimeout});
async function fixture(stored=null){
 events=[];capture={};queue.clear();hidden=false;window.localStorage.clear();if(stored)window.localStorage.setItem('dropsync_editorial_mobile_tab',stored);
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
 const props={theme:'light',user:{uid:'owner'},drops:[],workspaces:[],workspaceMembers:[],categories:[],currentWorkspace:null,currentWorkspaceId:null};
 await React.act(async()=>root.render(React.createElement(exports.EditorialMobileShell,props)));
 const click=tab=>React.act(async()=>nav.onTabChange(tab));
 const frame=async()=>{const tasks=[...queue];queue.clear();await React.act(async()=>{for(const[,f]of tasks)f(16);});};
 const ack=async name=>React.act(async()=>capture[name].onReady?.());
 const visible=()=>node.querySelector('main > .visible [data-view]')?.getAttribute('data-view');
 const close=async()=>{await React.act(async()=>root.unmount());node.remove();queue.clear();};
 const rerender=patch=>{Object.assign(props,patch);return React.act(async()=>root.render(React.createElement(exports.EditorialMobileShell,props)));};
 return{node,click,frame,ack,visible,close,rerender};
}
test('C real shell leaves Create and Search truly unmounted until requested',async()=>{
 const f=await fixture();try{assert.deepEqual(events,['mount:drops'],'hidden views must have zero child mounts');assert.equal(f.node.querySelector('[data-view="search"]'),null);}finally{await f.close();}
});
test('C first open waits for real acknowledgement and two frames, then preserves instance and scroll',async()=>{
 const f=await fixture();try{
 await f.click('search');assert.equal(f.visible(),'drops','outgoing remains displayed during preparation');
 assert.ok(f.node.querySelector('[data-view="search"]'));await f.frame();assert.equal(f.visible(),'drops','unacknowledged frame is not readiness');
 await f.ack('search');await f.frame();assert.equal(f.visible(),'drops','first frame is only paint opportunity');await f.frame();assert.equal(f.visible(),'search');
 const view=f.node.querySelector('[data-view="search"]');view.scrollTop=777;await f.click('drops');await f.click('search');
 assert.equal(f.visible(),'search');assert.equal(f.node.querySelector('[data-view="search"]'),view);assert.equal(view.scrollTop,777);assert.equal(events.filter(e=>e==='mount:search').length,1);
 }finally{await f.close();}
});

test("C rapid intent ignores stale acknowledgements and cancels outgoing Create activity",async()=>{
 const f=await fixture();try{
 await f.click("create");const stale=capture.create.onReady;await f.click("search");
 assert.equal(capture.create.active,false);
 await React.act(async()=>stale());await f.frame();await f.frame();assert.equal(f.visible(),"drops");
 await f.ack("search");await f.frame();await f.frame();assert.equal(f.visible(),"search");
 }finally{await f.close();}
});
test("C stored tab restoration is a first-open request, not an eager visible mount",async()=>{
 const f=await fixture("search");try{assert.equal(f.visible(),"drops");assert.equal(capture.create,undefined);
 await f.ack("search");await f.frame();await f.frame();assert.equal(f.visible(),"search");
 }finally{await f.close();}
});
test("C hidden document defers reveal and visible restoration resumes the paint barrier",async()=>{
 const f=await fixture();try{
 await f.click("search");hidden=true;await React.act(async()=>document.dispatchEvent(new window.Event("visibilitychange")));
 await f.ack("search");await f.frame();await f.frame();assert.equal(f.visible(),"drops");
 hidden=false;await React.act(async()=>document.dispatchEvent(new window.Event("visibilitychange")));
 await f.frame();await f.frame();assert.equal(f.visible(),"search");
 }finally{hidden=false;await f.close();}
});
test("C reduced motion still waits for acknowledgement then reveals without animation frames",async()=>{
 reduced=true;const f=await fixture();try{
 await f.click("create");assert.equal(f.visible(),"drops");await f.ack("create");assert.equal(f.visible(),"create");
 assert.equal(f.node.querySelector("main > .visible").style.transition,"none");
 }finally{await f.close();reduced=false;}
});
test("C interrupted first open cannot bypass readiness on its next request",async()=>{
 const f=await fixture();try{
 await f.click("search");await f.click("drops");await f.click("search");
 assert.equal(f.visible(),"drops","never-presented child still owes first-open readiness");
 await f.ack("search");await f.frame();await f.frame();assert.equal(f.visible(),"search");
 }finally{await f.close();}
});

test("F real shell exposes unopened Search as measured zero without an applied budget",async()=>{
 const old=process.env.NODE_ENV;process.env.NODE_ENV="development";
 const f=await fixture();try{
 const snapshot=readout.getNarrowWindowSnapshot(),search=snapshot.find(r=>r.view==="search");
 assert.ok(search,"unopened Search must not disappear from diagnostics");
 assert.equal(search.mounted,false);assert.equal(search.appliedBudget,null);assert.equal(search.mountedRowIdsCount,0);assert.equal(search.ready,false);
 }finally{await f.close();if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});

function revealClock(){
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 let now=0;const timers=new Map();
 globalThis.setTimeout=(fn,delay,...args)=>{
  if(delay!==350)return originalSet(fn,delay,...args);
  const handle={};timers.set(handle,{at:now+delay,fn:()=>fn(...args)});return handle;
 };
 globalThis.clearTimeout=handle=>{if(!timers.delete(handle))originalClear(handle);};
 return{
  get now(){return now;},get pending(){return timers.size;},
  callbacks:()=>[...timers.values()].map(t=>t.fn),
  advance:async ms=>{const until=now+ms;await React.act(async()=>{
   while(true){const item=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!item)break;
    const [handle,t]=item;now=t.at;timers.delete(handle);t.fn();
   }now=until;
  });},
  restore:()=>{timers.clear();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;},
 };
}
function watchReveals(f,clock){
 let last=f.visible();const reveals=[];
 const observer=new window.MutationObserver(()=>{const tab=f.visible();if(tab!==last){last=tab;reveals.push({tab,at:clock.now});}});
 observer.observe(f.node,{attributes:true,childList:true,subtree:true});
 return{reveals,close:()=>observer.disconnect()};
}
test("76 no-rAF first open reveals at the350ms bound after readiness",async()=>{
 const clock=revealClock(),f=await fixture(),watch=watchReveals(f,clock);
 try{
 await f.click("search");await f.ack("search");
 await clock.advance(349);assert.equal(f.visible(),"drops","bound must not reveal early");
 await clock.advance(1);assert.equal(f.visible(),"search","a ready tab must reveal even when neither rAF fires");
 assert.deepEqual(watch.reveals,[{tab:"search",at:350}]);assert.equal(clock.pending,0);assert.equal(queue.size,0,"bound winner cancels both frame handles");
 }finally{watch.close();await f.close();clock.restore();}
});

test("76 two-rAF winner cancels the bound and reveals exactly once",async()=>{
 const clock=revealClock(),f=await fixture(),watch=watchReveals(f,clock);
 try{
 await f.click("search");await f.ack("search");assert.equal(clock.pending,1);
 const expired=clock.callbacks()[0];
 await clock.advance(16);await f.frame();assert.equal(f.visible(),"drops");
 await clock.advance(16);await f.frame();assert.equal(f.visible(),"search");assert.equal(clock.pending,0);
 await clock.advance(1000);await React.act(async()=>expired());
 assert.deepEqual(watch.reveals,[{tab:"search",at:32}],"late cancelled timer cannot double-reveal");
 }finally{watch.close();await f.close();clock.restore();}
});
test("76 displaced generation cannot reveal even through an already queued orphan timer",async()=>{
 const clock=revealClock(),f=await fixture(),watch=watchReveals(f,clock);
 try{
 await f.click("create");await f.ack("create");const orphan=clock.callbacks()[0];
 await clock.advance(100);await f.click("search");assert.equal(clock.pending,0);
 await React.act(async()=>orphan());await clock.advance(500);assert.equal(f.visible(),"drops");
 await f.ack("search");await clock.advance(350);assert.equal(f.visible(),"search");
 assert.deepEqual(watch.reveals,[{tab:"search",at:950}]);
 }finally{watch.close();await f.close();clock.restore();}
});
test("76 hidden at bound expiry defers until visibility restoration even if notification was late",async()=>{
 const clock=revealClock(),f=await fixture(),watch=watchReveals(f,clock);
 try{
 await f.click("search");await f.ack("search");
 hidden=true;await clock.advance(350);assert.equal(f.visible(),"drops");assert.equal(watch.reveals.length,0);
 // Only restoration is notified: useSyncExternalStore still has its old true snapshot.
 hidden=false;await React.act(async()=>document.dispatchEvent(new window.Event("visibilitychange")));
 assert.equal(f.visible(),"search");assert.deepEqual(watch.reveals,[{tab:"search",at:350}]);
 assert.equal(queue.size,0);assert.equal(clock.pending,0);
 }finally{hidden=false;watch.close();await f.close();clock.restore();}
});
test("76 normal hidden notification cancels and re-arms a no-rAF bound on restoration",async()=>{
 const clock=revealClock(),f=await fixture();
 try{
 await f.click("search");await f.ack("search");await clock.advance(100);
 hidden=true;await React.act(async()=>document.dispatchEvent(new window.Event("visibilitychange")));
 assert.equal(clock.pending,0);await clock.advance(400);assert.equal(f.visible(),"drops");
 hidden=false;await React.act(async()=>document.dispatchEvent(new window.Event("visibilitychange")));
 assert.equal(clock.pending,1);await clock.advance(349);assert.equal(f.visible(),"drops");
 await clock.advance(1);assert.equal(f.visible(),"search");
 }finally{hidden=false;await f.close();clock.restore();}
});
test("76 unmount cancels timers and queued frame callbacks",async()=>{
 const clock=revealClock(),f=await fixture();
 try{
 await f.click("search");await f.ack("search");
 const orphan=clock.callbacks()[0],staleFrames=[...queue.values()];
 await f.close();assert.equal(clock.pending,0);assert.equal(queue.size,0);
 await React.act(async()=>{orphan();for(const fn of staleFrames)fn(1000);});
 await clock.advance(1000);assert.equal(queue.size,0);
 }finally{clock.restore();}
});
test("76 scope and uid replacement invalidate the old bound until fresh readiness",async()=>{
 const clock=revealClock(),f=await fixture(),watch=watchReveals(f,clock);
 try{
 await f.click("search");await f.ack("search");const orphan=clock.callbacks()[0];
 await f.rerender({currentWorkspaceId:"new-space",currentWorkspace:{id:"new-space"}});
 assert.equal(clock.pending,0);await React.act(async()=>orphan());await clock.advance(400);assert.equal(f.visible(),"drops");
 await f.ack("search");const previousUser=clock.callbacks()[0];
 await f.rerender({user:{uid:"replacement"}});assert.equal(clock.pending,0);
 await React.act(async()=>previousUser());await clock.advance(400);assert.equal(f.visible(),"drops");
 await f.ack("search");await clock.advance(350);assert.equal(f.visible(),"search");assert.equal(watch.reveals.length,1);
 }finally{watch.close();await f.close();clock.restore();}
});
test("76 reduced motion reveals after readiness without arming any bound",async()=>{
 const clock=revealClock();reduced=true;const f=await fixture();
 try{await f.click("search");assert.equal(f.visible(),"drops");await f.ack("search");assert.equal(f.visible(),"search");assert.equal(clock.pending,0);assert.equal(queue.size,0);}
 finally{await f.close();reduced=false;clock.restore();}
});
