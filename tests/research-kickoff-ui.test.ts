import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import { parseDecisions } from "../src/step-decisions.ts";

test("实际开工确认：上游摘要可见，决定可填写/撤回，最终任务书带人工答案", async () => {
  const bundle = await build({
    stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Kickoff} from './src/components/KickoffConfirmDialog';`, resolveDir: process.cwd(), loader: "tsx" },
    bundle:true,write:false,format:"cjs",platform:"node",jsx:"automatic",external:["react","react-dom/client","react/jsx-runtime"],
    plugins:[{name:"host",setup(b){
      b.onResolve({filter:/^\.\.\/store$/},()=>({path:'store',namespace:'stub'}));
      b.onResolve({filter:/^\.\/HumanTasksList$/},()=>({path:'human',namespace:'stub'}));
      b.onResolve({filter:/^\.\.\/pipeline-start$/},(args)=>args.importer.endsWith('KickoffConfirmDialog.tsx')?{path:'pipeline',namespace:'stub'}:undefined);
      b.onLoad({filter:/.*/,namespace:'stub'},(args)=>({loader:'js',resolveDir:process.cwd(),contents:args.path==='store'?'export const useAppStore=fn=>fn(globalThis.__kickoffStore);':args.path==='human'?'export default function Human(){return null;}':"export {renderTaskMd} from './src/task-md.ts'; export const gatherTaskMdExtras=async()=>({artifacts:[],skillMeta:{},decisions:[]});"}));
    }}],
  });
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
  const restore:Array<[string,PropertyDescriptor|undefined]>=[];
  const state={profiles:[{id:'p1',name:'Test profile',agent:'codex',models:['test-model'],accountType:'api'}],agents:[{id:'codex',binaryPath:'/usr/bin/test'}],setPage(){}};
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,requestAnimationFrame:(f:()=>void)=>{f();return 0;},cancelAnimationFrame:()=>{},IS_REACT_ACT_ENVIRONMENT:true,__kickoffStore:state})){
    restore.push([key,Object.getOwnPropertyDescriptor(globalThis,key)]);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const calls:string[]=[];
  Object.assign(dom.window,{__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{
    calls.push(command);
    if(command==='list_skills')return[];if(command==='read_task_draft')return {relPath:'.ccode/drafts/exp-run.md',text:null};
    if(command==='git_status')return {isRepo:true,files:[]};
    if(['inspect_step_inputs','list_skills','discover_resources','list_legacy_briefs','list_human_task_states','list_dir'].includes(command))return [];
    if(command==='read_file_preview'){
      assert.equal(args.root,'/project');assert.equal(args.requireWithinRoot,true);
      if(args.path==='/project/design.md')return {text:'# Design\n## 决策摘要\n- 方案 A：有限范围、预算一小时\n- 证据：预实验 v2\n- 等待边界：未批准不运行\n## Methods\n细节',truncated:false,revision:'v2'};
      throw new Error('no report');
    }
    throw new Error(command);
  }}});
  const mod={exports:{} as Record<string,any>};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
  const {createElement:h,act,createRoot,Kickoff}=mod.exports;
  const host=dom.window.document.getElementById('root')!, root=createRoot(host);
  const template=PIPELINE_TEMPLATES.find(t=>t.id==='research-paper')!, step=template.steps.find(s=>s.workspaceName==='exp-run')!;
  let confirmed='';
  const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===name)!;
  const enter=async(el:HTMLInputElement,value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  try{
    await act(async()=>root.render(h(Kickoff,{projectPath:'/project',step,cfg:{steps:template.steps,resources:[],artifactDir:'artifacts'},originCardId:null,busy:false,onCancel(){},onConfirm:(text:string)=>{confirmed=text;}})));
    assert.match(host.textContent!,/方案 A：有限范围/);
    assert.match(host.textContent!,/查看原文：design.md/);
    const confirm=()=>button('确认开始');
    assert.ok(confirm().disabled);
    const status=host.querySelector<HTMLSelectElement>('fieldset select')!;
    const input=host.querySelector<HTMLInputElement>('fieldset input:not([type="checkbox"])');
    assert.ok(input instanceof dom.window.HTMLInputElement, '决定说明输入框必须可填写');
    const choose=async(value:string)=>act(async()=>{status.value=value;status.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
    await choose('wait');
    await enter(input,'待补证据，暂不批准');
    assert.ok(confirm().disabled,'待补不能开工');
    await choose('reject');
    await enter(input,'拒绝当前方案');
    assert.ok(confirm().disabled,'不批准不能开工');
    await choose('approve');
    await enter(input,'选择方案 A，批准 design v2；许可依据 E1');
    assert.equal(confirm().disabled,false);
    await enter(input,'');assert.equal(confirm().disabled,true);
    await enter(input,'选择方案 A，批准 design v2；许可依据 E1');
    await act(async()=>confirm().click());
    const recorded = parseDecisions(confirmed).get(step.decisions![0].q)!;
    assert.match(recorded, /\[批准指定范围\]/);
    assert.match(recorded, /选择方案 A，批准 design v2；许可依据 E1/);
    assert.match(confirmed,/G3 数据与实现/);
    assert.ok(!calls.includes('write_task_draft'),'确认弹层不悄悄改盘，最终任务书由既有开工链落盘');
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,d]of restore){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}}
});

test("开工弹层手选守卫：异步 profiles 引用替换不再顶回用户手改的启动三连", async () => {
  const bundle = await build({
    stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Kickoff} from './src/components/KickoffConfirmDialog';`, resolveDir: process.cwd(), loader: "tsx" },
    bundle:true,write:false,format:"cjs",platform:"node",jsx:"automatic",external:["react","react-dom/client","react/jsx-runtime"],
    plugins:[{name:"host",setup(b){
      b.onResolve({filter:/^\.\.\/store$/},()=>({path:'store',namespace:'stub'}));
      b.onResolve({filter:/^\.\/HumanTasksList$/},()=>({path:'human',namespace:'stub'}));
      b.onResolve({filter:/^\.\.\/pipeline-start$/},(args)=>args.importer.endsWith('KickoffConfirmDialog.tsx')?{path:'pipeline',namespace:'stub'}:undefined);
      b.onLoad({filter:/.*/,namespace:'stub'},(args)=>({loader:'js',resolveDir:process.cwd(),contents:args.path==='store'?'export const useAppStore=fn=>fn(globalThis.__kickoffStore);':args.path==='human'?'export default function Human(){return null;}':"export {renderTaskMd} from './src/task-md.ts'; export const gatherTaskMdExtras=async()=>({artifacts:[],skillMeta:{},decisions:[]});"}));
    }}],
  });
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
  const restore:Array<[string,PropertyDescriptor|undefined]>=[];
  // 两个 agent 各一条连接：codex p1 在前（无任何预填源时 pickKickoffLaunch 会选它）
  const state={profiles:[
    {id:'p1',name:'Codex relay',agent:'codex',models:['test-model'],accountType:'api'},
    {id:'p2',name:'Claude relay',agent:'claude-code',models:['claude-model'],accountType:'api'},
  ],agents:[{id:'codex',binaryPath:'/usr/bin/test'},{id:'claude-code',binaryPath:'/usr/bin/test'}],setPage(){}};
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,requestAnimationFrame:(f:()=>void)=>{f();return 0;},cancelAnimationFrame:()=>{},IS_REACT_ACT_ENVIRONMENT:true,__kickoffStore:state})){
    restore.push([key,Object.getOwnPropertyDescriptor(globalThis,key)]);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  Object.assign(dom.window,{__TAURI_INTERNALS__:{invoke:async(command:string)=>{
    if(command==='list_skills')return[];if(command==='read_task_draft')return {relPath:'.ccode/drafts/exp-run.md',text:null};
    if(command==='git_status')return {isRepo:true,files:[]};
    if(['inspect_step_inputs','discover_resources','list_legacy_briefs','list_human_task_states','list_dir','combo_surface'].includes(command))return command==='combo_surface'?{}:[];
    if(command==='read_file_preview')return {text:'# Design\n## 决策摘要\n- 方案 A\n## Methods\n细节',truncated:false,revision:'v1'};
    throw new Error(command);
  }}});
  const mod={exports:{} as Record<string,any>};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
  const {createElement:h,act,createRoot,Kickoff}=mod.exports;
  const host=dom.window.document.getElementById('root')!, root=createRoot(host);
  const template=PIPELINE_TEMPLATES.find(t=>t.id==='research-paper')!, step=template.steps.find(s=>s.workspaceName==='exp-run')!;
  const props=()=>({projectPath:'/project',step,cfg:{steps:template.steps,resources:[],artifactDir:'artifacts'},originCardId:null,busy:false,onCancel(){},onConfirm(){}});
  const selectOf=(needle:string)=>host.querySelector<HTMLSelectElement>('select')!
    ? Array.from(host.querySelectorAll('select')).find(s=>Array.from(s.options).some(o=>o.value===needle))! : null!;
  try{
    await act(async()=>root.render(h(Kickoff,props())));
    // 初始预选 = profiles[0]（codex p1）
    const agentSel=selectOf('claude-code')!;
    assert.equal(agentSel.value,'codex');
    // 用户手选换到 claude-code（对应连接 p2）
    await act(async()=>{agentSel.value='claude-code';agentSel.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
    assert.equal(agentSel.value,'claude-code');
    assert.equal(selectOf('p2')!.value,'p2','换 agent 后连接跟随');
    // 窗口聚焦→loadAll→profiles 数组引用替换（内容不变）：守卫生效则手选保留
    state.profiles=[...state.profiles];
    await act(async()=>root.render(h(Kickoff,props())));
    assert.equal(agentSel.value,'claude-code','手选不被异步刷新顶回（本次手选永远最高）');
    assert.equal(selectOf('p2')!.value,'p2','连接与模型一并保留');
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,d]of restore){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}}
});
