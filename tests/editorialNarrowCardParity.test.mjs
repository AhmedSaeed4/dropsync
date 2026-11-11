import {register,createRequire} from 'node:module';
import fs from 'node:fs';import vm from 'node:vm';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';import {test} from 'node:test';
register('./helpers/hook-module-loader.mjs',import.meta.url);
const require=createRequire(import.meta.url),React=require('react'),ts=require('typescript'),{renderToStaticMarkup}=require('react-dom/server');
const file='src/components/editorial/EditorialDropItem.tsx',current=fs.readFileSync(file,'utf8');
const patch=execFileSync('git',['diff','--',file],{encoding:'utf8'});
const lines=current.split('\n');let shift=0;
for(const section of patch.split(/^@@ /m).slice(1)){
 const header=section.match(/^-\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*\n/);assert.ok(header);
 const body=section.slice(header[0].length).split('\n'),old=[],added=[];
 for(const line of body){if(line.startsWith('diff --git'))break;if(line.startsWith(' ')||line.startsWith('-'))old.push(line.slice(1));if(line.startsWith(' ')||line.startsWith('+'))added.push(line.slice(1));}
 const start=Number(header[1])-1+shift;assert.deepEqual(lines.slice(start,start+added.length),added);
 lines.splice(start,added.length,...old);shift+=old.length-added.length;
}
const original=lines.join('\n'),blob=createHash('sha1').update('blob '+Buffer.byteLength(original)+'\0').update(original).digest('hex');
assert.ok(blob.startsWith(patch.match(/index ([a-f0-9]+)\.\./)[1]),'reconstructed baseline equals git blob');
const Empty=()=>null,noop=()=>{},Motion=({children,...props})=>React.createElement('div',props,children);
const deps={
'react':React,'react/jsx-runtime':require('react/jsx-runtime'),
'@/lib/agentDropEligibility':{isAgentDropEligible:()=>false},'@/hooks/useAgentExpiryClock':{useAgentExpiryClock:noop},
'@/lib/drops':{formatFileSize:()=>'',getTimeRemaining:()=>'',getYouTubeVideoId:()=>null},
'@/lib/previewPrime':{},'@/lib/shares':{},'@/lib/download':{},'@/lib/dropTagUtils':{contentToPlainText:s=>s},
'../DropMentionContent':{DropMentionContent:({content})=>React.createElement('span',null,content)},
'motion/react':{AnimatePresence:({children})=>children,motion:{div:Motion}},
'@/hooks/useVideoThumbnail':{useVideoThumbnail:()=>({thumbnailUrl:null})},
'@/hooks/useEditorialCardResources':{useEditorialCardResources:()=>({text:'plain',textReady:true,ready:true})},
'./editorialTheme':{getEditorialThemeColors:()=>({})},
'../DropContextMenu':{DropContextMenu:Empty,useContextMenu:()=>({menuState:null,closeMenu:noop,contextMenuProps:{}})},
'../LockedHintTooltip':{LockedHintTooltip:Empty},'../LockedActionButton':{LockedActionButton:Empty},'../call/LiveCallDropTile':{LiveCallDropTile:Empty},
};
function load(source){const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>{assert.ok(id in deps,id);return deps[id];},console,setTimeout,clearTimeout});return exports.EditorialDropItem;}
const Before=load(original),After=load(current);
for(const theme of ['light','dark','minimal'])for(const virtualMode of [false,true])test('D absent retention callback preserves exact '+theme+' virtual='+virtualMode+' card markup',()=>{
 const drop={id:'parity',name:'Parity',type:'text',content:'plain',createdAt:new Date(0),expiresAt:null,userId:'owner'};
 const props={drop,theme,virtualMode,onPreview:noop,onDelete:noop,onSelect:noop,selected:false,selectionMode:false,currentUserId:'owner',allDrops:[drop]};
 assert.equal(renderToStaticMarkup(React.createElement(After,props)),renderToStaticMarkup(React.createElement(Before,props)));
});
