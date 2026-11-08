import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

/** Glanceable coaching state. Direction is route knowledge; we deliberately do NOT
 *  claim on-screen ledge/target coordinates (vision can't pinpoint those reliably). */
export interface HudState {
  status: "on_track" | "searching" | "off_track" | "arrived";
  direction: "left" | "right" | "up" | "down" | "explore" | "talk" | "done";
  hazard?: string;
  step: number;
  total: number;
  leg: string;
  ts: number;
}

let state: HudState = { status: "searching", direction: "right", step: 1, total: 1, leg: "", ts: 0 };
let framePath = "";

export function setHud(s: Partial<HudState>) {
  state = { ...state, ...s, ts: state.ts + 1 };
}
export function setFramePath(p: string) {
  framePath = p;
}

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf8"><title>Coach</title>
<style>
  *{margin:0;box-sizing:border-box}
  html,body{height:100%;background:#000;overflow:hidden;font-family:-apple-system,system-ui,sans-serif}
  #wrap{position:fixed;inset:0}
  #frame{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;filter:brightness(.85)}
  #arrow{position:absolute;font-size:24vmin;line-height:1;font-weight:700;color:var(--c,#22c55e);
    filter:drop-shadow(0 0 2vmin var(--c,#22c55e)) drop-shadow(0 0 .4vmin #000);
    transition:color .3s,left .4s,top .4s,right .4s,bottom .4s;animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1) translate(var(--tx,0),var(--ty,0))}50%{transform:scale(1.08) translate(var(--tx,0),var(--ty,0))}}
  #status{position:fixed;top:2.5vh;left:0;right:0;text-align:center;color:var(--c,#22c55e);font-size:3.4vmin;
    font-weight:800;letter-spacing:.12em;text-shadow:0 0 1.2vmin #000,0 0 .4vmin #000}
  #instr{position:fixed;top:6.5vh;left:0;right:0;text-align:center;color:#fff;font-size:5.2vmin;font-weight:800;
    text-shadow:0 0 1.4vmin #000,0 0 .5vmin #000}
  #leg{position:fixed;top:13vh;left:0;right:0;text-align:center;color:#cbd5e1;font-size:2.8vmin;font-weight:600;
    text-shadow:0 0 1vmin #000,0 0 .4vmin #000}
  #hazard{position:fixed;top:17vh;left:0;right:0;text-align:center;color:#fb923c;font-size:3.2vmin;font-weight:700;
    text-shadow:0 0 1vmin #000;opacity:0;transition:opacity .3s}
  #hazard.on{opacity:1;animation:hz 1.2s ease-in-out infinite}@keyframes hz{0%,100%{opacity:.65}50%{opacity:1}}
  #edge{position:fixed;inset:0;border:0 solid #ef4444;pointer-events:none;transition:border-width .2s}
  #dots{position:fixed;left:0;right:0;bottom:3vmin;display:flex;gap:1.8vmin;justify-content:center}
  .dot{width:2.4vmin;height:2.4vmin;border-radius:50%;background:#334155aa;transition:background .3s}
  .dot.done{background:#22c55e}.dot.cur{background:#f59e0b;box-shadow:0 0 2vmin #f59e0b}
  #wait{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:4vmin}
</style></head><body>
<div id="wrap"><img id="frame" alt=""></div>
<div id="arrow">→</div>
<div id="status"></div><div id="instr"></div><div id="leg"></div><div id="hazard"></div>
<div id="edge"></div><div id="dots"></div>
<div id="wait">waiting for capture…</div>
<script>
const GLYPH={left:"←",right:"→",up:"↑",down:"↓",explore:"⟳",talk:"💬",done:"✓"};
const INSTR={left:"Go left",right:"Go right",up:"Climb up",down:"Go down",explore:"Look around",talk:"Talk to them",done:"You made it!"};
const STATUS={on_track:"ON TRACK",searching:"FINDING YOU…",off_track:"WRONG WAY",arrived:"DONE!"};
const COLOR={on_track:"#22c55e",searching:"#f59e0b",off_track:"#ef4444",arrived:"#fbbf24"};
// anchor the arrow to the edge it points toward — a global "go this way", not pinned to any object
const POS={
  right:{right:"7vw",top:"44%",left:"",bottom:""},left:{left:"7vw",top:"44%",right:"",bottom:""},
  up:{top:"16vh",left:"42%",right:"",bottom:""},down:{bottom:"14vh",left:"42%",right:"",top:""},
  explore:{left:"42%",top:"40%",right:"",bottom:""},talk:{left:"42%",top:"40%",right:"",bottom:""},done:{left:"42%",top:"40%",right:"",bottom:""}
};
const img=document.getElementById("frame"),arrow=document.getElementById("arrow");
let lastTs=-1;
function render(s){
  const c=COLOR[s.status]||"#f59e0b";
  document.documentElement.style.setProperty("--c",c);
  arrow.style.color=c;arrow.textContent=GLYPH[s.direction]||"→";
  const p=POS[s.direction]||POS.right;
  for(const k of["left","right","top","bottom"])arrow.style[k]=p[k]||"";
  document.getElementById("status").textContent=STATUS[s.status]||"";
  document.getElementById("instr").textContent=INSTR[s.direction]||"";
  document.getElementById("leg").textContent=s.leg||"";
  const hz=document.getElementById("hazard");hz.textContent=s.hazard?("⚠ "+s.hazard):"";hz.classList.toggle("on",!!s.hazard);
  document.getElementById("edge").style.borderWidth=s.status==="off_track"?"2.5vmin":"0";
  const dots=document.getElementById("dots");dots.innerHTML="";
  for(let i=0;i<s.total;i++){const d=document.createElement("div");d.className="dot"+(i<s.step-1?" done":i===s.step-1?" cur":"");dots.appendChild(d);}
}
async function tick(){
  try{
    const s=await(await fetch("/state")).json();
    if(s.ts===lastTs)return;lastTs=s.ts;
    if(s.ts>0){document.getElementById("wait").style.display="none";img.src="/frame.jpg?v="+s.ts;}
    render(s);
  }catch(e){}
}
setInterval(tick,300);tick();
</script></body></html>`;

export function startHud(port = 4319): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const url = (req.url ?? "/").split("?")[0];
      if (url === "/state") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(state));
      } else if (url === "/frame.jpg") {
        try {
          const buf = await readFile(framePath);
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
          res.end(buf);
        } catch {
          res.writeHead(404).end();
        }
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
      }
    });
    srv.listen(port, () => resolve(srv));
  });
}
