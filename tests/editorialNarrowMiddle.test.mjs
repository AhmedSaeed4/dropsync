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
'./editorialTheme':{getEditorialThemeColors:()=>({})},
'@/lib/auth':{getDropSortPrefs:async()=>({mode:{},order:{}}),setDropSortMode:noOp,setDropOrder:noOp},
'./EditorialDropItem':{EditorialDropItem:Card},
'@/hooks/useNarrowEditorialWindow':hook,'@/lib/editorialWindowModel':model,
'@/lib/editorialNarrowWindowReadout':readout,'@/lib/editorialWindowPolicy':readout,'@/lib/editorialCardCache':cache,
};
for(const n of ['LoadingIndicator','UndoToast','Toast'])deps['@/components/'+n]={[n]:Empty};
deps['../EditorialStatusPanel']={EditorialStatusPanel:Empty};
for(const n of ['MobileCategoryStrip','MobileSortMenu','MobileBulkBar','MobileActionSheet'])deps['./'+n]={[n]:Empty};
function load(file){
 const exports={},s=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>{
 if(id.includes('NarrowEditorialWindowList'))return load('src/components/editorial/NarrowEditorialWindowList.tsx');
 assert.ok(Object.hasOwn(deps,id),'unmocked dependency '+id);return deps[id];},window,document,HTMLElement,ResizeObserver:RO,requestAnimationFrame:raf,cancelAnimationFrame:cancel,getComputedStyle,process,console,setTimeout,clearTimeout,Map,Set});
 return exports;
}

deps["react-dom"]=require("react-dom");
deps["@/dnd-kit/core"]={};
deps["@dnd-kit/core"]={DndContext:({children})=>children,PointerSensor:class{},useSensor:()=>({}),useSensors:()=>[],closestCenter:()=>null};
deps["@dnd-kit/sortable"]={SortableContext:({children})=>children,arrayMove:(a,f,t)=>{const b=[...a];b.splice(t,0,b.splice(f,1)[0]);return b;},useSortable:()=>({attributes:{},listeners:{},setNodeRef(){},transform:null}),verticalListSortingStrategy:()=>{}};
deps["@/hooks/useEditorialWindow"]={useWideEditorial:()=>false};
deps["@/lib/editorialWindowPolicy"]=await import("../src/lib/editorialWindowPolicy.ts");
deps["@/lib/operationCenter"]={startDropOperation:()=>({update(){},finish(){}})};
deps["@/lib/youtubeLabels"]={dropMatchesSearchQuery:()=>true};
deps["./EditorialWindowList"]={EditorialWindowList:()=>null};
deps["./EditorialMoveDropModal"]={EditorialMoveDropModal:Empty};
deps["./HoldToDeleteButton"]={default:Empty};
Object.assign(deps["@/lib/auth"],{getCategoryCollapsed:async()=>({}),setCategoryCollapsed:noOp});
let wide=false,fine=false,dragContext,sortableItems;
deps["@/hooks/useEditorialWindow"].useWideEditorial=()=>wide;
window.matchMedia=q=>({matches:q.includes("pointer")?fine:wide,addEventListener(){},removeEventListener(){}});
deps["./EditorialWindowList"].EditorialWindowList=p=>React.createElement("i",{"data-wide":true});
deps["@dnd-kit/core"].DndContext=p=>{dragContext=p;return p.children;};
deps["@dnd-kit/sortable"].SortableContext=p=>{sortableItems=p.items;return p.children;};
const {EditorialDropList}=load("src/components/editorial/EditorialDropList.tsx");
test("D real middle list mounts a window from 610 complete rows",async()=>{
 reduced=true;const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const data=Array.from({length:610},(_,i)=>({id:"r"+i,name:"Drop "+i,type:"text",content:"body",createdAt:new Date(610-i),expiresAt:null,userId:"owner",encrypted:false}));
 try{await React.act(async()=>root.render(React.createElement(EditorialDropList,{narrowTier:"middle",drops:data,allDrops:data,loading:false,onDelete:noOp,onPreview:noOp,currentUserId:"owner",categories:[],workspaceMembers:[],activeWorkspaceId:null})));
 for(let i=0;frames.size&&i<30;i++){const batch=[...frames];frames.clear();await React.act(async()=>{for(const[,f]of batch)f(i*16);});}
 assert.equal(node.querySelectorAll("[data-card]").length,24,"middle must window actual mounted cards");
 }finally{await React.act(async()=>root.unmount());node.remove();frames.clear();}
});

test("D real list handoff latches narrow, gives wide priority, and preserves original initial-wide bootstrap",async()=>{
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const data=Array.from({length:100},(_,i)=>({id:"x"+i,name:"X "+i,type:"text",content:"body",createdAt:new Date(100-i),expiresAt:null,userId:"owner",encrypted:false}));
 const p={drops:data,allDrops:data,loading:false,onDelete:noOp,onPreview:noOp,currentUserId:"owner",categories:[],workspaceMembers:[],activeWorkspaceId:null};
 const render=()=>React.act(async()=>root.render(React.createElement(EditorialDropList,p)));
 try{
 wide=false;p.narrowTier=undefined;await render();assert.equal(node.querySelectorAll("[data-card]").length,100,"initial wide bootstrap stays legacy until original hook resolves");
 p.narrowTier="middle";await render();assert.equal(node.querySelectorAll("[data-card]").length,24);
 p.narrowTier=undefined;await render();assert.equal(node.querySelectorAll("[data-card]").length,24,"query handoff cannot mount all100");
 wide=true;await render();assert.ok(node.querySelector("[data-wide]"));
 p.narrowTier="middle";await render();assert.ok(node.querySelector("[data-wide]"),"wide retains priority");
 wide=false;await render();assert.equal(node.querySelectorAll("[data-card]").length,24);
 }finally{wide=false;await React.act(async()=>root.unmount());node.remove();frames.clear();}
});
test("D middle drag keeps the full eligible order and disables competing autoscroll",async()=>{
 fine=true;wide=false;deps["@/lib/auth"].getDropSortPrefs=async()=>({mode:{personal:"manual"},order:{}});
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const data=Array.from({length:100},(_,i)=>({id:"d"+i,name:"D "+i,type:"text",content:"body",createdAt:new Date(100-i),expiresAt:null,userId:"owner",encrypted:false}));
 let saved;deps["@/lib/auth"].setDropOrder=(uid,scope,ids)=>{saved=ids;};
 try{
 await React.act(async()=>root.render(React.createElement(EditorialDropList,{narrowTier:"middle",drops:data,allDrops:data,loading:false,onDelete:noOp,onPreview:noOp,currentUserId:"owner",categories:[],workspaceMembers:[],activeWorkspaceId:null})));
 assert.equal(dragContext.autoScroll,false);assert.equal(sortableItems.length,100);
 await React.act(async()=>dragContext.onDragStart({active:{id:"d0"}}));
 await React.act(async()=>dragContext.onDragEnd({active:{id:"d0"},over:{id:"d23"}}));
 assert.equal(saved.length,100);assert.equal(saved[23],"d0");assert.equal(node.querySelectorAll("[data-card]").length,24);
 }finally{fine=false;await React.act(async()=>root.unmount());node.remove();frames.clear();}
});

test("D middle native scroll changes mounted range and filtering keeps complete matching order",async()=>{
 fine=false;wide=false;deps["@/lib/auth"].getDropSortPrefs=async()=>({mode:{},order:{}});
 deps["@/lib/youtubeLabels"].dropMatchesSearchQuery=(drop,q)=>drop.name.includes(q);
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const data=Array.from({length:610},(_,i)=>({id:"f"+i,name:i%2?"other "+i:"wanted "+i,type:"text",content:"body",createdAt:new Date(610-i),expiresAt:null,userId:"owner",encrypted:false}));
 try{
 await React.act(async()=>root.render(React.createElement(EditorialDropList,{narrowTier:"middle",drops:data,allDrops:data,loading:false,onDelete:noOp,onPreview:noOp,currentUserId:"owner",categories:[],workspaceMembers:[],activeWorkspaceId:null})));
 HTMLElement.prototype.getBoundingClientRect=function(){const top=-(this.parentElement?.scrollTop??0);return {top,bottom:top+700,width:390,height:700};};
 const stage=node.querySelector("[data-row-id]").parentElement,scroller=node.querySelector(".thin-scrollbar");
 await React.act(async()=>{scroller.scrollTop=20000;scroller.dispatchEvent(new Event("scroll"));});
 assert.equal(node.querySelectorAll("[data-card]").length,24);assert.ok(!node.querySelector('[data-card="f0"]'));
 const input=node.querySelector("input"),prop=Object.keys(input).find(k=>k.startsWith("__reactProps"));
 await React.act(async()=>input[prop].onChange({target:{value:"wanted"}}));
 assert.ok(node.querySelectorAll("[data-card]").length<=24);
 assert.ok([...node.querySelectorAll("[data-card]")].every(e=>e.textContent.includes("wanted")));
 assert.ok(node.textContent.includes("305"));
 }finally{await React.act(async()=>root.unmount());node.remove();frames.clear();}
});
