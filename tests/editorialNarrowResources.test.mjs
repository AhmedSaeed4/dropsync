import {register,createRequire} from 'node:module';
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {test} from 'node:test';
register('./helpers/hook-module-loader.mjs',import.meta.url);
const require=createRequire(import.meta.url),React=require('react'),ts=require('typescript'),{createRoot}=require('react-dom/client'),{JSDOM}=await import('jsdom');
const cache=await import('../src/lib/editorialCardCache.ts');
const dom=new JSDOM('<body></body>');
Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
const media=React.createContext(null);const calls=new Map();let outcome='ok';
const decrypt=async drop=>{calls.set(drop.id,(calls.get(drop.id)??0)+1);if(outcome==='throw')throw Error('mock rejection');return {...drop,encrypted:false,content:outcome==='unchanged'?drop.content:outcome==='empty'?'':'plain note',fileData:drop.type==='file'?'data:image/png;base64,AA':undefined};};
function load(file,deps){
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>{assert.ok(id in deps,'unmocked '+id);return deps[id];},window,document,console,fetch:()=>{throw Error('no real network');},getComputedStyle:window.getComputedStyle.bind(window),setTimeout,clearTimeout,AbortController});
 return exports;
}
const {useEditorialCardResources}=load('src/hooks/useEditorialCardResources.ts',{'react':React,'@/lib/drops':{decryptDrop:decrypt},'@/lib/editorialCardCache':cache});
const deps={'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'@/lib/drops':{decryptDrop:decrypt,formatFileSize:()=>'',getTimeRemaining:()=>'',getYouTubeVideoId:()=>null},'@/lib/previewPrime':{primeDecryptedPreview(){}},'../../DropMentionContent':{DropMentionContent:({content})=>React.createElement('span',{'data-preview':true},content)},'@/hooks/useVideoThumbnail':{useVideoThumbnail:()=>({thumbnailUrl:null})},'../editorialTheme':{getEditorialThemeColors:()=>({})},'../../call/LiveCallDropTile':{LiveCallDropTile:()=>null},'../../ImageLightbox':{ImageLightbox:({onClose})=>React.createElement('button',{'data-close':true,onClick:onClose},'close')},'@/hooks/useEditorialCardResources':{useEditorialCardResources},'../NarrowEditorialWindowList':{NarrowMediaContext:media}};
const {MobileDropCard}=load('src/components/editorial/mobile/MobileDropCard.tsx',deps);
const raw=id=>({id,type:'text',name:'mock name',encrypted:true,content:'ciphertext'+id,iv:'iv'+id,createdAt:new Date(),expiresAt:null,userId:'mock-owner'});
async function mount(drop,pin=()=>{}){
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
 const props={drop,virtualMode:true,resourceScope:'personal',onWindowRetentionChange:pin,theme:'light',currentUserId:'mock-owner',currentWorkspaceId:null,currentWorkspace:null,allDrops:[drop],selectionMode:false,selected:false,onSelect(){},onPreview(){},onOpenSheet(){},reminderGlow:false,members:[],hoverable:false};
 await React.act(async()=>root.render(React.createElement(MobileDropCard,props)));
 for(let i=0;i<3;i++)await React.act(async()=>{for(let j=0;j<20;j++)await Promise.resolve();});
 return{node,close:async()=>{await React.act(async()=>root.unmount());node.remove();}};
}
test('B real virtual phone card and real resource hook reuse completed payload on remount',async()=>{
 cache.editorialCardCache.beginSession('mock-owner');outcome='ok';const drop=raw('return');let f=await mount(drop);
 assert.equal(f.node.querySelector('[data-preview]').textContent,'plain note');await f.close();
 f=await mount(drop);assert.equal(f.node.querySelector('[data-preview]').textContent,'plain note');assert.equal(calls.get(drop.id),1);await f.close();
});
for(const mode of ['unchanged','throw','empty'])test('B owner ruling '+mode+' retains exact phone error placeholder with protected cache',async()=>{
 outcome=mode;const f=await mount(raw(mode));try{assert.equal(f.node.querySelector('[data-preview]').textContent,'[Encrypted - cannot decrypt]');assert.ok(!f.node.textContent.includes('ciphertext'));}finally{await f.close();}
});
test('B real image viewer holds then releases row lifetime',async()=>{
 outcome='ok';const values=[],f=await mount({...raw('image'),type:'file',mimeType:'image/png'},v=>values.push(v));
 try{const open=f.node.querySelector('[title="View full screen"]');assert.ok(open);await React.act(async()=>open.click());assert.equal(values.at(-1),true);await React.act(async()=>f.node.querySelector('[data-close]').click());assert.equal(values.at(-1),false);}finally{await f.close();}
});
