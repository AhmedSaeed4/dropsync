import {register,createRequire} from 'node:module';
import fs from 'node:fs';import vm from 'node:vm';
import assert from 'node:assert/strict';import {test} from 'node:test';
register('./helpers/hook-module-loader.mjs',import.meta.url);
const require=createRequire(import.meta.url),React=require('react'),ts=require('typescript');
const {createRoot}=require('react-dom/client'),{JSDOM}=await import('jsdom');
const hook=await import('../src/hooks/useNarrowEditorialWindow.ts');
const model=await import('../src/lib/editorialWindowModel.ts'),readout=await import('../src/lib/editorialNarrowWindowReadout.ts'),cache=await import('../src/lib/editorialCardCache.ts');
const dom=new JSDOM('<body></body>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:dom.window.getComputedStyle.bind(dom.window)});
HTMLElement.prototype.attachEvent=function(){};HTMLElement.prototype.detachEvent=function(){};
window.matchMedia=q=>({matches:q.includes('max-width'),addEventListener(){},removeEventListener(){}});
Object.defineProperties(HTMLElement.prototype,{clientWidth:{get:()=>390},clientHeight:{get:()=>700},offsetHeight:{get:()=>160}});
HTMLElement.prototype.scrollTo=function({top}){this.scrollTop=top;};
HTMLElement.prototype.getBoundingClientRect=()=>({top:0,bottom:700,width:390,height:700});
const frames=new Map();let seq=0,reduced=true;
const raf=f=>{frames.set(++seq,f);return seq;},cancel=n=>frames.delete(n);
const RO=class{observe(){}unobserve(){}disconnect(){}};
Object.assign(globalThis,{ResizeObserver:RO,requestAnimationFrame:raf,cancelAnimationFrame:cancel});
const noOp=()=>{},Empty=()=>null,propsSeen=new Map(),pending={pending:new Map(),tombstone:new Set()};
const Card=p=>{propsSeen.set(p.drop.id,p);return React.createElement('article',{'data-card':p.drop.id},React.createElement('h3',null,p.drop.name));};
const Motion=React.forwardRef(({children,layout,initial,animate,exit,transition,onAnimationComplete,...p},ref)=>React.createElement('div',{...p,ref},children));
const deps={
'react':React,'react/jsx-runtime':require('react/jsx-runtime'),
'motion/react':{motion:new Proxy({},{get:()=>Motion}),AnimatePresence:({children})=>children,useReducedMotion:()=>reduced},
'@/lib/drops':{deleteDrop:async()=>{},pinDrop:async()=>{},unpinDrop:async()=>{},isReminderFiredShared:()=>false,isReminderGlowingForViewer:()=>false},
'@/lib/pendingDeletions':{usePendingDeletions:()=>pending,requestDelete:noOp,undo:noOp,dismiss:noOp},
'../editorialTheme':{getEditorialThemeColors:()=>({})},
'@/lib/auth':{getDropSortPrefs:async()=>({mode:{},order:{}}),setDropSortMode:noOp,setDropOrder:noOp},
'./MobileDropCard':{MobileDropCard:Card},
'@/hooks/useNarrowEditorialWindow':hook,'@/lib/editorialWindowModel':model,
'@/lib/editorialNarrowWindowReadout':readout,'@/lib/editorialWindowPolicy':readout,'@/lib/editorialCardCache':cache,
};
for(const n of ['LoadingIndicator','UndoToast','Toast'])deps['@/components/'+n]={[n]:Empty};
deps['../EditorialStatusPanel']={EditorialStatusPanel:Empty};
for(const n of ['MobileCategoryStrip','MobileSortMenu','MobileBulkBar','MobileActionSheet'])deps['./'+n]={[n]:Empty};
deps["@dnd-kit/sortable"]=require("@dnd-kit/sortable");
function load(file){
 const exports={},s=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>{
 if(id.includes('NarrowEditorialWindowList'))return load('src/components/editorial/NarrowEditorialWindowList.tsx');
 assert.ok(Object.hasOwn(deps,id),'unmocked dependency '+id);return deps[id];},window,document,HTMLElement,ResizeObserver:RO,requestAnimationFrame:raf,cancelAnimationFrame:cancel,getComputedStyle,process,console,setTimeout,clearTimeout,Map,Set});
 return exports;
}

deps["@/lib/youtubeLabels"]={dropMatchesSearchQuery:(d,q)=>d.name.toLowerCase().includes(q.toLowerCase())};
const {MobileSearchView}=load("src/components/editorial/mobile/MobileSearchView.tsx");
test("E real Search windows all610 results without capping the result data",async()=>{
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const data=Array.from({length:610},(_,i)=>({id:"s"+i,name:"Result "+i,type:"text",content:"body",createdAt:new Date(610-i),expiresAt:null,userId:"owner",encrypted:false}));
 try{await React.act(async()=>root.render(React.createElement(MobileSearchView,{theme:"light",currentUserId:"owner",currentWorkspace:null,drops:data,dropsLoading:false,refreshDrops:noOp,workspaceMembers:[],hoverable:false,active:true,onPreview:noOp,onEditDrop:noOp,onOpenMoveModal:noOp})));
 assert.equal(node.querySelectorAll("[data-card]").length,24,"Search must window actual result cards");
 assert.equal(propsSeen.get("s0").allDrops.length,610);
 }finally{await React.act(async()=>root.unmount());node.remove();frames.clear();}
});

async function fixture(overrides={}){
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const data=Array.from({length:610},(_,i)=>({id:"q"+i,name:"Result "+i,type:"text",content:"body",createdAt:new Date(610-i),expiresAt:null,userId:i%2?"member":"owner",encrypted:false}));
 let ready=0;
 const p={theme:"light",currentUserId:"owner",currentWorkspace:{id:"ws",ownerId:"owner"},drops:data,dropsLoading:false,refreshDrops:noOp,workspaceMembers:[{uid:"member",displayName:"Member"}],hoverable:false,active:true,onPreview:noOp,onEditDrop:noOp,onOpenMoveModal:noOp,onReady:()=>ready++,...overrides};
 const render=()=>React.act(async()=>root.render(React.createElement(MobileSearchView,p)));await render();
 return{node,root,p,data,render,get ready(){return ready;},close:async()=>{await React.act(async()=>root.unmount());node.remove();frames.clear();}};
}
async function query(f,value){
 const input=f.node.querySelector("input"),key=Object.keys(input).find(k=>k.startsWith("__reactProps"));
 await React.act(async()=>input[key].onChange({target:{value}}));
}
test("E query reaches an off-window result; member picker and no-match keep full semantics",async()=>{
 const f=await fixture();
 try{
 assert.ok(f.ready>0,"nonempty first open waits for the actual attached window");
 await query(f,"Result 600");assert.equal(f.node.querySelectorAll("[data-card]").length,1);assert.ok(f.node.querySelector('[data-card="q600"]'));assert.ok(f.node.textContent.includes("Results · 1"));
 await query(f,"missing");assert.ok(f.node.textContent.includes("Nothing matches"));assert.equal(f.node.querySelectorAll("[data-card]").length,0);
 await query(f,"@");const member=[...f.node.querySelectorAll("button")].find(b=>b.textContent.includes("Member"));assert.ok(member);
 await React.act(async()=>member.click());assert.ok(f.node.textContent.includes("Results · 305"));assert.equal(f.node.querySelectorAll("[data-card]").length,24);
 assert.ok([...f.node.querySelectorAll("[data-card]")].every(e=>propsSeen.get(e.dataset.card).drop.userId==="member"));
 const clear=f.node.querySelector('[aria-label="Clear member filter"]');await React.act(async()=>clear.click());assert.equal(f.node.querySelectorAll("[data-card]").length,24);
 }finally{await f.close();}
});
for(const mode of ["loading","empty"])test("E "+mode+" branch acknowledges real non-row layout",async()=>{
 const f=await fixture(mode==="loading"?{dropsLoading:true}:{drops:[]});
 try{assert.ok(f.ready>0);assert.equal(f.node.querySelectorAll("[data-card]").length,0);}finally{await f.close();}
});
test("E both visited real phone collections remain bounded with full data and independent queries",async()=>{
 const {MobileDropsView}=load("src/components/editorial/mobile/MobileDropsView.tsx");
 const f=await fixture();try{
 const base={...f.p,currentWorkspaceId:"ws",categories:[],onDeleteCategory:noOp,encryptionInitializing:false,wordAnimEnabled:false,wordAnimStyle:"slide",wordAnimHold:2,youtubeBackfillVisible:false,onOpenYoutubeBackfill:noOp};
 await React.act(async()=>f.root.render(React.createElement(React.Fragment,null,
 React.createElement("section",{"data-view":"drops"},React.createElement(MobileDropsView,base)),
 React.createElement("section",{"data-view":"search"},React.createElement(MobileSearchView,base)))));
 assert.equal(f.node.querySelector('[data-view="drops"]').querySelectorAll("[data-card]").length,24);
 assert.equal(f.node.querySelector('[data-view="search"]').querySelectorAll("[data-card]").length,24);
 const search=f.node.querySelector('[data-view="search"]');const input=search.querySelector("input"),key=Object.keys(input).find(k=>k.startsWith("__reactProps"));
 await React.act(async()=>input[key].onChange({target:{value:"Result 600"}}));
 assert.equal(search.querySelectorAll("[data-card]").length,1);assert.equal(f.node.querySelector('[data-view="drops"]').querySelectorAll("[data-card]").length,24);
 }finally{await f.close();}
});

test("F real Search applies the dev ladder and reports measured/status states truthfully",async()=>{
 const old=process.env.NODE_ENV;process.env.NODE_ENV="development";window.history.replaceState(null,"","/?editorialWindowBudget=12");
 const f=await fixture();try{
 let record=readout.getNarrowWindowSnapshot().find(x=>x.view==="search");
 assert.ok(record);assert.equal(record.mounted,true);assert.equal(record.N,610);assert.equal(record.F,610);
 assert.equal(record.requested,12);assert.equal(record.effectiveBudget,12);assert.equal(record.appliedBudget,12);
 assert.equal(record.mountedRowIdsCount,12);assert.equal(record.ready,true);assert.ok(record.measuredAt);assert.ok(record.revealedAt);
 const firstReveal=record.revealedAt;
 await query(f,"Result");record=readout.getNarrowWindowSnapshot().find(x=>x.view==="search");assert.equal(record.revealedAt,firstReveal);
 await query(f,"unmatched");record=readout.getNarrowWindowSnapshot().find(x=>x.view==="search");
 assert.equal(record.F,0);assert.equal(record.appliedBudget,null);assert.equal(record.mountedRowIdsCount,0);assert.equal(record.branch,"filtered-empty");assert.equal(record.ready,true);
 }finally{await f.close();window.history.replaceState(null,"","/");if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});

test("F hidden first-open sample records preparation before its later reveal",async()=>{
 const old=process.env.NODE_ENV;process.env.NODE_ENV="development";
 const f=await fixture({active:false,windowState:{requestedTab:"search",displayedTab:"drops",preparing:true}});
 try{
 let record=readout.getNarrowWindowSnapshot().find(x=>x.view==="search");
 assert.ok(record.prepareStartedAt);assert.ok(record.preparedAt>=record.prepareStartedAt);assert.equal(record.revealedAt,null);
 assert.equal(record.tier,"middle"); // jsdom default CSS width is1024; sample reports the actual width.
 const prepared=record.preparedAt;
 f.p.active=true;f.p.windowState={requestedTab:"search",displayedTab:"search",preparing:false};await f.render();
 record=readout.getNarrowWindowSnapshot().find(x=>x.view==="search");
 assert.equal(record.preparedAt,prepared);assert.ok(record.revealedAt>=prepared);
 }finally{await f.close();if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});
