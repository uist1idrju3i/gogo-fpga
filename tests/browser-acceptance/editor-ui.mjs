import { chromium, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import readline from "node:readline";
import { interactiveEvidence } from "./evidence.mjs";
const {out, baseURL, revision} = interactiveEvidence();
const browser = await chromium.launch({headless:false,args:["--start-maximized","--lang=ja-JP"]});
const context = await browser.newContext({viewport:null,locale:"ja-JP"});
await context.tracing.start({screenshots:true,snapshots:true,sources:true});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const $ = s=>page.locator(s);
const safe = "module top(input wire a); always @* begin assume(a); assert(a); end endmodule";
const prefix = "module top(input wire a); ";
const violation = prefix+"always @* assert(a); endmodule";
const evidence={revision,browser:browser.version(),baseURL,results:[],events:[]};
const save=()=>writeFileSync(out+"browser-runtime.json",JSON.stringify(evidence,null,2));
for(const type of ["console","pageerror","requestfailed"]) page.on(type,e=>{
  evidence.events.push({at:new Date().toISOString(),type,text:type==="console"?`${e.type()}: ${e.text()}`:String(e)});save();
});
const saved=()=>expect($("#project-status")).toHaveText("保存しました。");
async function snapshot(name) {
  const result={name,at:new Date().toISOString(),project:await $("#project-name").textContent(),
    board:await $("#board-select").inputValue(),source:await $(".cm-content").textContent(),
    status:await $("#formal-status").textContent(),outcome:await $("#formal-status").getAttribute("data-outcome"),
    saved:await $("#project-status").textContent(),log:await $("#program-log").textContent()};
  evidence.results.push(result);save();console.log(JSON.stringify(result));return result;
}
async function run(name,expected) {
  await saved();
  await expect($("#formal-button")).toHaveText("形式検証");
  await page.evaluate(name=>{
    window.__runObserver?.disconnect();
    const events=[];
    window.__runTrace={name,events};
    const record=()=>events.push({at:performance.now(),outcome:document.querySelector("#formal-status").dataset.outcome,
      status:document.querySelector("#formal-status").textContent,button:document.querySelector("#formal-button").textContent});
    window.__runObserver=new MutationObserver(record);
    for(const selector of ["#formal-status","#formal-button"])
      window.__runObserver.observe(document.querySelector(selector),{subtree:true,childList:true,attributes:true,characterData:true});
    record();
  },name);
  await $("#formal-button").click();
  await page.waitForFunction(()=>{
    const events=window.__runTrace.events;
    const start=events.findIndex(e=>e.outcome==="running"&&e.button==="停止");
    return start>=0&&events.slice(start+1).some(e=>e.outcome!=="running"&&e.button==="形式検証");
  },null,{timeout:120000});
  await expect($("#formal-status")).toContainText(expected);
  await expect($("#formal-button")).toBeEnabled();
  evidence.events.push({type:"run-state-transitions",...await page.evaluate(()=>window.__runTrace)});save();
  await snapshot(name);
}
await page.goto(baseURL);
await expect($("#project-name")).toHaveText("blink");
await saved();
await page.getByRole("button",{name:"案内を閉じる",exact:true}).click();
console.log("READY "+browser.version());
const commands={
  async board(board) {
    if(!["tangnano1k","tangnano4k","tangnano9k","tangnano20k"].includes(board))throw Error("Unknown board");
    await expect($("#project-name")).toHaveText("blink");
    await $("#board-select").selectOption(board);
    await $(".cm-content").click();await page.keyboard.press("Control+A");await page.keyboard.type(safe);
    await expect($(".cm-content")).toHaveText(safe);
    await $("#right-tab-verify").click();
    await $("#formal-engine").selectOption("yosys-sat");
    await $("#formal-depth").fill("3");
    await $("#formal-depth").press("Tab");
    await run(board+" safe","境界付きで安全を確認");
    await page.screenshot({path:out+board+"-safe.png"});
    console.log("SAFE "+board);
  },
  async edit(board) {
    await expect($("#board-select")).toHaveValue(board);
    await expect($("#formal-status")).toContainText("境界付きで安全を確認");
    await $(".cm-content").click();await page.keyboard.press("Control+A");await page.keyboard.type(prefix);
    await expect($(".cm-content")).toHaveText(prefix);
    await expect($("#formal-status")).toContainText("ソースを編集したため、形式検証の結果を破棄しました。");
    await expect($("#formal-status")).toHaveAttribute("data-outcome","stopped");
    await snapshot(board+" prefix-kept-result-discarded");
    await page.screenshot({path:out+board+"-discarded.png"});
    await page.keyboard.type("always @* assert(a); endmodule");
    await expect($(".cm-content")).toHaveText(violation);
    await expect($("#formal-status")).toHaveAttribute("data-outcome","stopped");
    await saved();
    await snapshot(board+" continuous-edit-kept");
    await run(board+" counterexample","反例が見つかりました");
    await expect($(".cm-content")).toHaveText(violation);
    await saved();
    await page.screenshot({path:out+board+"-counterexample.png"});
    await page.reload();await expect($("#project-name")).toHaveText("blink");await saved();
    await expect($(".cm-content")).toHaveText(violation);
    await expect($("#board-select")).toHaveValue(board);
    await snapshot(board+" reload-kept");
    await $("#right-tab-verify").click();
    console.log("DONE "+board);
  },
  async finish() {
    save();await context.tracing.stop({path:out+"boards-trace.zip"});
    console.log("FINISHED");
  },
  async exit() {await browser.close();process.exit(0);},
};
const rl=readline.createInterface({input:process.stdin,terminal:false});
for await(const line of rl) {
  const [command,arg]=line.trim().split(/\s+/);
  try{if(!commands[command])throw Error("Unknown command");await commands[command](arg);}
  catch(error) {
    evidence.failure=String(error.stack);save();
    await page.screenshot({path:out+"failure.png"}).catch(()=>{});
    await context.tracing.stop({path:out+"failure-trace.zip"}).catch(()=>{});
    console.error(error);process.exitCode=1;break;
  }
}
