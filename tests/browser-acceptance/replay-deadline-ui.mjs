import { chromium, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { interactiveEvidence } from "./evidence.mjs";
import readline from "node:readline";
import { satFormalCases } from "../../tests/synth/formal-sat-cases.mjs";
import { sbyCases } from "../../tests/synth/formal-sby-cases.mjs";
import { smtVhdlReplayCases } from "../../tests/synth/formal-smt-vhdl-replay-cases.mjs";
const { out, baseURL, revision } = interactiveEvidence();
const browser = await chromium.launch({headless:false,args:["--start-maximized","--lang=ja-JP","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const context = await browser.newContext({viewport:null,locale:"ja-JP"});
await context.tracing.start({screenshots:true,snapshots:true,sources:true});
const page = await context.newPage();
const evidence = {browser:browser.version(),revision,events:[],results:[]};
const save = () => writeFileSync(out+"browser-runtime.json", JSON.stringify(evidence,null,2));
let nextWorker=0;
const activeWorkers=new Map();
page.on("worker",worker=>{
 const id=++nextWorker;
 activeWorkers.set(id,worker.url());
 evidence.events.push({type:"worker-open",id,url:worker.url(),at:Date.now()});save();
 worker.on("close",()=>{
  activeWorkers.delete(id);
  evidence.events.push({type:"worker-close",id,url:worker.url(),at:Date.now()});save();
 });
});
async function noWorkers(label, includeIdleSim=false) {
 await expect.poll(()=>[...activeWorkers.values()].filter(url=>/formal-(wasi|python)-worker|solver-worker/.test(url)||(includeIdleSim&&/sim-worker/.test(url))).length,{timeout:15000}).toBe(0);
 evidence.events.push({type:"no-live-product-workers",label,at:Date.now()});save();
}
for (const type of ["console","pageerror","worker","requestfailed"]) page.on(type, e => {
  evidence.events.push({at:new Date().toISOString(),type,text:type==="console"?`${e.type()}: ${e.text()}`:type==="worker"?e.url():String(e)});
  save();
});
page.on("response", async r => {evidence.events.push({at:new Date().toISOString(),type:"response",url:r.url(),status:r.status()});save();});
page.setDefaultTimeout(30000);
const $ = s => page.locator(s);
async function snap(name) { await page.screenshot({path:out+name+".png"}); }
async function state(name) {
  const s = {name,at:new Date().toISOString(),status:await $("#formal-status").textContent(),outcome:await $("#formal-status").getAttribute("data-outcome"),
    log:await $("#program-log").textContent(),top:await $("#formal-top").inputValue(),clock:await $("#formal-clock").inputValue()};
  evidence.results.push(s); save(); console.log(JSON.stringify(s)); return s;
}
async function saved() {await expect($("#project-status")).toHaveText("保存しました。");}
async function editor(source) {await $(".cm-content").click();await page.keyboard.press("Control+A");await page.keyboard.insertText(source);await saved();}
async function settings() {await $("#right-tab-verify").click();}
async function topview() {await page.evaluate(()=>scrollTo(0,0));}
async function newProject(name,language="verilog") {
  await $("#new-project-button").click();
  await expect($("#new-project-dialog")).toBeVisible();
  await $("#new-project-name").fill(name);
  await $("#new-project-language").selectOption(language);
  await $("#new-project-create").click();
  await expect($("#project-name")).toHaveText(name);await saved();
}
async function configure({engine="yosys-sat",mode="bmc",depth=8,clock="",top="top",timeout=30}={}) {
  await settings();await $("#formal-engine").selectOption(engine);
  if(engine==="smtbmc") await $("#formal-solver").selectOption("yices2");
  for(const [id,value] of Object.entries({mode,depth,clock,top,timeout})) {
    if(id==="mode") await $("#formal-mode").selectOption(String(value));
    else await $("#formal-"+id).fill(String(value));
  }
  await $("#formal-top").press("Tab");await saved();
}
async function armRun(name) {
  await saved();
  await expect($("#formal-button")).toHaveText("形式検証");
  await page.evaluate(name=>{
    window.__formalObserver?.disconnect();
    const events=[];
    window.__formalTrace={name,events};
    const record=()=>{
      events.push({at:performance.now(),status:document.querySelector("#formal-status").textContent,
        outcome:document.querySelector("#formal-status").dataset.outcome,
        button:document.querySelector("#formal-button").textContent});
    };
    window.__formalObserver=new MutationObserver(record);
    window.__formalObserver.observe(document.querySelector("#formal-status"),{subtree:true,childList:true,attributes:true,characterData:true});
    window.__formalObserver.observe(document.querySelector("#formal-button"),{subtree:true,childList:true,attributes:true,characterData:true});
    record();
  },name);
}
async function began() {
  await page.waitForFunction(()=>window.__formalTrace.events.some(e=>e.outcome==="running"&&e.button==="停止"));
}
async function ended() {
  await page.waitForFunction(()=>{
    const events=window.__formalTrace.events, start=events.findIndex(e=>e.outcome==="running"&&e.button==="停止");
    return start>=0&&events.slice(start+1).some(e=>e.outcome!=="running"&&e.button==="形式検証");
  },null,{timeout:120000});
  await expect($("#formal-button")).toHaveText("形式検証");
  const trace=await page.evaluate(()=>window.__formalTrace);
  evidence.events.push({type:"run-state-transitions",...trace});save();
}
async function run(name,expected,replay) {
  await armRun(name);
  const start=Date.now();await $("#formal-button").click();
  await began();await ended();
  await expect($("#formal-status")).toContainText(expected);
  if(replay) await expect($("#program-log")).toContainText("反例の再実行: "+replay);
  const s = await state(name);s.elapsedMs=Date.now()-start;save();
  return s;
}
async function wave() {
  await $("#bottom-tab-waveform").click();
  await expect($("#surfer-frame")).toHaveCount(1);
  await expect($("#waveform-status")).toContainText(/./);
}
async function reloadSelect(name) {await page.reload();await saved();await $("#project-select").selectOption({label:name});await expect($("#project-name")).toHaveText(name);await settings();}
await page.goto(baseURL);await saved();
await page.getByRole("button",{name:"案内を閉じる",exact:true}).click();
console.log("READY "+browser.version());
const commands = {
 async replaydeadline() {
   await newProject("再実行の期限確認");
   const source=satFormalCases.find(x=>x.name==="broken-identity").source.replace("endmodule",`
// synopsys translate_off
  integer replay_busy;
  initial begin
    for (replay_busy = 0; replay_busy < 1000000000; replay_busy = replay_busy + 1) begin end
  end
// synopsys translate_on
endmodule`);
   writeFileSync(out+"stress-input.v",source);
   await editor(source);
   await configure({clock:"",depth:8,timeout:3});await armRun("independent replay deadline");
   const replayCreated=page.waitForEvent("worker",{predicate:w=>w.url().includes("sim-worker"),timeout:10000});
   const start=Date.now();await $("#formal-button").click();await began();
   await replayCreated;await ended();
   await expect($("#formal-status")).toContainText("時間上限に達しました");
   await noWorkers("independent replay deadline",true);
   evidence.replayDeadlineMs=Date.now()-start;save();await state("replay deadline, simulation worker closed");
   await page.evaluate(ms=>{
     const p=document.createElement("pre");p.id="test-timing";p.style.cssText="position:fixed;bottom:8px;left:8px;background:#fff7d6;color:#111;z-index:9999;padding:10px;border:2px solid #8c6a00";
     p.textContent=`試験計測: 設定期限3秒 / Icarus worker生成を確認 / 完了まで ${ms} ms\n未終了の形式検証・solver・Icarus worker数: 0`;document.body.append(p);
   },evidence.replayDeadlineMs);
   await snap("independent-replay-timeout");await $("#test-timing").evaluate(e=>e.remove());
   await editor(satFormalCases.find(x=>x.name==="broken-identity").source);
   await configure({clock:"",depth:8,timeout:60});
   await run("counterexample after replay timeout","反例が見つかりました","確認済み");
 },
 async recursive() {
   await newProject("再帰停止の追加確認");
   await editor(sbyCases.find(x=>x.name==="prove-invariant").source);
   await configure({engine:"smtbmc",depth:1000,clock:"clk",timeout:60});
   await $("#formal-solver").scrollIntoViewIfNeeded();await snap("yices-selected");
   await armRun("recursive solver stop");
   const solverCreated=page.waitForEvent("worker",{predicate:w=>w.url().includes("solver-worker"),timeout:30000});
   await $("#formal-button").click();await began();await solverCreated;
   await expect($("#formal-button")).toHaveText("停止");
   await $("#formal-button").click();await ended();
   await expect($("#formal-status")).toContainText("停止");
   await noWorkers("recursive solver stop");
   await state("recursive solver stop, all workers closed");await snap("recursive-stop");
   await configure({engine:"smtbmc",depth:6,clock:"clk",timeout:60});
   await run("Yices restart after recursive stop","境界付きで安全");await noWorkers("recursive restart");
 },
 async recursivetimeout() {
   await configure({engine:"smtbmc",depth:1000,clock:"clk",timeout:6});
   await armRun("recursive solver timeout");
   const solverCreated=page.waitForEvent("worker",{predicate:w=>w.url().includes("solver-worker"),timeout:20000});
   const start=Date.now();await $("#formal-button").click();await began();await solverCreated;await ended();
   await expect($("#formal-status")).toContainText("時間上限に達しました");
   await noWorkers("recursive solver timeout");
   evidence.recursiveDeadlineMs=Date.now()-start;save();await state("recursive solver timeout, all workers closed");
   await page.evaluate(ms=>{
    const p=document.createElement("pre");p.id="test-timing";p.style.cssText="position:fixed;bottom:8px;left:8px;background:#fff7d6;color:#111;z-index:9999;padding:10px;border:2px solid #8c6a00";
    p.textContent=`試験計測: 設定期限6秒 / solver生成を確認 / 完了まで ${ms} ms\nsolver・SBY・WASI workerの未終了数: 0`;document.body.append(p);
   },evidence.recursiveDeadlineMs);
   await snap("recursive-timeout");await $("#test-timing").evaluate(e=>e.remove());
   await configure({engine:"smtbmc",depth:6,clock:"clk",timeout:60});
   await run("Yices restart after recursive timeout","境界付きで安全");await noWorkers("recursive timeout restart");
 },
 async replaystop() {
   await editor(satFormalCases.find(x=>x.name==="depth4").source);
   await configure({clock:"clk",depth:4,timeout:60});await armRun("independent replay stop");
   const replayCreated=page.waitForEvent("worker",{predicate:w=>w.url().includes("sim-worker"),timeout:30000});
   await $("#formal-button").click();await began();await replayCreated;
   if(await $("#formal-button").textContent()!=="停止") throw Error("Replay finished before UI stop; scenario not triggered");
   await $("#formal-button").click();await ended();
   await expect($("#formal-status")).toContainText("停止");
   await noWorkers("independent replay stop",true);await state("independent replay stop, all workers closed");
   await expect($("#surfer-frame")).toHaveCount(0);await snap("replay-stop");
   await run("counterexample after replay stop","反例が見つかりました","確認済み");
   await noWorkers("replay restart");
 },
 async activeswitch() {
   await configure({engine:"smtbmc",clock:"clk",depth:1000,timeout:60});
   await armRun("active project switch");
   const solverCreated=page.waitForEvent("worker",{predicate:w=>w.url().includes("solver-worker"),timeout:30000});
   await $("#formal-button").click();await began();await solverCreated;
   await $("#project-select").selectOption({label:"blink"});
   await expect($("#project-name")).toHaveText("blink");await settings();
   await expect($("#formal-status")).toHaveText("");await expect($("#surfer-frame")).toHaveCount(0);
   await noWorkers("active project switch");await state("active project switch, all workers closed");await snap("active-project-switch");
   await editor(satFormalCases[0].source);await configure();await run("new project after active switch","境界付きで安全");
 },
 async primary() {
   await newProject("ブラウザー形式検証");
   await editor(satFormalCases[0].source);await configure();
   await run("Verilog SAT safe","境界付きで安全");
   await topview();await snap("sat-safe");
 },
 async counterexample() {
   await editor(satFormalCases[1].source);
   await run("Verilog SAT counterexample","反例が見つかりました","確認済み");
   await $("#bottom-tab-log").click();await snap("sat-replay-verified");
   await $("#bottom-tab-waveform").click();
   await expect($("#surfer-frame")).toHaveCount(1);
   await snap("sat-counterexample-wave");
 },
 async edit() {
   await editor(satFormalCases[0].source);
   await expect($("#formal-status")).toContainText("結果を破棄");
   await expect($("#surfer-frame")).toHaveCount(0);
   await expect($("#wave-download")).toBeHidden();
   await state("edit discards result and waveform");
 },
 async boards() {
   for(const board of ["tangnano1k","tangnano4k","tangnano9k","tangnano20k"]) {
     await $("#board-select").selectOption(board);await saved();
     await run(board+" SAT","境界付きで安全");
     await topview();await snap(board+"-sat");
   }
 },
 async bmc() {
   const f=sbyCases.find(x=>x.name==="bmc-violation");
   await editor(f.source);await configure({engine:"smtbmc",depth:f.depth,clock:"clk",timeout:60});
   await run("Yices2 BMC violation","反例が見つかりました","確認済み");
   await $("#bottom-tab-log").click();await snap("yices-bmc-replay");
 },
 async prove() {
   const f=sbyCases.find(x=>x.name==="prove-invariant");
   await editor(f.source);await configure({engine:"smtbmc",mode:"prove",depth:f.depth,clock:"clk",timeout:60});
   await run("Yices2 prove","証明できました");await snap("yices-prove");
 },
 async cover() {
   await configure({engine:"smtbmc",mode:"cover",depth:6,clock:"clk",timeout:60});
   await run("Yices2 cover","cover の目標に到達しました");await snap("yices-cover");
 },
 async vhdl() {
   await topview();await newProject("VHDL大文字検証","vhdl");
   await editor(smtVhdlReplayCases[1].source);
   await configure({top:"TOP",clock:"CLK",depth:4,timeout:60});
   await run("VHDL TOP CLK SAT","反例が見つかりました","利用不可");
   await expect($("#formal-top")).toHaveValue("TOP");await expect($("#formal-clock")).toHaveValue("CLK");
   await $("#bottom-tab-log").click();await snap("vhdl-sat-unavailable");
 },
 async vhdlsmt() {
   await configure({engine:"smtbmc",top:"ToP",clock:"CLK",depth:4,timeout:60});
   await run("VHDL ToP CLK Yices2","反例が見つかりました","利用不可");
   await expect($("#formal-top")).toHaveValue("ToP");await expect($("#formal-clock")).toHaveValue("CLK");
   await $("#bottom-tab-log").click();await snap("vhdl-yices-unavailable");
 },
 async switchreload() {
   await $("#project-select").selectOption({label:"ブラウザー形式検証"});
   await expect($("#formal-status")).toHaveText("");await expect($("#surfer-frame")).toHaveCount(0);
   await reloadSelect("VHDL大文字検証");
   await expect($("#formal-status")).toHaveText("");
   await expect($("#formal-top")).toHaveValue("ToP");await expect($("#formal-clock")).toHaveValue("CLK");
   await run("VHDL after reload","反例が見つかりました","利用不可");
 },
 async stop() {
   await $("#project-select").selectOption({label:"ブラウザー形式検証"});
   await editor(satFormalCases[0].source);
   await configure({depth:1000,timeout:60});
   await armRun("worker stop");
   const created=page.waitForEvent("worker",{predicate:w=>w.url().includes("formal-wasi-worker"),timeout:15000});
   await $("#formal-button").click();await began();await created;
   await $("#formal-button").click();
   await ended();
   await expect($("#formal-status")).toContainText("停止",{timeout:15000});
   await state("worker stop");await configure();await run("restart after stop","境界付きで安全");
 },
 async timeout() {
   await configure({depth:1000,timeout:1});
   await page.evaluate(()=>{
     const p=document.createElement("pre");p.id="test-timing";p.style.cssText="position:fixed;bottom:8px;left:8px;background:#fff7d6;color:#111;z-index:9999;padding:10px;border:2px solid #8c6a00";
     p.textContent="試験計測: 設定した期限は1秒。DOM状態の時刻を記録します。";document.body.append(p);
   });
   const start=Date.now();await run("actual deadline","時間上限に達しました");
   await page.evaluate(()=>{
     const events=window.__formalTrace.events, first=events.find(e=>e.outcome==="running"), last=events.at(-1);
     document.querySelector("#test-timing").textContent=`試験計測: 期限1秒 / 実行中表示から完了まで ${Math.round(last.at-first.at)} ms\n${last.status}`;
   });
   console.log("DEADLINE_ELAPSED_MS "+(Date.now()-start));
   await snap("actual-timeout");await page.locator("#test-timing").evaluate(e=>e.remove());
   await configure();await run("restart after timeout","境界付きで安全");
 },
 async activeedit() {
   await configure({depth:1000,timeout:60});await armRun("active source edit");
   await $("#formal-button").click();await began();
   await editor(satFormalCases[0].source+"\n// 実行中の編集\n");
   await expect($("#formal-status")).toContainText("結果を破棄");
   await expect($("#surfer-frame")).toHaveCount(0);await state("active source edit");
   await configure();await run("restart after edit","境界付きで安全");
 },
 async cache() {
   const changed=await page.evaluate(async()=>{
     const cache=await caches.open("gogo-fpga-synth-v1");
     const keys=await cache.keys();const target=keys.find(r=>r.url.includes("/yosys.wasm?"));
     if(!target) throw Error("Yosys cache absent");
     const bytes=new Uint8Array(await (await cache.match(target)).arrayBuffer());bytes[0]^=255;
     await cache.put(target,new Response(bytes));return {url:target.url,size:bytes.length};
   });
   evidence.cacheCorruption=changed;save();
   await reloadSelect("ブラウザー形式検証");
   const n=evidence.events.length;await run("cache corruption recovery","境界付きで安全");
   if(!evidence.events.slice(n).some(e=>e.text?.includes("Discarding invalid cached"))) throw Error("No cache rejection warning");
   const deleted=await page.evaluate(()=>caches.delete("gogo-fpga-synth-v1"));
   evidence.cacheDeleted=deleted;save();await reloadSelect("ブラウザー形式検証");
   await run("cache invalidation recovery","境界付きで安全");await snap("cache-recovered");
 },
 async finish() {await context.tracing.stop({path:out+"main-browser-trace.zip"});save();console.log("FINISHED");},
};
for await(const line of readline.createInterface({input:process.stdin})) {
 const cmd=line.trim();if(cmd==="exit"){await browser.close();break;}
 try {if(!commands[cmd]) throw Error("Unknown command "+cmd);await commands[cmd]();console.log("DONE "+cmd);}
 catch(e) {process.exitCode=1;console.error("FAIL "+cmd+" "+e.stack);await snap("failure-"+cmd);await state("FAIL "+cmd);writeFileSync(out+"failure-"+cmd+".txt",e.stack);console.log("STOPPED");}
}
