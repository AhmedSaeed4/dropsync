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
const {MobileDropsView}=load('src/components/editorial/mobile/MobileDropsView.tsx');
function props(n){return {theme:'light',currentUserId:'owner',currentWorkspace:null,currentWorkspaceId:null,drops:Array.from({length:n},(_,i)=>({id:'r'+i,name:'Drop '+i,type:'text',content:'body',createdAt:new Date(n-i),expiresAt:null,userId:'owner',encrypted:false})),dropsLoading:false,refreshDrops:noOp,categories:[],onDeleteCategory:noOp,workspaceMembers:[],encryptionInitializing:false,wordAnimEnabled:false,wordAnimStyle:'slide',wordAnimHold:2,youtubeBackfillVisible:false,onOpenYoutubeBackfill:noOp,hoverable:false,onPreview:noOp,onEditDrop:noOp,onOpenMoveModal:noOp};}
for(const animate of [false,true])test('B real '+(animate?'animated':'plain')+' phone view bounds 610 cards and preserves full mention source',async()=>{
 reduced=!animate;const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
 try{await React.act(async()=>root.render(React.createElement(MobileDropsView,props(610))));
 for(let i=0;frames.size&&i<30;i++){const batch=[...frames];frames.clear();await React.act(async()=>{for(const[,f]of batch)f(i*16);});}
 assert.equal(node.querySelectorAll('[data-card]').length,24,'actual MobileDropsView must mount 24, not all610');
 assert.ok(node.textContent.includes('610 drops'));assert.equal(propsSeen.get('r0').allDrops.length,610);
 }finally{await React.act(async()=>root.unmount());node.remove();frames.clear();}
});

test("B full-data selection, move and manual neighbor order survive window boundaries",async()=>{
 reduced=true;let bulk,sort,saved,moved;
 deps["./MobileBulkBar"].MobileBulkBar=p=>{bulk=p;return null;};
 deps["./MobileSortMenu"].MobileSortMenu=p=>{sort=p;return null;};
 deps["@/lib/auth"].setDropOrder=(uid,space,ids)=>{saved=ids;};
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),p=props(610);
 p.onOpenMoveModal=items=>{moved=items;};
 try{
 await React.act(async()=>root.render(React.createElement(MobileDropsView,p)));
 await React.act(async()=>sort.onSortChange("manual"));
 assert.ok(propsSeen.get("r23").manualMove.canDown);
 await React.act(async()=>propsSeen.get("r23").manualMove.onDown());
 assert.equal(saved.length,610);assert.equal(saved[23],"r24");assert.equal(saved[24],"r23");
 const select=[...node.querySelectorAll("button")].find(b=>b.getAttribute("aria-pressed")==="false");
 assert.ok(select);await React.act(async()=>select.click());
 await React.act(async()=>bulk.onSelectAllToggle());
 assert.equal(bulk.selectedCount,610);assert.equal(bulk.allSelected,true);
 await React.act(async()=>bulk.onMove());assert.equal(moved.length,610);
 await React.act(async()=>bulk.onSelectAllToggle());assert.equal(bulk.selectedCount,0);
 }finally{await React.act(async()=>root.unmount());node.remove();frames.clear();}
});
