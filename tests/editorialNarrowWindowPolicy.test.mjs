import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
register('./helpers/hook-module-loader.mjs',import.meta.url);
const { projectNarrowGeometry } = await import('../src/lib/editorialNarrowWindowGeometry.ts');
const { computeGeometry } = await import('../src/lib/editorialWindowModel.ts');
const {registerNarrowWindowReadout:registerReadout,getNarrowWindowSnapshot,subscribeNarrowWindowReadout,resolveEditorialWindowPolicy}=await import('../src/lib/editorialNarrowWindowReadout.ts');
test('A geometry projection has separate stage and native extents for asymmetric header/tail',()=>{
 const g=projectNarrowGeometry(['a','b'],()=>100,{origin:300,trailing:112,padding:0,width:390});
 assert.deepEqual(g.stage.tops,[0,108]);assert.deepEqual(g.physical.tops,[300,408]);assert.equal(g.stage.total,208);assert.equal(g.physical.total,620);
});
test('A middle projection exactly equals unchanged model and empty has no phantom stage',()=>{
 const ids=['a','b','c'];const g=projectNarrowGeometry(ids,()=>123,{origin:0,trailing:0,padding:12,width:1280});
 assert.deepEqual(g.stage,computeGeometry(ids,()=>123));assert.deepEqual(g.physical,g.stage);
 assert.equal(projectNarrowGeometry([],()=>0,{origin:300,trailing:112,padding:0,width:390}).stage.total,0);
});
const sample=(count=24)=>({mountedRowIdsCount:count,retainedRowCount:0,exitingRowCount:0,geometryVersion:1,ready:true,stageOrigin:300,stageWidth:390,viewportWidth:390,scrollTop:0,viewportHeight:700});
const metadata=view=>({view,mounted:true,requestedTab:'drops',displayedTab:'drops',preparing:false,hidden:view!=='drops',N:610,F:610,policy:resolveEditorialWindowPolicy(),appliedBudget:24,branch:'window-plain',mounts:1,measuredAt:1,revealedAt:1});
function env(value){const previous=process.env.NODE_ENV;process.env.NODE_ENV=value;return()=>{process.env.NODE_ENV=previous;};}
test('A readout registers only on exact development-loopback hosts',()=>{
 const restore=env('development');try{
 for(const host of ['example.com','localhost.example','localhost:3000','127.0.0.2'])assert.equal(registerReadout(host,'bad'),null);
 for(const host of ['localhost','127.0.0.1','[::1]']){const lease=registerReadout(host,host);assert.ok(lease);lease.dispose();}
 }finally{restore();}
});
test('A production is dead even with explicit development policy seam',()=>{
 const restore=env('production');try{assert.equal(registerReadout('localhost','x'),null);assert.equal(getNarrowWindowSnapshot(),null);assert.equal(resolveEditorialWindowPolicy({host:'localhost',search:'?editorialWindowBudget=12',isDev:true}).effectiveBudget,24);}finally{restore();}
});
test('A all exact ladder values apply in development without changing production default',()=>{
 const restore=env('development');try{for(const value of [60,48,36,24,16,12])assert.equal(resolveEditorialWindowPolicy({host:'localhost',search:'?editorialWindowBudget='+value,isDev:true}).effectiveBudget,value);}finally{restore();}
});
test('A two visited views remain separately owned, samples are pulled without frame publishing',()=>{
 const restore=env('development');let a,b;try{
 let changes=0,count=24;const off=subscribeNarrowWindowReadout(()=>changes++);
 a=registerReadout('localhost','scope:drops');b=registerReadout('localhost','scope:search');
 a.publish(metadata('drops'),()=>sample(count));b.publish(metadata('search'),()=>sample(16));
 const boundary=changes;assert.equal(getNarrowWindowSnapshot().length,2);count=12;assert.equal(getNarrowWindowSnapshot()[0].mountedRowIdsCount,12);assert.equal(changes,boundary);off();
 }finally{a?.dispose();b?.dispose();restore();}
});
test('A stale lease cannot publish or erase replacement, unavailable differs from measured zero',()=>{
 const restore=env('development');let stale,current;try{
 stale=registerReadout('localhost','same');current=registerReadout('localhost','same');
 current.publish(metadata('drops'),()=>({...sample(),mountedRowIdsCount:null,ready:false}));
 stale.publish(metadata('search'),()=>sample(99));stale.dispose();
 assert.equal(getNarrowWindowSnapshot()[0].mountedRowIdsCount,null);
 current.publish(metadata('drops'),()=>sample(0));assert.equal(getNarrowWindowSnapshot()[0].mountedRowIdsCount,0);
 }finally{stale?.dispose();current?.dispose();restore();}
});
test('A unmounted views report no applied budget and observer subscriber cannot break UI',()=>{
 const restore=env('development');let lease,off;try{
 off=subscribeNarrowWindowReadout(()=>{throw Error('observer only');});lease=registerReadout('localhost','unopened');
 lease.publish({...metadata('search'),mounted:false,appliedBudget:null},()=>({...sample(),ready:false,mountedRowIdsCount:0}));
 assert.equal(getNarrowWindowSnapshot()[0].appliedBudget,null);assert.equal(getNarrowWindowSnapshot()[0].mounted,false);
 }finally{off?.();lease?.dispose();restore();}
});
