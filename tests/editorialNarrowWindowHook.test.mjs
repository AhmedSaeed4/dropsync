import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
register('./helpers/hook-module-loader.mjs', import.meta.url);
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><body></body>');
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const queue = new Map(); let serial = 0;
globalThis.requestAnimationFrame = cb => { const id=++serial; queue.set(id,cb); return id; };
globalThis.cancelAnimationFrame = id => queue.delete(id);
const observers=new Set();
class RO { constructor(cb){this.cb=cb;this.targets=new Set();observers.add(this);} observe(el){this.targets.add(el);} unobserve(el){this.targets.delete(el);} disconnect(){this.targets.clear();observers.delete(this);} }
globalThis.ResizeObserver=RO;
globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
const React=await import('react'); const {act}=React;
const {createRoot}=await import('react-dom/client');
const available=existsSync(new URL('../src/hooks/useNarrowEditorialWindow.ts',import.meta.url));
const useWindow=available ? (await import('../src/hooks/useNarrowEditorialWindow.ts')).useNarrowEditorialWindow : (await import('../src/hooks/useEditorialWindow.ts')).useEditorialWindow;
console.log('REAL controller under test: '+(available?'narrow adapter':'unchanged wide hook in phone fixture'));
async function fixture({prefix=360,pad=0,n=100,budget=24,strict=false}={}) {
 const scroller=document.createElement('div');document.body.append(scroller);
 const stageRef={current:null}, scrollRef={current:scroller};
 const state={ids:Array.from({length:n},(_,i)=>'r'+i),heights:new Map(),prefix,width:390,offset:0,writes:0,retained:new Set(),budget,scope:'test-'+serial+'-'+Math.random()};
 Object.defineProperties(scroller,{clientWidth:{get:()=>state.width},clientHeight:{get:()=>500},scrollTop:{get:()=>state.offset,set:v=>{state.offset=v;state.writes++;}}});
 scroller.getBoundingClientRect=()=>({top:0,bottom:500,width:state.width,height:500});
 function List(){
  state.win=useWindow(state.scope,state.ids,stageRef,state.retained,state.budget,{scrollerRef:scrollRef,padding:pad});
  return React.createElement('div',{ref:el=>{stageRef.current=el;if(el){el.getBoundingClientRect=()=>({top:state.prefix-state.offset,width:state.width});}} ,style:{height:state.win.totalHeight}},state.win.rows.map(r=>React.createElement('div',{'data-row-id':r.id,key:r.id,ref:el=>{if(el)Object.defineProperty(el,'offsetHeight',{get:()=>state.heights.get(r.id)??160,configurable:true});}})));
 }
 const root=createRoot(scroller);
 const render=()=>act(async()=>root.render(strict ? React.createElement(React.StrictMode,null,React.createElement(List)) : React.createElement(List)));
 const frames=async()=>{for(let i=0;queue.size&&i<20;i++){const batch=[...queue];queue.clear();await act(async()=>{for(const [,cb] of batch)cb(i*16);});}assert.equal(queue.size,0,'idle reaches quiescence');};
 const scroll=async top=>act(async()=>{state.offset=top;scroller.dispatchEvent(new Event('scroll'));});
 const resize=async()=>{await act(async()=>{for(const ro of [...observers])ro.cb([]);});await frames();};
 const close=async()=>{await act(async()=>root.unmount());scroller.remove();await frames();};
 await render();await frames();return {state,render,frames,scroll,resize,close,scroller};
}
test('A real phone controller uses zero stage padding with nonzero scrolling prefix',async()=>{
 const f=await fixture();try{
 assert.equal(f.state.win.rows[0].top,0,'phone first row must start at stage zero, not desktop pad12');
 assert.equal(f.state.win.totalHeight,100*168-8,'stage excludes header and desktop pads');
 await f.scroll(360);await f.frames();assert.ok(f.state.win.rows.some(r=>r.id==='r0'),'header origin must not skip first card');
 assert.equal(f.state.writes,0,'scroll never compensates');
 }finally{await f.close();}
});
test('A prefix-aware fast jump covers the physical viewport without scroll writes',async()=>{
 const f=await fixture({prefix:2400,budget:4});try{
 await f.scroll(2400);await f.frames();assert.ok(f.state.win.rows.some(r=>r.id==='r0'),'physical header offset must map to row zero');
 assert.equal(f.state.writes,0);
 }finally{await f.close();}
});
test('A middle padding and retained exceptions preserve full extent',async()=>{
 const f=await fixture({prefix:0,pad:12});try{
 assert.equal(f.state.win.rows[0].top,12);const height=f.state.win.totalHeight;
 await f.scroll(10000);await f.frames();f.state.retained=new Set(['r0']);await f.render();await f.frames();
 assert.ok(f.state.win.rows.some(r=>r.id==='r0'));assert.equal(f.state.win.totalHeight,height);assert.equal(f.state.win.retainedRowCount,1);
 }finally{await f.close();}
});
test('A prefix growth anchors only readers in the rows, then acknowledgement is quiescent',async()=>{
 const f=await fixture();try{
 await f.scroll(360+50*168);await f.frames();const before=f.state.offset;f.state.prefix+=100;await f.resize();
 assert.equal(f.state.offset,before+100,'prefix resize must preserve visible row offset');
 const writes=f.state.writes;await f.scroll(f.state.offset);await f.frames();assert.equal(f.state.writes,writes);
 }finally{await f.close();}
});

test('A unchanged measurement batches reach quiescence without a second correction',async()=>{
 const f=await fixture();try{const v=f.state.win.geometryVersion;await f.resize();await f.render();await f.frames();assert.equal(f.state.win.geometryVersion,v);assert.equal(f.state.writes,0);}finally{await f.close();}
});
test('A changed height above the native anchor writes once and preserves row offset',async()=>{
 const f=await fixture();try{await f.scroll(360+50*168);await f.frames();const before=f.state.offset;f.state.heights.set('r47',460);await f.resize();assert.equal(f.state.offset,before+300);const writes=f.state.writes;await f.resize();assert.equal(f.state.writes,writes);}finally{await f.close();}
});
test('A bottom intent includes prefix and trailing extent',async()=>{
 const f=await fixture();try{await f.scroll(360+f.state.win.totalHeight-500);await f.frames();const before=f.state.offset;f.state.heights.set('r99',560);await f.resize();assert.equal(f.state.offset,before+400);}finally{await f.close();}
});
test('A prefix growth while reading header does not scroll to first card',async()=>{
 const f=await fixture();try{f.state.prefix+=200;await f.resize();assert.equal(f.state.offset,0);assert.equal(f.state.writes,0);}finally{await f.close();}
});
test('A scope displacement rebaselines without anchoring another workspace',async()=>{
 const f=await fixture();try{await f.scroll(5000);await f.frames();const writes=f.state.writes;f.state.scope='new-workspace';f.state.ids=f.state.ids.map(id=>'b'+id);await f.render();await f.frames();assert.equal(f.state.writes,writes);assert.ok(f.state.win.rows.every(r=>r.id.startsWith('b')));}finally{await f.close();}
});
test('A budget changes preserve geometry and input offset while shrinking the mounted set',async()=>{
 const f=await fixture({budget:60});try{const height=f.state.win.totalHeight;await f.scroll(5000);await f.frames();const before=f.state.offset;f.state.budget=24;await f.render();await f.frames();assert.equal(f.state.win.rows.length,24);assert.equal(f.state.offset,before);assert.equal(f.state.win.totalHeight,height);}finally{await f.close();}
});
test('A width change uses a fresh height bucket, then remeasures mounted facts',async()=>{
 const f=await fixture();try{f.state.heights.set('r0',300);await f.resize();assert.equal(f.state.win.rows[1].top,308);f.state.width=700;f.state.heights.set('r0',200);await f.resize();assert.equal(f.state.win.metrics.width,700);assert.equal(f.state.win.rows[1].top,208);}finally{await f.close();}
});
test('A native new input supersedes a pending correction echo',async()=>{
 const f=await fixture();try{await f.scroll(9000);await f.frames();f.state.prefix+=100;await f.resize();const writes=f.state.writes;await f.scroll(14000);await f.frames();assert.equal(f.state.writes,writes);assert.ok(f.state.win.rows.some(r=>Number(r.id.slice(1))>=80));}finally{await f.close();}
});
test('A emptied stage has no phantom padding and teardown leaves no observers or frames',async()=>{
 const f=await fixture({n:0});try{assert.equal(f.state.win.rows.length,0);assert.equal(f.state.win.totalHeight,0);}finally{await f.close();}assert.equal(observers.size,0);assert.equal(queue.size,0);
});

test("A StrictMode reacquisition leaves one observer and ignores disposed callbacks",async()=>{
 const f=await fixture({strict:true});const captured=[...observers];
 assert.equal(observers.size,1);assert.equal(f.state.writes,0);await f.close();
 for(const ro of captured)ro.cb([]);assert.equal(queue.size,0);assert.equal(observers.size,0);
});
test("A actual visible coverage overrides a smaller requested budget",async()=>{
 const f=await fixture({prefix:0,n:24,budget:2});try{assert.ok(f.state.win.rows.length>=3);await f.scroll(360);await f.frames();assert.ok(f.state.win.rows.length>=4);}finally{await f.close();}
});

test("A real controller token leases preserve a row until its final owner releases",async()=>{
 const f=await fixture();try{
 await f.scroll(10000);await f.frames();
 let release1,release2;
 await act(async()=>{release1=f.state.win.retain("r0");release2=f.state.win.retain("r0");});
 assert.ok(f.state.win.rows.some(r=>r.id==="r0"));
 await act(async()=>release1());assert.ok(f.state.win.rows.some(r=>r.id==="r0"));
 await act(async()=>release2());assert.ok(!f.state.win.rows.some(r=>r.id==="r0"));
 }finally{await f.close();}
});

test("B coherent client tier is correct on first mount and at all boundary crossings",async()=>{
 const {useEditorialClientTier}=await import("../src/hooks/useEditorialClientTier.ts");
 let width=390;const listeners=new Set();
 window.matchMedia=q=>({get matches(){return q.includes("max-width")?width<=767:width>=1400;},addEventListener:(e,fn)=>listeners.add(fn),removeEventListener:(e,fn)=>listeners.delete(fn)});
 const output=[];function Tier(){output.push(useEditorialClientTier());return null;}
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 try{await act(async()=>root.render(React.createElement(Tier)));assert.equal(output[0],"phone");
 for(const [w,expected] of [[767,"phone"],[768,"middle"],[767,"phone"],[768,"middle"],[1280,"middle"],[1399,"middle"],[1400,"wide"],[1399,"middle"],[1600,"wide"],[1399,"middle"],[767,"phone"]]){
 width=w;await act(async()=>{for(const fn of listeners)fn();});assert.equal(output.at(-1),expected);
 }
 for(const [w,expected] of [[390,"phone"],[768,"middle"],[1280,"middle"],[1399,"middle"],[1400,"wide"],[1600,"wide"]]){
 width=w;output.length=0;await act(async()=>root.render(React.createElement(Tier,{key:w})));assert.equal(output[0],expected,"direct mount "+w);
 }}finally{await act(async()=>root.unmount());node.remove();}assert.equal(listeners.size,0);
});
