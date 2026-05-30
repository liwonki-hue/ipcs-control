// dashboard.js Full frontend logic  v18.8

const API = "";  // Flask runs on same origin
let charts = {};
let jmData = [];
let jmCurrentPage = 0;
const JM_PAGE_SIZE = 50;

let smData = [];
let smCurrentPage = 0;
const SM_PAGE_SIZE = 50;

let _welderData = null;
let metaData = { units: [], systems: [] };

// ================================================================================
//  INIT
// ================================================================================
let _dashData = null;

async function getDashData(forceRefresh=false) {
    if (_dashData && !forceRefresh) return _dashData;
    const MAX_ATTEMPTS = 300;
    const RETRY_MS     = 3000;
    const TIMEOUT_MS   = 10000;

    async function fetchWithTimeout(url, ms) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            return res;
        } catch(e) {
            clearTimeout(timer);
            if (e.name === "AbortError") throw new Error("fetch_timeout");
            throw e;
        }
    }

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        try {
            const res = await fetchWithTimeout("/api/dashboard", TIMEOUT_MS);
            if (res.status === 202) {
                _updateLoader(`Building data... ${(i+1)*2}s (${i+1}/${MAX_ATTEMPTS})`);
                await new Promise(r => setTimeout(r, RETRY_MS));
                continue;
            }
            _dashData = await res.json();
            return _dashData;
        } catch(e) {
            if (e.message === "fetch_timeout") {
                _updateLoader(`Server starting... (${i+1}/${MAX_ATTEMPTS})`);
                await new Promise(r => setTimeout(r, RETRY_MS));
                continue;
            }
            throw e;
        }
    }
    throw new Error("Server response timeout. Please refresh (F5) to retry.");
}

function _updateLoader(msg) {
    const el = document.getElementById("bop-loader");
    if (!el) return;
    const lines = el.querySelectorAll("div");
    if (lines[2]) lines[2].textContent = msg;
}

document.addEventListener("DOMContentLoaded", async () => {
    showLoader(true);
    try {
        await loadMeta();
        const data = await getDashData();
        renderKPI(data.kpi, data.weekly);
        renderOverview(data.kpi, data.weekly, data.units);
    } catch(e) {
        console.error("[BOP] Init error:", e);
        showLoader(false, "Load failed: " + e.message);
    } finally {
        showLoader(false);
    }
    // Background: fetch welder summary after initial render (non-blocking, delayed)
    setTimeout(() => {
        fetch("/api/welder-summary").then(r => r.json()).then(wd => {
            _welderData = wd;
            _updateWelderKpiBar(wd);
        }).catch(() => {});
    }, 2000);
});

function _updateWelderKpiBar(wd) {
    const ranking = wd?.ranking || [];
    if (!ranking.length) return;
    const avg = ranking.reduce((s, r) => s + (r.avg_di_per_day || 0), 0) / ranking.length;
    const avgTxt = fmtNum(avg, 2);
    const subTxt = "AVG DI / Day";
    ["kpi-welder-perf", "ep-kpi-welder"].forEach(id => { const el=document.getElementById(id); if(el) el.textContent = avgTxt; });
    ["kpi-welder-sub", "ep-kpi-welder-sub"].forEach(id => { const el=document.getElementById(id); if(el) el.textContent = subTxt; });
}

function showLoader(show, msg) {
    let el = document.getElementById("bop-loader");
    if (!el) {
        el = document.createElement("div");
        el.id = "bop-loader";
        el.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(11,15,26,0.88);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;font-family:Barlow,sans-serif";
        el.innerHTML = `
          <div style="width:48px;height:48px;border:3px solid #1e2d45;border-top:3px solid #00d4ff;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:16px"></div>
          <div style="color:#00d4ff;font-size:14px;font-weight:600;letter-spacing:0.06em">LOADING DATA</div>
          <div style="color:#7a95b8;font-size:11px;margin-top:6px;font-family:DM Mono,monospace">47,304 joints 쨌 please wait...</div>
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        `;
        document.body.appendChild(el);
    }
    el.style.display = show ? "flex" : "none";
    el.style.pointerEvents = show ? "auto" : "none";
}

// ================================================================================
//  NAVIGATION
// ================================================================================
function navigate(pageId) {
    const pages = document.querySelectorAll(".page");
    const navBtns = document.querySelectorAll(".nav-btn");
    
    pages.forEach(p => p.classList.add("hidden"));
    navBtns.forEach(b => b.classList.remove("active"));
    
    const btn = document.querySelector(`.nav-btn[data-page="${pageId}"]`);
    if (btn) btn.classList.add("active");
    document.getElementById(`page-${pageId}`)?.classList.remove("hidden");

    const kpiRow = document.getElementById("kpiRow");
    if (kpiRow) {
        if (pageId === "welder") {
            kpiRow.style.display = "none";
        } else {
            kpiRow.style.display = "grid";
        }
    }

    switch(pageId) {
        case "overview":    requestAnimationFrame(() => loadOverview()); break;
        case "systems":     requestAnimationFrame(() => loadSystems()); loadSubArea(); break;
        case "weekly":      requestAnimationFrame(() => loadWeekly());   break;
        case "unitarea":    requestAnimationFrame(() => loadUnitArea()); break;
        case "joint_master":loadJointMaster();  break;
        case "support_master": loadSupportMaster(); break;
        case "welder":      loadWelder();       break;
    }
}

// ================================================================================
//  API HELPERS
// ================================================================================
async function apiFetch(url) {
    const res = await fetch(API + url);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

function pctColor(v) {
    if (v >= 80) return "#22d3a1";
    if (v >= 50) return "#00d4ff";
    if (v > 0)   return "#7a95b8"; // Changed from yellow
    return "#94a3b8";
}

function fmtNum(n, d=1) {
    if (n === null || n === undefined || isNaN(n)) return "??;
    return parseFloat(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function toast(msg, type="success") {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.className = `toast ${type} show`;
    setTimeout(() => el.classList.remove("show"), 3000);
}

// ================================================================================
//  META
// ================================================================================
async function loadMeta() {
    try {
        metaData = await apiFetch("/api/meta?t=" + Date.now());
        const unitSel    = document.getElementById("jm-unit");
        const systemSel  = document.getElementById("jm-system");
        const subareaSel = document.getElementById("jm-subarea");
        if (unitSel) { unitSel.innerHTML = '<option value="">Unit</option>'; metaData.units.forEach(u => unitSel.add(new Option(u, u))); }
        if (systemSel) { systemSel.innerHTML = '<option value="">System</option>'; metaData.systems.forEach(s => systemSel.add(new Option(s, s))); }
        if (subareaSel && metaData.sub_areas) {
            subareaSel.innerHTML = '<option value="">Sub Area</option>';
            metaData.sub_areas.forEach(s => subareaSel.add(new Option(s, s)));
        }

        // Populate Support Master filters
        const smUnit = document.getElementById("sm-unit");
        const smSys  = document.getElementById("sm-system");
        const smSub  = document.getElementById("sm-subarea");
        if (smUnit) { smUnit.innerHTML = '<option value="">Unit</option>'; metaData.units.forEach(u => smUnit.add(new Option(u, u))); }
        if (smSys)  { smSys.innerHTML = '<option value="">System</option>'; metaData.systems.forEach(s => smSys.add(new Option(s, s))); }
        if (smSub && metaData.sub_areas) {
            smSub.innerHTML = '<option value="">Sub Area</option>';
            metaData.sub_areas.forEach(s => smSub.add(new Option(s, s)));
        }
    } catch(e) { console.error("Meta load failed", e); }
}

// ================================================================================
//  KPI RENDER
// ================================================================================
function renderKPI(d, wkData) {
    document.getElementById("reportDate").textContent = d.report_date;
    document.getElementById("kpi-overall").textContent     = `${d.overall_pct}%`;
    document.getElementById("kpi-overall-sub").textContent = `${fmtNum(d.completed_di,0)} / ${fmtNum(d.total_plan_di,0)} DI 쨌 ${d.completed_joints.toLocaleString()} joints`;
    document.getElementById("kpi-bar").style.width = `${Math.min(d.overall_pct,100)}%`;

    const totalEl    = document.getElementById("kpi-total-di");
    const totalSubEl = document.getElementById("kpi-total-di-sub");
    if (totalEl)    totalEl.textContent    = fmtNum(d.total_plan_di, 0);
    if (totalSubEl) totalSubEl.textContent = `${d.overall_pct}% 쨌 ${d.total_joints?.toLocaleString() || "??} joints`;

    const compValEl = document.getElementById("kpi-completed-di-val");
    const compSubEl = document.getElementById("kpi-completed-di-sub");
    if (compValEl) compValEl.textContent = fmtNum(d.completed_di, 0);
    if (compSubEl) compSubEl.textContent = `${d.overall_pct}% completed`;
    document.getElementById("kpi-remain").textContent     = fmtNum(d.remaining_di,0);
    document.getElementById("kpi-remain-sub").textContent = `${(100-d.overall_pct).toFixed(1)}% remaining`;

    const actWks = (wkData||[]).filter(w => w.completed_di > 0);
    const kpiWeekVal = document.getElementById("kpi-week");
    const kpiWeekSub = document.getElementById("kpi-week-sub");
    if (actWks.length) {
        const lw  = actWks[actWks.length-1];
        const weeksTbl = (_dashData?.weeks || []).find(w => w.week_no === lw.week_no);
        const realPlan = weeksTbl ? (weeksTbl.plan_fab_di||0) + (weeksTbl.plan_erect_di||0) : 0;
        const color = realPlan > 0 ? (lw.completed_di >= realPlan ? "#22d3a1" : "#ff5252") : "#7a95b8";
        document.getElementById("kpi-week-card").style.borderTopColor = color;
        kpiWeekVal.textContent = fmtNum(lw.completed_di, 0);
        kpiWeekVal.style.color = color;
        if (realPlan > 0) {
            const dev = lw.completed_di - realPlan;
            kpiWeekSub.textContent = (dev >= 0 ? "?? : "??) + fmtNum(Math.abs(dev), 0) + " DI vs Plan " + fmtNum(realPlan, 0);
        } else {
            kpiWeekSub.textContent = fmtNum(lw.completed_di, 0) + " DI 쨌 No plan set";
        }
    } else {
        document.getElementById("kpi-week-card").style.borderTopColor = "#1e2d45";
        kpiWeekVal.textContent = "0";
        kpiWeekVal.style.color = "#4a6080";
        kpiWeekSub.textContent = "No activity this week";
    }
}

// ================================================================================
//  OVERVIEW
// ================================================================================
async function loadOverview() {
    const data = await getDashData();
    renderOverview(data.kpi, data.weekly, data.units);
}

async function renderOverview(kpi, wkData, units) {
    try {
        const d = kpi, pct = d.overall_pct;
        const r = 84, circ = Math.PI * r;
        const offset = circ * (1 - Math.min(pct/100,1));
        const gc = pct>=80?"#22d3a1":"#2563eb";
        const gp = document.getElementById("gaugePath");
        if (gp) { gp.style.stroke = gc; gp.style.strokeDashoffset = offset; }
        const gt = document.getElementById("gaugeText");
        if (gt) { gt.textContent = `${pct}%`; gt.style.fill = gc; }

        const stats = document.getElementById("overviewStats");
        stats.innerHTML = [["Total Plan DI",fmtNum(d.total_plan_di,0)],["Completed DI",fmtNum(d.completed_di,0)],["Remaining DI",fmtNum(d.remaining_di,0)],["Completed Joints",`${d.completed_joints.toLocaleString()} / ${d.total_joints.toLocaleString()}`]]
            .map(([l,v]) => `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`).join("");

        const disc = document.getElementById("disciplineList");
        disc.innerHTML = [["Fabrication (S)",d.fab_pct,"var(--accent)"],["Erection (F)",d.erect_pct,"var(--green)"]]
            .map(([n,p,c]) => `<div class="disc-row"><div class="disc-head"><span class="disc-name">${n}</span><span class="disc-pct" style="color:${c}">${p}%</span></div><div class="disc-track"><div class="disc-fill" style="width:${Math.min(p,100)}%;background:linear-gradient(90deg,${c}60,${c})"></div></div></div>`).join("");

        const wkView = wkData.slice(0, 60);
        const indMap = {};
        const actWks = wkData.filter(w => w.completed_di > 0);
        actWks.forEach(w => { indMap[w.week_no] = w.completed_di; });

        destroyChart("scurveChart");
        charts["scurveChart"] = new Chart(document.getElementById("scurveChart").getContext("2d"), {
            type: "bar",
            data: { labels: wkView.map(w=>w.week_label), datasets: [
                { label:"Ideal Plan", type:"line", data:wkView.map(w=>w.cumul_ideal), borderColor:"rgba(74,96,128,0.4)", borderDash:[5,5], borderWidth:1.5, fill:false, pointRadius:0, tension:0.1, order:1, yAxisID: "y" },
                { label:"Actual Work DI", type:"bar", data:wkView.map(w=>indMap[w.week_no]||null), backgroundColor:"rgba(37,99,235,0.6)", borderColor:"#2563eb", borderWidth:1, borderRadius:2, barPercentage:0.7, order:2, yAxisID: "y1", datalabels:{display:true,align:'top',anchor:'end',offset:6,color:'#2563eb',font:{size:11,weight:'bold',family:'Inter,sans-serif'},clip:false,formatter:(v)=>v>0?fmtNum(v,0):''} }
            ]},
            options: { ...chartOpts("Cumulative DI (Lines) / Weekly DI (Bars)"),
                scales: { 
                    ...chartOpts("").scales, 
                    x:{...chartOpts("").scales.x, ticks:{...chartOpts("").scales.x.ticks,maxRotation:0,autoSkip:false,callback:function(val,index){const label=this.getLabelForValue(val);const wkNum=parseInt(label.replace("W",""));if(wkNum===1||wkNum%5===0)return label;return "";}}}, 
                    y:{...chartOpts("").scales.y, beginAtZero:true, title:{display:true, text:"Cumulative DI", color:"#7a95b8", font:{size:9}}},
                    y1:{position:'right', beginAtZero:true, grid:{display:false}, title:{display:true, text:"Weekly Actual DI", color:"#2563eb", font:{size:9}}, ticks:{color:"#2563eb", font:{size:9}}}
                },
                plugins:{...chartOpts("").plugins,legend:{display:true,position:'top',labels:{color:'#7a95b8',boxWidth:12,font:{size:10}}}}, animation:{duration:600} }
        });

        let latestPlanIdx = -1;
        for (let i=wkData.length-1; i>=0; i--) { if (wkData[i].completed_di>0) { latestPlanIdx=i; break; } }
        const last6Wks = actWks.slice(-6);
        destroyChart("weeklyBar");
        charts["weeklyBar"] = new Chart(document.getElementById("weeklyBar").getContext("2d"), {
            type:"bar",
            data:{labels:last6Wks.map(w=>w.week_label),datasets:[
                {label:"Actual Work",type:"bar",data:last6Wks.map(w=>w.completed_di||null),backgroundColor:"rgba(37,99,235,0.7)",borderColor:"#2563eb",borderWidth:1,barPercentage:0.5,categoryPercentage:0.5,order:1,datalabels:{display:true,anchor:'end',align:'top',color:'#2563eb',font:{weight:'bold',size:13,family:'Inter,sans-serif'},offset:8,clip:false,formatter:(v)=>v>0?fmtNum(v,1):''}},
                {label:"Trend",type:"line",data:last6Wks.map(w=>w.completed_di||null),borderColor:"#2563eb",borderWidth:2,fill:false,tension:0.3,pointRadius:4,pointBackgroundColor:"#2563eb",order:0,datalabels:{display:false}},
                {label:"Ideal Plan",type:"line",data:last6Wks.map(w=>(w.ideal_di>0)?w.ideal_di:null),borderColor:"rgba(148,163,184,0.6)",borderWidth:2,fill:false,tension:0.3,pointRadius:0,order:2}
            ]},
            options:{...chartOpts("DI"),scales:{...chartOpts("DI").scales,x:{...chartOpts("DI").scales.x,ticks:{...chartOpts("DI").scales.x.ticks,font:{size:11}}},y:{...chartOpts("DI").scales.y,beginAtZero:true,grace:'15%',ticks:{...chartOpts("DI").scales.y.ticks,font:{size:11}}}},plugins:{...chartOpts("DI").plugins,legend:{display:true,position:"top",labels:{boxWidth:12,font:{size:11},color:"#475569"}}}}
        });

        document.getElementById("unitOverview").innerHTML = [...units].sort((a,b)=>a.unit.localeCompare(b.unit)).map(u => {
            const p=u.progress_pct, c=pctColor(p);
            return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #162032"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px"><div><div style="font-size:13px;font-weight:600">Unit ${u.unit}</div><div style="font-size:10px;color:#7a95b8">Plan: ${fmtNum(u.total_di,0)} DI</div></div><div style="font-size:20px;font-weight:700;color:${c};font-family:'DM Mono',monospace">${p}%</div></div><div style="height:4px;background:#1e2d45;border-radius:2px"><div style="height:100%;width:${Math.min(p,100)}%;background:${c};border-radius:2px"></div></div><div style="font-size:10px;color:#7a95b8;margin-top:3px;font-family:'DM Mono',monospace">${fmtNum(u.completed_di,0)} / ${fmtNum(u.total_di,0)} DI</div></div>`;
        }).join("");
    } catch(e) { console.error("Overview failed", e); }
}

// ================================================================================
//  SYSTEMS
// ================================================================================
async function loadSystems() {
    try {
        const dash=await getDashData(), data=(dash.systems||[]).sort((a,b)=>b.progress_pct-a.progress_pct);
        const c="#2563eb";
        document.getElementById("systemBars").innerHTML = data.map(s=>{ 
            const p=s.progress_pct; 
            return `<div class="prog-row"><div class="prog-head"><span class="prog-name">${s.system}</span><div class="prog-stats"><span>${fmtNum(s.completed_di,0)} / ${fmtNum(s.total_di,0)} DI</span><span class="prog-pct" style="color:${c}">${p}%</span></div></div><div class="prog-track"><div class="prog-fill" style="width:${Math.min(p,100)}%;background:linear-gradient(90deg,${c}60,${c})"></div></div></div>`; 
        }).join("");
        const sorted=[...data].sort((a,b)=>a.progress_pct-b.progress_pct);
        destroyChart("systemChart");
        const ctxSys=document.getElementById("systemChart");
        if(ctxSys) charts["systemChart"]=new Chart(ctxSys.getContext("2d"),{type:"bar",data:{labels:sorted.map(s=>s.system),datasets:[{label:"Plan",data:sorted.map(s=>s.total_di),backgroundColor:"rgba(37,99,235,0.1)"},{label:"Actual",data:sorted.map(s=>s.completed_di),backgroundColor:sorted.map(s=>c),datalabels:{display:true,anchor:'end',align:'right',offset:4,color:'#2563eb',font:{weight:'bold',size:11},formatter:v=>fmtNum(v,0)}}]},options:{...chartOpts("DI"),indexAxis:"y",plugins:{...chartOpts("DI").plugins}}});
    } catch(e) { console.error("Systems failed",e); }
}

// ================================================================================
//  SUB AREA
// ================================================================================
async function loadSubArea() {
    try {
        const dash=await getDashData(), data=(dash.subareas||[]).sort((a,b)=>b.progress_pct-a.progress_pct);
        if(!data.length){document.getElementById("subareaBars").innerHTML='<div style="color:#7a95b8;padding:20px;text-align:center;font-size:12px">No sub_area data found in joint_master</div>';return;}
        const c="#2563eb";
        document.getElementById("subareaBars").innerHTML=data.map(s=>{const p=s.progress_pct;return `<div class="prog-row"><div class="prog-head"><span class="prog-name">${s.sub_area}</span><div class="prog-stats"><span>${fmtNum(s.completed_di,0)} / ${fmtNum(s.total_di,0)} DI</span><span class="prog-pct" style="color:${c}">${p}%</span></div></div><div class="prog-track"><div class="prog-fill" style="width:${Math.min(p,100)}%;background:linear-gradient(90deg,${c}60,${c})"></div></div></div>`;}).join("");
        const sorted=[...data].sort((a,b)=>a.progress_pct-b.progress_pct);
        destroyChart("subareaChart");
        const ctxSub=document.getElementById("subareaChart");
        if(ctxSub) charts["subareaChart"]=new Chart(ctxSub.getContext("2d"),{type:"bar",data:{labels:sorted.map(s=>s.sub_area),datasets:[{label:"Plan DI",data:sorted.map(s=>s.total_di),backgroundColor:"rgba(37,99,235,0.1)"},{label:"Actual DI",data:sorted.map(s=>s.completed_di),backgroundColor:sorted.map(s=>c),datalabels:{display:true,anchor:'end',align:'right',offset:4,color:'#2563eb',font:{weight:'bold',size:11},formatter:v=>fmtNum(v,0)}}]},options:{...chartOpts("DI"),indexAxis:"y"}});
    } catch(e) { console.error("SubArea failed",e); }
}

// ================================================================================
//  WEEKLY
// ================================================================================
async function loadWeekly() {
    try {
        const dash=await getDashData(), data=dash.weekly;
        const actWks=data.filter(w=>w.completed_di>0);
        const displayWks=actWks.slice(-6);
        destroyChart("weeklyTrend");
        charts["weeklyTrend"]=new Chart(document.getElementById("weeklyTrend").getContext("2d"),{
            type:"bar",
            data:{labels:displayWks.map(w=>w.week_label),datasets:[
                {label:"Actual DI",type:"bar",data:displayWks.map(w=>w.completed_di),backgroundColor:"rgba(37,99,235,0.7)",borderColor:"#2563eb",borderWidth:1,barPercentage:0.5,categoryPercentage:0.5,order:1,datalabels:{display:true,anchor:'end',align:'top',offset:5,color:"#2563eb",font:{size:10,weight:"700",family:"DM Mono, monospace"},formatter:v=>v>0?fmtNum(v,0):""}},
                {label:"Trend",type:"line",data:displayWks.map(w=>w.completed_di),borderColor:"#2563eb",borderWidth:2,fill:false,tension:0.3,pointRadius:4,pointBackgroundColor:"#2563eb",order:0,datalabels:{display:false}}
            ]},
            options:{...chartOpts("DI"),plugins:{...chartOpts("DI").plugins,legend:{display:false}}}
        });

        const tbody=document.querySelector("#weeklyTable tbody");
        let totalFab=0, totalErect=0, totalComp=0;
        actWks.forEach(w=>{ totalFab+=w.fab_di||0; totalErect+=w.erect_di||0; totalComp+=w.completed_di||0; });
        let html=displayWks.map(w=>{
            const comp=w.completed_di||0, fab=w.fab_di||0, erect=w.erect_di||0;
            const ds = w.start_date && w.end_date ? `${w.start_date.slice(5)} ~ ${w.end_date.slice(5)}` : (w.start_date ? w.start_date.slice(5) : "");
            return `<tr><td style="color:var(--accent)">${w.week_label}</td><td style="font-size:11px;color:var(--text-dim)">${ds}</td><td>${fmtNum(fab,0)}</td><td>${fmtNum(erect,0)}</td><td>${fmtNum(comp,0)}</td></tr>`;
        }).join("");
        html+=`<tr style="background:rgba(37,99,235,0.05);border-top:1px solid var(--border)"><td style="color:var(--accent)">Total</td><td></td><td>${fmtNum(totalFab,0)}</td><td>${fmtNum(totalErect,0)}</td><td>${fmtNum(totalComp,0)}</td></tr>`;
        tbody.innerHTML=html;

        // Breakdown panels
        try {
            const bd = await fetch("/api/weekly-last-breakdown").then(r=>r.json());
            const weekLabel = bd.week_label || "";
            const dr = bd.week_start && bd.week_end ? `${bd.week_start.slice(5)} ~ ${bd.week_end.slice(5)}` : "";
            document.getElementById("weeklySystemTitle").textContent  = `${weekLabel} Breakdown ??By System`;
            document.getElementById("weeklyMaterialTitle").textContent = `${weekLabel} Breakdown ??By Material`;
            document.getElementById("weeklySubareaTitle").textContent = `${weekLabel} Breakdown ??By Sub Area`;
            const mkTotalRow = arr => {
                const sf=arr.reduce((s,r)=>s+(r.fab_di||0),0);
                const se=arr.reduce((s,r)=>s+(r.erect_di||0),0);
                const sc=arr.reduce((s,r)=>s+(r.completed_di||0),0);
                return `<tr style="background:rgba(37,99,235,0.07);border-top:2px solid var(--border)"><td style="font-weight:700;color:var(--accent)">Total</td><td style="font-weight:700;font-size:11px;color:var(--text-dim)">${dr}</td><td style="font-weight:700">${fmtNum(sf,1)}</td><td style="font-weight:700">${fmtNum(se,1)}</td><td style="font-weight:700;color:var(--accent)">${fmtNum(sc,1)}</td></tr>`;
            };
            const mkSysRows = arr => arr.map(r=>`<tr><td>${r.system||r.mat||""}</td><td style="font-size:11px;color:var(--text-dim)">${dr}</td><td>${fmtNum(r.fab_di||0,1)}</td><td>${fmtNum(r.erect_di||0,1)}</td><td style="color:var(--accent)">${fmtNum(r.completed_di||0,1)}</td></tr>`).join("") + mkTotalRow(arr);
            const mkSubRows = (arr, showTotal=false, totalArr=null) => arr.map(r=>`<tr><td>${r.sub_area||""}</td><td style="font-size:11px;color:var(--text-dim)">${dr}</td><td>${fmtNum(r.fab_di||0,1)}</td><td>${fmtNum(r.erect_di||0,1)}</td><td style="color:var(--accent)">${fmtNum(r.completed_di||0,1)}</td></tr>`).join("") + (showTotal ? mkTotalRow(totalArr||arr) : "");
            document.querySelector("#weeklySystemTable tbody").innerHTML = mkSysRows(bd.systems||[]);
            document.querySelector("#weeklyMaterialTable tbody").innerHTML = mkSysRows(bd.materials||[]);
            const allSubs = bd.subareas || [];
            const mid = Math.ceil(allSubs.length / 2);
            document.querySelector("#weeklySubareaTable tbody").innerHTML  = mkSubRows(allSubs.slice(0, mid), false);
            document.querySelector("#weeklySubareaTable2 tbody").innerHTML = mkSubRows(allSubs.slice(mid), true, allSubs);
        } catch(e2) { console.warn("Breakdown fetch failed", e2); }
    } catch(e) { console.error("Weekly failed",e); }
}

// ================================================================================
//  UNIT / AREA
// ================================================================================
async function loadUnitArea() {
    try {
        const dash = await getDashData();

        // ?? KPI Cards: show all units/areas regardless of completion
        const allUnitsKpi = [...(dash.units || [])].sort((a,b)=>a.unit.localeCompare(b.unit));
        document.getElementById("unitCards").innerHTML = allUnitsKpi.map(u => {
            const p=u.progress_pct, c=pctColor(p);
            return `<div class="unit-card"><div class="unit-card-name">Unit ${u.unit}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(u.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(u.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p}% complete</div><div class="unit-card-di">${u.total_joints.toLocaleString()} joints</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
        }).join("");

        const areaKpiOrder = { "YD BLDG": 1, "YARD": 2, "MB #1": 3, "MB #2": 4 };
        const allAreasKpi = [...(dash.areas || [])].sort((a,b)=>(areaKpiOrder[a.area]||99) - (areaKpiOrder[b.area]||99));
        document.getElementById("areaCards").innerHTML = allAreasKpi.map(a => {
            const p=a.progress_pct, c=pctColor(p);
            return `<div class="unit-card" style="flex:1;"><div class="unit-card-name">Area: ${a.area}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(a.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(a.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p}% complete</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
        }).join("");

        // ?? Unit Chart: Stacked (Completed DI + Remaining DI)
        const allUnits = [...(dash.units || [])].sort((a,b)=>a.unit.localeCompare(b.unit));
        destroyChart("unitChart");
        charts["unitChart"] = new Chart(document.getElementById("unitChart").getContext("2d"), {
            type: "bar",
            data: {
                labels: allUnits.map(u => `Unit ${u.unit}`),
                datasets: [
                    {
                        label: "Completed DI",
                        data: allUnits.map(u => u.completed_di || 0),
                        backgroundColor: "rgba(37,99,235,0.85)",
                        borderColor: "#2563eb",
                        borderWidth: 1, barPercentage: 0.28, categoryPercentage: 0.6, stack: "s",
                        datalabels: { display: ctx => (allUnits[ctx.dataIndex]?.completed_di||0) > 0,
                            anchor: "end", align: "top", offset: 2,
                            color: "#93c5fd", font: { size: 10, weight: "700", family: "DM Mono, monospace" },
                            formatter: v => fmtNum(v, 0) }
                    },
                    {
                        label: "Remaining DI",
                        data: allUnits.map(u => (u.total_di||0) - (u.completed_di||0)),
                        backgroundColor: "rgba(100,116,139,0.3)",
                        borderColor: "rgba(100,116,139,0.5)",
                        borderWidth: 1, barPercentage: 0.28, categoryPercentage: 0.6, stack: "s",
                        datalabels: { display: false }
                    }
                ]
            },
            options: {
                ...chartOpts("DI"),
                scales: { ...chartOpts("DI").scales, y: { ...chartOpts("DI").scales.y, beginAtZero: true, stacked: true } },
                plugins: { ...chartOpts("DI").plugins, legend: { display: true, position: "top", labels: { color: "#7a95b8", boxWidth: 12, font: { size: 10 } } } }
            }
        });
        charts["unitChart"].resize();

        // ?? Area Chart: Stacked horizontal (Completed DI + Remaining DI)
        const allAreas = dash.areas || [];
        const areaOrder = { "YD BLDG": 1, "YARD": 2, "MB #1": 3, "MB #2": 4 };
        const sortedAreas = [...allAreas].sort((a, b) => (areaOrder[a.area]||99) - (areaOrder[b.area]||99));

        destroyChart("areaChart");
        const ctxArea = document.getElementById("areaChart");
        if (ctxArea && sortedAreas.length) {
            charts["areaChart"] = new Chart(ctxArea.getContext("2d"), {
                type: "bar",
                data: {
                    labels: sortedAreas.map(a => a.area),
                    datasets: [
                        {
                            label: "Completed DI",
                            data: sortedAreas.map(a => a.completed_di || 0),
                            backgroundColor: "rgba(99,102,241,0.85)",
                            borderColor: "#6366f1",
                            borderWidth: 1, barPercentage: 0.6, stack: "s",
                            datalabels: { display: ctx => (sortedAreas[ctx.dataIndex]?.completed_di||0) > 0,
                                anchor: "end", align: "right", offset: 4,
                                color: "#60a5fa", font: { size: 10, weight: "700", family: "DM Mono, monospace" },
                                formatter: v => fmtNum(v, 0) }
                        },
                        {
                            label: "Remaining DI",
                            data: sortedAreas.map(a => (a.total_di||0) - (a.completed_di||0)),
                            backgroundColor: "rgba(100,116,139,0.3)",
                            borderColor: "rgba(100,116,139,0.5)",
                            borderWidth: 1, barPercentage: 0.6, stack: "s",
                            datalabels: { display: false }
                        }
                    ]
                },
                options: {
                    ...chartOpts("DI"),
                    indexAxis: "y",
                    scales: { ...chartOpts("DI").scales, x: { ...chartOpts("DI").scales.x, beginAtZero: true, stacked: true }, y: { ...chartOpts("DI").scales.y, stacked: true } },
                    plugins: { ...chartOpts("DI").plugins, legend: { display: true, position: "top", labels: { color: "#7a95b8", boxWidth: 12, font: { size: 10 } } } }
                }
            });
            charts["areaChart"].resize();
        }
    } catch(e) { console.error("UnitArea failed",e); }
}

// ================================================================================
//  JOINT MASTER
// ================================================================================
async function loadJointMaster() {
    const unit=document.getElementById("jm-unit")?.value||"", system=document.getElementById("jm-system")?.value||"",
          status=document.getElementById("jm-status")?.value||"", isoVal=document.getElementById("jm-iso")?.value?.trim()||"",
          subarea=document.getElementById("jm-subarea")?.value||"", offset=jmCurrentPage*JM_PAGE_SIZE;
    try {
        const params=new URLSearchParams({limit:JM_PAGE_SIZE,offset});
        if(unit)params.set("unit",unit); if(system)params.set("system",system); if(status)params.set("status",status);
        if(isoVal)params.set("iso",isoVal); if(subarea)params.set("sub_area",subarea);
        const res=await apiFetch(`/api/joints?${params}`);
        jmData=res.data;
        document.getElementById("jm-count").textContent=`${res.count.toLocaleString()} rows loaded (page ${jmCurrentPage+1})`;
        document.getElementById("jm-page-info").textContent=`Page ${jmCurrentPage+1}`;
        renderJMTable(jmData); updateIsoBulkPanel(isoVal,jmData);
    } catch(e) { console.error("JM load failed",e); }
}

function updateIsoBulkPanel(isoVal,rows){
    const panel=document.getElementById("jm-iso-bulk-panel"); if(!panel)return;
    if(!isoVal||rows.length===0){panel.style.display="none";return;}
    const isoRows=rows.filter(r=>r.iso_drawing===isoVal);
    if(isoRows.length===0){panel.style.display="none";return;}
    panel.style.display="flex";
    const completedCount=isoRows.filter(r=>r.date_completed).length;
    document.getElementById("jm-iso-info").textContent=`${isoVal}  쨌  ${isoRows.length} joints  쨌  ${completedCount} completed`;
}

async function applyIsoBulkDate(){
    const isoVal=document.getElementById("jm-iso")?.value?.trim();
    let dateVal=document.getElementById("jm-bulk-date")?.value?.trim();
    if(!isoVal){toast("Please enter ISO Drawing No. first","error");return;}
    if(!dateVal){toast("Please enter date (YY-MM-DD)","error");return;}
    if(!/^\d{2,4}-\d{2}-\d{2}$/.test(dateVal)){toast("Invalid date format (YY-MM-DD)","error");return;}
    if(dateVal.length===8)dateVal="20"+dateVal;
    const targets=jmData.filter(r=>r.iso_drawing===isoVal);
    if(targets.length===0){toast("No joints found for this ISO","error");return;}
    const btn=document.getElementById("jm-bulk-apply-btn");
    if(btn){btn.disabled=true;btn.textContent="Saving...";}
    try{
        let saved=0;
        for(const r of targets){
            await fetch(`${API}/api/joints/${r.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:dateVal})});
            const el=document.getElementById(`date-${r.id}`);if(el)el.value=dateVal;saved++;
        }
        toast(`??${saved} joints saved (${isoVal}) ??KPI updating...`);
        _autoRefreshKpi();
        updateIsoBulkPanel(isoVal,jmData);
    }catch(e){toast(`??Bulk save failed: ${e.message}`,"error");}
    finally{if(btn){btn.disabled=false;btn.textContent="Apply to All";}}
}

async function clearIsoBulkDate(){
    const isoVal=document.getElementById("jm-iso")?.value?.trim();
    if(!isoVal){toast("Please enter ISO Drawing No. first","error");return;}
    const targets=jmData.filter(r=>r.iso_drawing===isoVal);
    if(targets.length===0){toast("No joints found for this ISO","error");return;}
    if(!confirm(`${isoVal}\nDelete dates for all ${targets.length} joints?`))return;
    try{
        for(const r of targets){
            await fetch(`${API}/api/joints/${r.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:null})});
            const el=document.getElementById(`date-${r.id}`);if(el)el.value="";
        }
        toast(`??${targets.length} joints cleared (${isoVal}) ??KPI updating...`);
        _autoRefreshKpi();
        updateIsoBulkPanel(isoVal,jmData);
    }catch(e){toast(`??Bulk clear failed: ${e.message}`,"error");}
}

function jmPage(dir){jmCurrentPage=Math.max(0,jmCurrentPage+dir);loadJointMaster();}

function renderJMTable(rows){
    const tbody=document.getElementById("jmBody");
    tbody.innerHTML=rows.map(r=>{
        const dStr=r.date_completed?r.date_completed.substring(0,10):"";
        const wVal=r.welder||"";
        return `<tr id="jmrow-${r.id}"><td>${r.id}</td><td>${r.unit||""}</td><td>${r.system||""}</td><td>${r.sub_area||""}</td><td>${r.iso_drawing||""}</td><td>${r.rev||""}</td><td>${r.spool_no||""}</td><td>${r.mat||""}</td><td>${r.size_inch||""}</td><td>${r.sf||""}</td><td>${r.joint_no||""}</td><td><input class="cell-input" id="welder-${r.id}" type="text" value="${wVal}" style="width:100px" placeholder="Welder ID"></td><td><input class="cell-input" id="date-${r.id}" type="text" value="${dStr}" placeholder="YY-MM-DD"></td><td style="white-space:nowrap"><button class="btn-save-row" onclick="saveJointDate(${r.id})">Save</button><button class="btn-clear-row" onclick="clearJointDate(${r.id})">Clear</button><button class="btn-clear-row" style="color:#ff5252;border-color:#ff5252;margin-left:5px" onclick="deleteJoint(${r.id})">&#128465;</button></td></tr>`;
    }).join("");
}

function openAddJointModal(){document.getElementById("addJointModal").style.display="flex";}
function closeAddJointModal(){document.getElementById("addJointModal").style.display="none";}

async function submitNewJoint(){
    const data={unit:document.getElementById("new-unit").value.trim(),system:document.getElementById("new-system").value.trim(),sub_area:document.getElementById("new-area").value.trim(),line_no:document.getElementById("new-line_no").value.trim(),iso_drawing:document.getElementById("new-iso").value.trim(),rev:document.getElementById("new-rev").value.trim(),spool_no:document.getElementById("new-spool").value.trim(),mat:document.getElementById("new-mat").value.trim(),size_inch:parseFloat(document.getElementById("new-size").value)||0,sf:document.getElementById("new-sf").value.trim(),joint_no:document.getElementById("new-joint_no").value.trim(),welder:document.getElementById("new-welder").value.trim(),completed:false};
    try{
        const r=await fetch(`${API}/api/joints`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast("??Joint added successfully");closeAddJointModal();loadJointMaster();fetch("/api/cache/clear");
    }catch(e){toast("??Failed to add joint","error");}
}

async function deleteJoint(id){
    if(!confirm("Are you sure you want to delete this joint? (ID: "+id+")"))return;
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"DELETE"});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`??Joint ID ${id} deleted`);loadJointMaster();fetch("/api/cache/clear");
    }catch(e){toast("??Failed to delete","error");}
}

async function clearJointDate(id){
    const el=document.getElementById(`date-${id}`);if(el)el.value='';
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`??ID ${id} date cleared! KPI updating...`);
        _autoRefreshKpi();
    }catch(e){toast(`??Clear failed: ${e.message}`,"error");}
}

async function saveJointDate(id){
    let val=document.getElementById(`date-${id}`)?.value?.trim()||'';
    let welder=document.getElementById(`welder-${id}`)?.value?.trim()||'';
    if(val){if(!/^\d{2,4}-\d{2}-\d{2}$/.test(val)){toast("Invalid date format (YY-MM-DD)","error");return;}if(val.length===8)val="20"+val;}
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:val||null, welder:welder||null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`??ID ${id} saved! KPI updating...`);
        _autoRefreshKpi();
    }catch(e){toast(`??Save failed: ${e.message}`,"error");}
}

// ================================================================================
//  SUPPORT MASTER
// ================================================================================
async function loadSupportMaster() {
    const unit=document.getElementById("sm-unit")?.value||"", system=document.getElementById("sm-system")?.value||"",
          status=document.getElementById("sm-status")?.value||"", isoVal=document.getElementById("sm-iso")?.value?.trim()||"",
          subarea=document.getElementById("sm-subarea")?.value||"", phase=document.getElementById("sm-phase")?.value||"",
          offset=smCurrentPage*SM_PAGE_SIZE;
    try {
        const params=new URLSearchParams({limit:SM_PAGE_SIZE,offset});
        if(unit)params.set("unit",unit); if(system)params.set("system",system); if(status)params.set("status",status);
        if(isoVal)params.set("iso",isoVal); if(subarea)params.set("sub_area",subarea); if(phase)params.set("phase",phase);
        const res=await apiFetch(`/api/support-master?${params}`);
        smData=res.data;
        document.getElementById("sm-count").textContent=`${res.count.toLocaleString()} rows loaded (page ${smCurrentPage+1})`;
        document.getElementById("sm-page-info").textContent=`Page ${smCurrentPage+1}`;
        renderSMTable(smData); updateSmBulkPanel(isoVal,smData);
    } catch(e) { console.error("SM load failed",e); }
}

function renderSMTable(rows) {
    const tbody=document.getElementById("smBody");
    tbody.innerHTML=rows.map((r,i)=>{
        const dStr=r.date_completed?r.date_completed.substring(0,10):"";
        const wVal=r.welder||"";
        return `<tr id="smrow-${r.id}" style="text-align:center">
          <td>${smCurrentPage*SM_PAGE_SIZE + i + 1}</td>
          <td>${r.phase||""}</td><td>${r.unit||""}</td><td>${r.system||""}</td><td>${r.area||""}</td><td>${r.sub_area||""}</td>
          <td>${r.support_drawing||""}</td><td>${r.revision||""}</td>
          <td>${r.iso_drawing||""}</td><td>${r.line_no||""}</td>
          <td><input class="cell-input" id="sm-welder-${r.id}" type="text" value="${wVal}" style="width:90px; text-align:center" placeholder="Welder"></td>
          <td><input class="cell-input" id="sm-date-${r.id}" type="text" value="${dStr}" style="width:90px; text-align:center" placeholder="YY-MM-DD"></td>
          <td style="white-space:nowrap"><button class="btn-save-row" onclick="saveSM(${r.id})">Save</button><button class="btn-clear-row" onclick="clearSM(${r.id})">Clear</button><button class="btn-clear-row" style="color:#ff5252;border-color:#ff5252;margin-left:4px" onclick="deleteSM(${r.id})">&#128465;</button></td>
        </tr>`;
    }).join("");
}

function smPage(dir){smCurrentPage=Math.max(0,smCurrentPage+dir);loadSupportMaster();}

async function saveSM(id){
    let val=document.getElementById(`sm-date-${id}`)?.value?.trim()||'';
    let welder=document.getElementById(`sm-welder-${id}`)?.value?.trim()||'';
    if(val){if(!/^\d{2,4}-\d{2}-\d{2}$/.test(val)){toast("Invalid date format (YY-MM-DD)","error");return;}if(val.length===8)val="20"+val;}
    try{
        const r=await fetch(`${API}/api/support-master/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:val||null, welder:welder||null, completed:!!val})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`??Support ID ${id} saved!`);
        _autoRefreshKpi();
    }catch(e){toast(`??Save failed: ${e.message}`,"error");}
}

async function clearSM(id){
    document.getElementById(`sm-date-${id}`).value='';
    document.getElementById(`sm-welder-${id}`).value='';
    try{
        await fetch(`${API}/api/support-master/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:null, welder:null, completed:false})});
        toast(`??Support ID ${id} cleared!`);
        _autoRefreshKpi();
    }catch(e){toast("??Clear failed","error");}
}

async function deleteSM(id){
    if(!confirm("Delete support record ID: "+id+"?"))return;
    try{
        await fetch(`${API}/api/support-master/${id}`,{method:"DELETE"});
        toast("??Support deleted"); loadSupportMaster(); _autoRefreshKpi();
    }catch(e){toast("??Delete failed","error");}
}

function openSMModal(){document.getElementById("smModal").style.display="flex";}
function closeSMModal(){document.getElementById("smModal").style.display="none";}

async function submitNewSM(){
    const data={phase:document.getElementById("sm-new-phase").value.trim(),unit:document.getElementById("sm-new-unit").value.trim(),system:document.getElementById("sm-new-system").value.trim(),area:document.getElementById("sm-new-area").value.trim(),sub_area:document.getElementById("sm-new-subarea").value.trim(),support_drawing:document.getElementById("sm-new-support").value.trim(),revision:document.getElementById("sm-new-rev").value.trim(),iso_drawing:document.getElementById("sm-new-iso").value.trim(),line_no:document.getElementById("sm-new-line").value.trim(),welder:document.getElementById("sm-new-welder").value.trim(),date_completed:document.getElementById("sm-new-date").value.trim()||null};
    if(data.date_completed && data.date_completed.length===8) data.date_completed = "20"+data.date_completed;
    data.completed = !!data.date_completed;
    try{
        const r=await fetch(`${API}/api/support-master`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast("??Support added!");closeSMModal();loadSupportMaster();fetch("/api/cache/clear");
    }catch(e){toast("??Failed to add support","error");}
}

function updateSmBulkPanel(isoVal,rows){
    const panel=document.getElementById("sm-iso-bulk-panel"); if(!panel)return;
    if(!isoVal||rows.length===0){panel.style.display="none";return;}
    const targets=rows.filter(r=>r.iso_drawing===isoVal || r.support_drawing===isoVal);
    if(targets.length===0){panel.style.display="none";return;}
    panel.style.display="flex";
    const compCount=targets.filter(r=>r.date_completed).length;
    document.getElementById("sm-iso-info").textContent=`${isoVal}  쨌  ${targets.length} supports  쨌  ${compCount} completed`;
}

async function applySmBulkDate(){
    const isoVal=document.getElementById("sm-iso")?.value?.trim();
    let dateVal=document.getElementById("sm-bulk-date")?.value?.trim();
    if(!isoVal||!dateVal){toast("ISO and Date required","error");return;}
    if(dateVal.length===8)dateVal="20"+dateVal;
    const targets=smData.filter(r=>r.iso_drawing===isoVal || r.support_drawing===isoVal);
    try{
        for(const r of targets){
            await fetch(`${API}/api/support-master/${r.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:dateVal, completed:true})});
        }
        toast(`??${targets.length} supports saved!`); _autoRefreshKpi(); loadSupportMaster();
    }catch(e){toast("??Bulk save failed","error");}
}

async function clearSmBulkDate(){
    const isoVal=document.getElementById("sm-iso")?.value?.trim();
    if(!isoVal)return;
    const targets=smData.filter(r=>r.iso_drawing===isoVal || r.support_drawing===isoVal);
    if(!confirm("Clear all dates for "+isoVal+"?"))return;
    try{
        for(const r of targets){
            await fetch(`${API}/api/support-master/${r.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:null, completed:false})});
        }
        toast(`??${targets.length} supports cleared!`); _autoRefreshKpi(); loadSupportMaster();
    }catch(e){toast("??Bulk clear failed","error");}
}

async function exportSMExcel(){
    if(!smData||smData.length===0){toast("No data to export","error");return;}
    const exportData=smData.map(r=>({"PHASE":r.phase||"","UNIT":r.unit||"","SYSTEM":r.system||"","AREA":r.area||"","SUB AREA":r.sub_area||"","SUPPORT DRAWING":r.support_drawing||"","REV":r.revision||"","ISO DRAWING":r.iso_drawing||"","LINE NO":r.line_no||"","WELDER":r.welder||"","WORK DATE":r.date_completed?r.date_completed.substring(0,10):""}));
    const ws=XLSX.utils.json_to_sheet(exportData),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"SupportMaster");
    await downloadWithPicker(wb,"Support_Master_Export.xlsx");
}

async function importSMExcel(){
    const fileInput=document.getElementById("sm-import-file");
    if(!fileInput.files.length)return;
    const fd=new FormData();fd.append("file",fileInput.files[0]);
    try{
        const res=await fetch("/api/support-master/import",{method:"POST",body:fd});
        const data=await res.json();
        if(data.ok){toast(`??Imported ${data.inserted} supports`);loadSupportMaster();_autoRefreshKpi();}
        else{toast(`??Import failed: ${data.error}`,"error");}
    }catch(e){toast("??Import error","error");}
    finally{fileInput.value="";}
}



// ================================================================================
//  REFRESH
// ================================================================================
async function refreshData(){
    try{
        await fetch("/api/cache/clear");_dashData=null;
        const data=await getDashData(true);renderKPI(data.kpi,data.weekly);
        const visPage=document.querySelector(".page:not(.hidden)")?.id?.replace("page-","");
        if(visPage)navigate(visPage);
        toast("??Data refreshed!");
    }catch(e){toast("Refresh failed: "+e.message,"error");}
}

// Auto-refresh KPI in background after save operations
async function _autoRefreshKpi(){
    _dashData=null;
    fetch("/api/cache/clear").catch(()=>{});
    await new Promise(r=>setTimeout(r,1000));
    for(let i=0;i<20;i++){
        await new Promise(r=>setTimeout(r,1500));
        try{
            const res=await fetch("/api/dashboard");
            if(res.status===200){
                _dashData=await res.json();
                renderKPI(_dashData.kpi,_dashData.weekly);
                const visPage=document.querySelector(".page:not(.hidden)")?.id?.replace("page-","");
                if(visPage==="unitarea")loadUnitArea();
                else if(visPage==="overview")loadOverview();
                toast("??KPI updated");
                return;
            }
        }catch(e){}
    }
}

// ================================================================================
//  CHART HELPERS
// ================================================================================
function destroyChart(id){if(charts[id]){charts[id].destroy();delete charts[id];}}

function chartOpts(yLabel){
    return{
        responsive:true,maintainAspectRatio:false,animation:{duration:500},
        plugins:{legend:{labels:{color:"#7a95b8",font:{family:"DM Mono, monospace",size:11},boxWidth:12,padding:14}},tooltip:{backgroundColor:"#111827",borderColor:"#1e2d45",borderWidth:1,titleColor:"#e2eaf6",bodyColor:"#7a95b8",padding:10}},
        scales:{x:{ticks:{color:"#7a95b8",font:{family:"DM Mono, monospace",size:10},maxRotation:0},grid:{display:false,drawBorder:false}},y:{ticks:{color:"#7a95b8",font:{family:"DM Mono, monospace",size:10}},grid:{display:false,drawBorder:false},title:{display:!!yLabel,text:yLabel,color:"#4a6080",font:{size:10}},beginAtZero:true}}
    };
}

async function downloadWithPicker(wb,name){
    const wbout=XLSX.write(wb,{bookType:'xlsx',type:'array'}),blob=new Blob([wbout],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    if('showSaveFilePicker'in window){try{const handle=await window.showSaveFilePicker({suggestedName:name,types:[{description:'Excel File',accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}]});const writable=await handle.createWritable();await writable.write(blob);await writable.close();return true;}catch(e){if(e.name==='AbortError')return false;console.warn("Picker failed, falling back",e);}}
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},2000);return true;
}

async function exportSystemsExcel(type){
    if(!_dashData){toast("Data not loaded yet","error");return;}
    let exportData=[],fileName="";
    if(type==='system'){exportData=(_dashData.systems||[]).map(s=>({"System":s.system,"Total DI":s.plan_di,"Completed DI":s.completed_di,"Remaining DI":s.remaining_di,"Progress %":s.progress_pct}));fileName="System_Progress_Export.xlsx";}
    else{exportData=(_dashData.subareas||_dashData.areas||[]).map(s=>({"Name":s.sub_area||s.area||"","Total DI":s.total_di,"Completed DI":s.completed_di,"Remaining DI":s.remaining_di||(s.total_di-s.completed_di),"Progress %":s.progress_pct}));fileName="SubArea_Progress_Export.xlsx";}
    if(exportData.length===0){toast("No data available to export","error");return;}
    const ws=XLSX.utils.json_to_sheet(exportData),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Progress");
    const success=await downloadWithPicker(wb,fileName);if(success)toast(`${type==='system'?'System':'Sub Area'} export complete`);
}

async function exportJMExcel(){
    if(!jmData||jmData.length===0){toast("No data to export","error");return;}
    const exportData=jmData.map(r=>({"UNIT":r.unit||"","SYSTEM":r.system||"","SUB AREA":r.sub_area||"","ISO DRAWING":r.iso_drawing||"","REV":r.rev||"","SPOOL NO":r.spool_no||"","MAT":r.mat||"","SIZE":r.size_inch||"","S/F":r.sf||"","JOINT NO":r.joint_no||"","WELDER":r.welder||"","COMPLETED DATE":r.date_completed?r.date_completed.substring(0,10):""}));
    const ws=XLSX.utils.json_to_sheet(exportData),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"JointMaster");
    const success=await downloadWithPicker(wb,"Joint_Master_Export.xlsx");if(success)toast("Exported to .xlsx successfully");
}

async function importJMExcel(){
    const fileInput=document.getElementById("jm-import-file"),statusEl=document.getElementById("jm-import-status");
    if(!fileInput.files.length)return;
    const file=fileInput.files[0];statusEl.textContent="Uploading...";
    const fd=new FormData();fd.append("file",file);
    try{
        const res=await fetch("/api/joints/import",{method:"POST",body:fd});
        const data=await res.json();
        if(data.ok){toast(`??Successfully imported ${data.inserted} joints`);loadJointMaster();_autoRefreshKpi();}
        else{toast(`??Import failed: ${data.error}`,"error");}
    }catch(e){toast("??Network error during import","error");}
    finally{statusEl.textContent="";fileInput.value="";}
}

function downloadJMTemplate(){
    const cols=["unit","system","area","sub_area","line_no","iso_drawing","rev","spool_no","mat","size_inch","sf","joint_no","welder","phase","date_completed","remark"];
    const ws=XLSX.utils.json_to_sheet([{}],{header:cols}),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Template");
    XLSX.writeFile(wb,"JointMaster_Import_Template.xlsx");
}

function printPage(pageId){
    const pages=document.querySelectorAll('.page');pages.forEach(p=>p.classList.remove('page-print-active'));
    const target=document.getElementById("page-"+pageId);if(target)target.classList.add('page-print-active');
    window.print();pages.forEach(p=>p.classList.remove('page-print-active'));
}
async function loadWelder() {
    _selectedWelder = null;
    try {
        const [res, dailyRes, dashData] = await Promise.all([
            fetch("/api/welder-summary"),
            fetch("/api/welder-daily"),
            getDashData()
        ]);
        if (!res.ok) throw new Error("API error " + res.status);
        _welderData = await res.json();
        const dailyData = dailyRes.ok ? await dailyRes.json() : (_welderData.trend || []);
        renderWelder(_welderData, dashData);
        renderWelderDaily(dailyData, _welderData.weekly || []);
    } catch(e) {
        console.error("Welder load failed", e);
    }
}

function renderWelder(data, dashData) {
    const s = data.stats || {};
    const elActive = document.getElementById("welder-active");
    const elJoints = document.getElementById("welder-total-joints");
    const elTotalDi = document.getElementById("welder-total-di");
    const elAvgDi = document.getElementById("welder-avg-di");
    const elWeekDi = document.getElementById("welder-week-di");

    if (elActive) elActive.textContent = s.active_welders || 0;
    if (elJoints) elJoints.textContent = (s.total_joints || 0).toLocaleString();
    if (elTotalDi) elTotalDi.textContent = fmtNum(s.total_di, 0);
    
    const ranking = data.ranking || [];
    const avgDiDay = ranking.length
        ? ranking.reduce((sum, r) => sum + (r.avg_di_per_day || 0), 0) / ranking.length
        : 0;
    if (elAvgDi) elAvgDi.textContent = fmtNum(avgDiDay, 2);

    if (elWeekDi && dashData) {
        const wkData  = dashData.weekly || [];
        const actWks  = wkData.filter(w => w.completed_di > 0);
        const lastWk  = actWks[actWks.length - 1];
        elWeekDi.textContent = lastWk ? fmtNum(lastWk.completed_di, 0) : "??;
        const subEl = elWeekDi.nextElementSibling;
        if (subEl && lastWk) subEl.textContent = lastWk.week_label || "Last Week DI";
    }

    _updateWelderKpiBar(data);

    if (!ranking.length) {
        const empty = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:20px">No data.</td></tr>`;
        const bA = document.getElementById("welderRankBodyA");
        const bB = document.getElementById("welderRankBodyB");
        if (bA) bA.innerHTML = empty;
        if (bB) bB.innerHTML = "";
    } else {
        const sortedRanking = ranking.slice().sort((a, b) => (b.avg_di_per_day || 0) - (a.avg_di_per_day || 0));
        _renderSplitWelderTable(sortedRanking, "welderRankBodyA", "welderRankBodyB", "var(--accent)");
    }

    // Weekly Chart: Relabel starting from 2026-W14 as W0
    destroyChart("welderTrendChart");
    const trendEl = document.getElementById("welderTrendChart");
    const weeklyAll = data.weekly || [];
    if (trendEl && weeklyAll.length) {
        const startIdx = weeklyAll.findIndex(w => w.week_label === "2026-W14");
        const baseWks = startIdx !== -1 ? weeklyAll.slice(startIdx) : weeklyAll.slice(-8);
        
        // Map labels to W0, W1, ...
        const showWks = baseWks.map((w, i) => ({
            ...w,
            display_label: `W${i}`
        }));
        
        charts["welderTrendChart"] = new Chart(trendEl.getContext("2d"), {
            type: "bar",
            data: {
                labels: showWks.map(w => w.display_label),
                datasets: [
                    { label: "Total DI", data: showWks.map(w => w.total_di), backgroundColor: "rgba(34,211,161,0.45)", borderColor: "#22d3a1", borderWidth: 1, barPercentage: 0.5, categoryPercentage: 0.5, yAxisID: "y", datalabels: { display: false } },
                    { type: "line", label: "AVG DI PER WELDER", data: showWks.map(w => w.avg_di_per_welder), borderColor: "#60a5fa", borderWidth: 2, pointRadius: 4, yAxisID: "y2", datalabels: { display: true, color: "#2563eb", font: { size: 10, weight: "bold" }, anchor: "end", align: "top", offset: 4, formatter: v => v ? fmtNum(v, 1) : "" } }
                ]
            },
            options: { ...chartOpts(), scales: { x: { ticks: { color: "#7a95b8" } }, y: { position: "left", beginAtZero: true, grace: '25%' }, y2: { position: "right", beginAtZero: true, grace: '25%', grid: { display: false } } } }
        });
    }

    // Monthly Chart: Fixed 2026-03 to 2026-09
    destroyChart("welderSysChart");
    const sysEl = document.getElementById("welderSysChart");
    const monthlyAll = data.monthly || [];
    if (sysEl) {
        const moFrame = ["2026-04","2026-05","2026-06","2026-07","2026-08","2026-09"];
        const moMap = {}; monthlyAll.forEach(m => moMap[m.month] = m);
        const last6m = moFrame.map(mo => moMap[mo] || { month: mo, total_di: 0, avg_di_per_welder: null });

        charts["welderSysChart"] = new Chart(sysEl.getContext("2d"), {
            type: "bar",
            data: {
                labels: last6m.map(m => m.month),
                datasets: [
                    { label: "Total DI", data: last6m.map(m => m.total_di), backgroundColor: "rgba(99,102,241,0.45)", borderColor: "#6366f1", borderWidth: 1, barPercentage: 0.5, categoryPercentage: 0.5, yAxisID: "y", datalabels: { display: false } },
                    { type: "line", label: "AVG DI PER WELDER", data: last6m.map(m => m.avg_di_per_welder), borderColor: "#60a5fa", borderWidth: 2, pointRadius: 4, yAxisID: "y2", datalabels: { display: true, color: "#2563eb", font: { size: 10, weight: "bold" }, anchor: "end", align: "top", offset: 4, formatter: v => v ? fmtNum(v, 1) : "" } }
                ]
            },
            options: { ...chartOpts(), scales: { x: { ticks: { color: "#7a95b8" } }, y: { position: "left", beginAtZero: true, grace: '25%' }, y2: { position: "right", beginAtZero: true, grace: '25%', grid: { display: false } } } }
        });
    }
}



function drillWelder(welderId) {
    if (!_welderData) return;
    const wInfo = _welderData.ranking.find(r => r.welder === welderId);
    if (!wInfo) return;
    const panel = document.getElementById("welder-drill-panel");
    if (!panel) return;
    panel.style.display = "block";
    document.getElementById("drill-welder-name").textContent = `?뫕 ${welderId}`;
    document.getElementById("drill-joints").textContent = wInfo.joints;
    document.getElementById("drill-total-di").textContent = fmtNum(wInfo.total_di, 1);
    document.getElementById("drill-working-days").textContent = wInfo.working_days || "-";
    document.getElementById("drill-avg-di-day").textContent = fmtNum(wInfo.avg_di_per_day, 2);

    destroyChart("drillDailyChart");
    const dEl = document.getElementById("drillDailyChart");
    if (dEl && wInfo.daily_list) {
        charts["drillDailyChart"] = new Chart(dEl.getContext("2d"), {
            type: "bar",
            data: { labels: wInfo.daily_list.map(d => d.date), datasets: [{ label: "DI", data: wInfo.daily_list.map(d => d.di), backgroundColor: "rgba(0,200,255,0.5)", borderColor: "#00c8ff", borderWidth: 1 }] },
            options: { ...chartOpts(), plugins: { legend: { display: false }, datalabels: { display: false } } }
        });
    }

    destroyChart("drillSysChart");
    const sEl = document.getElementById("drillSysChart");
    if (sEl && wInfo.system_list) {
        charts["drillSysChart"] = new Chart(sEl.getContext("2d"), {
            type: "doughnut",
            data: { labels: wInfo.system_list.map(s => s.system), datasets: [{ data: wInfo.system_list.map(s => s.di), backgroundColor: ["#00c8ff","#22d3a1","#f5c542","#ef4444","#6366f1","#ec4899"] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: "#7a95b8", font: { size: 10 } } } } }
        });
    }
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function exportWelderExcel() {
    if (!_welderData?.ranking.length) return;
    const rows = _welderData.ranking.map(r => ({ "Welder ID": r.welder, "Total Joints": r.joints, "Total DI": r.total_di, "Working Days": r.working_days, "Avg DI/Day": r.avg_di_per_day }));
    const ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "WelderRanking");
    const ok = await downloadWithPicker(wb, "Welder_Performance_Export.xlsx"); if (ok) toast("??Exported");
}

function renderWelderDaily(daily, weekly) {
    const wrap = document.getElementById("welderDailyTableWrap");
    if (!wrap) return;
    if (!daily.length) { wrap.innerHTML = `<p style="color:var(--text-dim);font-size:11px;padding:10px">No daily data.</p>`; return; }
    const last10 = daily.slice(0, 10).reverse();
    const ths = last10.map(d => `<th style="text-align:center">${(d.day||d.date||"").slice(5)}</th>`).join("");
    const tWelders = last10.map(d => `<td style="text-align:center">${d.welder_count}</td>`).join("");
    const tDI = last10.map(d => `<td style="text-align:center">${fmtNum(d.total_di, 1)}</td>`).join("");

    wrap.innerHTML = `<table class="data-table" style="width:100%">
        <thead><tr><th style="text-align:left">Metric</th>${ths}</tr></thead>
        <tbody>
            <tr><td style="color:var(--text-dim)">Welders</td>${tWelders}</tr>
            <tr><td style="color:var(--text-dim)">Total DI</td>${tDI}</tr>
        </tbody>
    </table>`;
}

function _renderSplitWelderTable(rows, bodyIdA, bodyIdB, accentColor) {
    const mid = Math.ceil(rows.length / 2);
    const half1 = rows.slice(0, mid);
    const half2 = rows.slice(mid);
    const bA = document.getElementById(bodyIdA);
    const bB = document.getElementById(bodyIdB);
    if (bA) bA.innerHTML = _welderHalfRows(half1, 0, accentColor);
    if (bB) bB.innerHTML = _welderHalfRows(half2, mid, accentColor);
}

function _welderHalfRows(rows, startIdx, accentColor) {
    return rows.map((r, i) => `<tr onclick="drillWelder('${r.welder}')" style="cursor:pointer">
        <td style="text-align:center;color:var(--text-dim)">${startIdx + i + 1}</td>
        <td style="color:${accentColor};font-weight:600">${r.welder}</td>
        <td style="text-align:right">${r.joints}</td>
        <td style="text-align:right">${fmtNum(r.total_di, 1)}</td>
        <td style="text-align:right;color:var(--green);font-weight:600">${fmtNum(r.avg_di_per_day, 2)}</td>
    </tr>`).join("");
}
