import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("实际评审页接入本步骤摘要/未决项和复现；只读历史不运行", async () => {
  const bundle=await build({stdin:{contents:`export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Review} from './src/components/WorkspaceReviewView';`,resolveDir:process.cwd(),loader:'tsx'},loader:{'.css':'empty'},bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react-dom/client','react/jsx-runtime'],plugins:[{name:'host',setup(b){
    b.onResolve({filter:/^\.\.\/store$/},()=>({path:'store',namespace:'stub'}));
    b.onResolve({filter:/^\.\/ArtifactChecklist$/},()=>({path:'artifacts',namespace:'stub'}));
    b.onResolve({filter:/^\.\/WatchRunReview$/},()=>({path:'watch',namespace:'stub'}));
    b.onResolve({filter:/^\.\/OfficePreviewModal$/},()=>({path:'preview',namespace:'stub'}));
    b.onResolve({filter:/^\.\/ConfirmDialog$/},()=>({path:'confirm',namespace:'stub'}));
    // Vite 专属的 ?worker/?url 导入（monaco/pdfjs 的 worker）：Node 测试里按空资产桩掉
    b.onResolve({filter:/\?(worker|url)$/},()=>({path:'asset',namespace:'stub'}));
    b.onLoad({filter:/.*/,namespace:'stub'},(args)=>({loader:'js',contents:args.path==='asset'?'export default "data:text/javascript,";':args.path==='confirm'?'export const confirmDialog=async()=>true;':args.path==='store'?'export const useAppStore=Object.assign(fn=>fn(globalThis.__reviewStore),{getState:()=>globalThis.__reviewStore});':args.path==='artifacts'?'export const loadArtifactRows=async()=>[];':'export default function Watch(){return null;}'}));
  }}]});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true});
  const restore:Array<[string,PropertyDescriptor|undefined]>=[];
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true,DOMMatrix:class{multiplySelf(){return this}preMultiplySelf(){return this}invertSelf(){return this}translateSelf(){return this}scaleSelf(){return this}multiply(){return this}inverse(){return this}},__reviewStore:{setPage(){},setSelectProjectReq(){},setFilePreviewReq(){},setPendingTerminal(){throw new Error('no run expected');},runningScripts:{}}})){
    restore.push([key,Object.getOwnPropertyDescriptor(globalThis,key)]);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  let reviewOnly=false;
  let canMerge=false;
  let mergedArgs:any=null;
  let skipArgs:any=null;
  const calls:string[]=[];
  const template=PIPELINE_TEMPLATES.find(t=>t.id==='research-paper')!,step=template.steps.find(s=>s.workspaceName==='exp-run')!;
  Object.assign(dom.window,{__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{
    calls.push(command);
    if(command==='workspace_diff')return {inWorkspace:true,workspaceId:'w',workspaceName:'exp-run',branch:'ccode/test',reviewOnly,baseBranch:'main',files:[],ahead:canMerge?1:0,totalAdd:0,totalDel:0};
    if(command==='git_status')return {isRepo:true,branch:'ccode/test',ahead:0,behind:0,files:[],totalAdd:0,totalDel:0};
    if(command==='workspace_health')return {conflict:false,uncommitted:false,mainDirty:false,mainOffBase:false,readyToMerge:canMerge,worktreeHead:'a'.repeat(40),ahead:canMerge?1:0,behind:0};
    if(command==='merge_workspace'){mergedArgs=args;canMerge=false;return {merged:true,archived:false,ledgerWritten:true,versionId:'b'.repeat(40),message:'已接收',output:''};}
    if(command==='workspace_review_deliverables')return {token:'frozen-files',workspaceId:'w',projectRoot:'/project',payloadDir:'/frozen/files',files:[{path:'papers/result.pdf',size:12,sha256:'a'.repeat(64),disposition:'copy'}]};
    if(command==='workspace_delivery_skip'){skipArgs=args;return {token:'frozen-files',workspaceId:'w',projectRoot:'/project',payloadDir:'/frozen/files',files:[{path:'papers/result.pdf',size:12,sha256:'a'.repeat(64),disposition:args.skip?'skipped':'copy'},{path:'output/report.pdf',size:20,sha256:'b'.repeat(64),disposition:'copy',required:true}]};}
    if(command==='workspace_unmerged_files')return {merging:false,files:[],staleBase:false};
    if(command==='list_workspaces')return [{id:'w',name:'exp-run',status:'active',repoPath:'/project',worktreePath:'/tree',mergedAt:null}];
    if(command==='read_project_config')return {config:{steps:[step],resources:[]}};
    if(command==='check_citation_health')return {bibFound:true,totalRefs:1,resolved:1,missing:[]};
    if(command==='workspace_settings')return {run:[],runMode:'nonconcurrent'};
    if(command==='list_human_task_states'||command==='list_dir')return [];
    if(command==='research_get_acceptance')return null;
    if(command==='research_get_run')throw new Error('no run');
    if(command==='read_file_preview'){
      assert.equal(args.root,'/tree');assert.equal(args.requireWithinRoot,true);
      return args.path.endsWith('.py')?{text:'print("test")',revision:'script',truncated:false}:{text:'# 实验结果\n## 验收摘要\n- 回答：执行记录齐全\n- 未决问题：独立复算待完成\n- 质量状态：待审\n## 实验\n正文',revision:'report',truncated:false};
    }
    throw new Error(command);
  }}});
  const module={exports:{} as Record<string,any>};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const{createElement:h,act,createRoot,Review}=module.exports;
  const host=dom.window.document.getElementById('root')!,root=createRoot(host);
  try{
    await act(async()=>root.render(h(Review,{worktreePath:'/tree',onClose(){}})));
    assert.match(host.textContent!,/验收摘要与未决项/);assert.match(host.textContent!,/独立复算待完成/);assert.match(host.textContent!,/基础检查/);
    assert.match(host.textContent!,/复现运行/);assert.match(host.textContent!,/科研验收决定/);
    // 2026-10-24：清单默认收成一行摘要（附带文件 · 带回 N / M 项），点开才列
    assert.match(host.textContent!,/附带文件/);assert.match(host.textContent!,/带回 1 \/ 1 项/);
    assert.doesNotMatch(host.textContent!,/papers\/result.pdf/);
    const toggle=host.querySelector('section[aria-label="非 Git 产物评审"] button[aria-expanded]') as HTMLButtonElement;
    await act(async()=>toggle.click());
    assert.match(host.textContent!,/papers\/result.pdf/);
    // 逐个勾掉不带回（2026-10-22）：取消勾选即记成不带回，计数随之变；流程要用的排在前面
    const keep=Array.from(host.querySelectorAll('section[aria-label="非 Git 产物评审"] input[type=checkbox]')).find(b=>!(b as HTMLInputElement).disabled) as HTMLInputElement;
    assert.ok(keep&&keep.checked,'可带回的产物默认勾上');
    await act(async()=>keep.click());
    assert.deepEqual({path:skipArgs.path,skip:skipArgs.skip,token:skipArgs.token},{path:'papers/result.pdf',skip:true,token:'frozen-files'});
    assert.match(host.textContent!,/带回 1 \/ 2 项/);assert.match(host.textContent!,/不带回/);
    // 流程要用的锁定勾上，不给取消
    const boxes=Array.from(host.querySelectorAll('section[aria-label="非 Git 产物评审"] input[type=checkbox]')) as HTMLInputElement[];
    assert.equal(boxes.length,2);assert.ok(boxes[0].checked&&boxes[0].disabled);assert.match(host.textContent!,/流程要用/);
    await act(async()=>keep.click());
    assert.equal(skipArgs.skip,false,'再勾上就是带回');
    // 「只带流程要用的」：其余能勾的一键勾掉
    const only=Array.from(host.querySelectorAll('section[aria-label="非 Git 产物评审"] button')).find(b=>b.textContent==='只带流程要用的') as HTMLButtonElement;
    assert.ok(only,'有可勾掉的中间文件时给一键按钮');
    await act(async()=>only.click());
    assert.deepEqual({path:skipArgs.path,skip:skipArgs.skip},{path:'papers/result.pdf',skip:true});
    assert.ok(!calls.some(c=>['shell_spawn','pty_write','merge_workspace'].includes(c)), '打开评审不会执行代码或保存进项目');
    reviewOnly=true;
    await act(async()=>root.render(h(Review,{key:'history',worktreePath:'/history',onClose(){}})));
    assert.doesNotMatch(host.textContent!,/复现运行/);
    reviewOnly=false;canMerge=true;
    await act(async()=>root.render(h(Review,{key:'merge',worktreePath:'/tree',onClose(){}})));
    const merge=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='保存进项目');
    assert.ok(merge && !merge.disabled);
    await act(async()=>merge.click());
    assert.equal(mergedArgs.expectDeliveryToken,'frozen-files');
    assert.equal(mergedArgs.expectReviewedSha,'a'.repeat(40));
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,d]of restore){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}}
});
