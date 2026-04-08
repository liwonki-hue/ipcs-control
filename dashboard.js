// dashboard.js Full frontend logic  v18.8

const API = "";  // Flask runs on same origin
let charts = {};
let jmData = [];
let jmCurrentPage = 0;
const JM_PAGE_SIZE = 50;
let weekData = [];
let weekScheduleFull = [];
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
});

function showLoader(show, msg) {
    let el = document.getElementById("bop-loader");
    if (!el) {
        el = document.createElement("div");
        el.id = "bop-loader";
        el.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(11,15,26,0.88);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;font-family:Barlow,sans-serif";
        el.innerHTML = `
          <div style="width:48px;height:48px;border:3px solid #1e2d45;border-top:3px solid #00d4ff;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:16px"></div>
          <div style="color:#00d4ff;font-size:14px;font-weight:600;letter-spacing:0.06em">LOADING DATA</div>
          <div style="color:#7a95b8;font-size:11px;margin-top:6px;font-family:DM Mono,monospace">47,304 joints · please wait...</div>
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
function navigate(page) {
    document.querySelectorAll(".nav-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.page === page);
    });
    document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
    document.getElementById(`page-${page}`)?.classList.remove("hidden");

    switch(page) {
        case "overview":    loadOverview();     break;
        case "systems":     loadSystems(); loadSubArea(); break;
        case "weekly":      loadWeekly();       break;
        case "unitarea":    requestAnimationFrame(() => loadUnitArea()); break;
        case "joint_master":loadJointMaster();  break;
        case "week_plan":   loadWeekPlan();     break;
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
    if (v > 0)   return "#f5c542";
    return "#94a3b8";
}

function fmtNum(n, d=1) {
    if (n === null || n === undefined || isNaN(n)) return "–";
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
        console.log("[BOP] MetaData loaded:", metaData);
        const unitSel    = document.getElementById("jm-unit");
        const systemSel  = document.getElementById("jm-system");
        const subareaSel = document.getElementById("jm-subarea");
        if (unitSel) { unitSel.innerHTML = '<option value="">Unit</option>'; metaData.units.forEach(u => unitSel.add(new Option(u, u))); }
        if (systemSel) { systemSel.innerHTML = '<option value="">System</option>'; metaData.systems.forEach(s => systemSel.add(new Option(s, s))); }
        if (subareaSel && metaData.sub_areas) {
            subareaSel.innerHTML = '<option value="">Sub Area</option>';
            metaData.sub_areas.forEach(s => subareaSel.add(new Option(s, s)));
        }
    } catch(e) { console.error("Meta load failed", e); }
}

// ================================================================================
//  KPI RENDER
// ================================================================================
function renderKPI(d, wkData) {
    document.getElementById("reportDate").textContent = d.report_date;
    document.getElementById("kpi-overall").textContent     = `${d.overall_pct}%`;
    document.getElementById("kpi-overall-sub").textContent = `${fmtNum(d.completed_di,0)} / ${fmtNum(d.total_plan_di,0)} DI · ${d.completed_joints.toLocaleString()} joints`;
    document.getElementById("kpi-bar").style.width = `${Math.min(d.overall_pct,100)}%`;

    const totalEl    = document.getElementById("kpi-total-di");
    const totalSubEl = document.getElementById("kpi-total-di-sub");
    if (totalEl)    totalEl.textContent    = fmtNum(d.total_plan_di, 0);
    if (totalSubEl) totalSubEl.textContent = `${d.overall_pct}% · ${d.total_joints?.toLocaleString() || "–"} joints`;

    document.getElementById("kpi-fab").textContent     = fmtNum(d.fab_di, 0);
    document.getElementById("kpi-fab-sub").textContent = `${d.fab_pct ?? "–"}% fabricated`;
    document.getElementById("kpi-erect").textContent     = fmtNum(d.erect_di, 0);
    document.getElementById("kpi-erect-sub").textContent = `${d.erect_pct ?? "–"}% erected`;
    document.getElementById("kpi-remain").textContent     = fmtNum(d.remaining_di,0);
    document.getElementById("kpi-remain-sub").textContent = `${(100-d.overall_pct).toFixed(1)}% remaining`;

    const actWks = (wkData||[]).filter(w => w.completed_di > 0);
    const kpiWeekVal = document.getElementById("kpi-week");
    const kpiWeekSub = document.getElementById("kpi-week-sub");
    if (actWks.length) {
        const lw  = actWks[actWks.length-1];
        const weeksTbl = (_dashData?.weeks || []).find(w => w.week_no === lw.week_no);
        const realPlan = weeksTbl ? (weeksTbl.plan_fab_di||0) + (weeksTbl.plan_erect_di||0) : 0;
        const color = realPlan > 0 ? (lw.completed_di >= realPlan ? "#22d3a1" : "#ff5252") : "#f5c542";
        document.getElementById("kpi-week-card").style.borderTopColor = color;
        kpiWeekVal.textContent = fmtNum(lw.completed_di, 0);
        kpiWeekVal.style.color = color;
        if (realPlan > 0) {
            const dev = lw.completed_di - realPlan;
            kpiWeekSub.textContent = (dev >= 0 ? "▲" : "▼") + fmtNum(Math.abs(dev), 0) + " DI vs Plan " + fmtNum(realPlan, 0);
        } else {
            kpiWeekSub.textContent = fmtNum(lw.completed_di, 0) + " DI · No plan set";
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
        const gc = pct>=80?"#22d3a1":pct>=50?"#f5c542":"#ff8c42";
        const gp = document.getElementById("gaugePath");
        gp.style.stroke = gc; gp.style.strokeDashoffset = offset;
        document.getElementById("gaugeText").textContent = `${pct}%`;
        document.getElementById("gaugeText").style.fill = gc;

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
                { label:"Ideal Plan", type:"line", data:wkView.map(w=>w.cumul_ideal), borderColor:"rgba(74,96,128,0.4)", borderDash:[5,5], borderWidth:1.5, fill:false, pointRadius:0, tension:0.1, order:1 },
                { label:"Actual Plan", type:"line", data:wkView.map(w=>w.cumul_plan), borderColor:"#f5c542", borderDash:[3,2], borderWidth:1.5, fill:false, pointRadius:0, tension:0.1, order:2 },
                { label:"Actual Work DI", type:"bar", data:wkView.map(w=>indMap[w.week_no]||null), backgroundColor:"rgba(37,99,235,0.6)", borderColor:"#2563eb", borderWidth:1, borderRadius:2, barPercentage:0.7, order:3, datalabels:{display:true,align:'top',anchor:'end',offset:2,color:'#2563eb',font:{size:9,weight:'600'},formatter:(v)=>v>0?fmtNum(v,0):''} }
            ]},
            options: { ...chartOpts("Cumulative DI (Lines) / Weekly DI (Bars)"),
                scales: { ...chartOpts("").scales, x:{...chartOpts("").scales.x, ticks:{...chartOpts("").scales.x.ticks,maxRotation:0,autoSkip:false,callback:function(val,index){const label=this.getLabelForValue(val);const wkNum=parseInt(label.replace("W",""));if(wkNum===1||wkNum%5===0)return label;return "";}}}, y:{...chartOpts("").scales.y,beginAtZero:true} },
                plugins:{...chartOpts("").plugins,legend:{display:true,position:'top',labels:{color:'#7a95b8',boxWidth:12,font:{size:10}}}}, animation:{duration:600} }
        });

        let latestPlanIdx = -1;
        for (let i=wkData.length-1; i>=0; i--) { if (wkData[i].completed_di>0) { latestPlanIdx=i; break; } }
        let last4Wks = [];
        if (latestPlanIdx===-1) { const today=new Date(); today.setHours(0,0,0,0); let idx=wkData.findIndex(w=>w.start_date&&new Date(w.start_date)<=today&&today<=new Date(w.end_date)); if(idx===-1)idx=0; last4Wks=wkData.slice(idx,idx+4); }
        else { let s=latestPlanIdx-3; if(s<0)s=0; last4Wks=wkData.slice(s,s+4); }

        destroyChart("weeklyBar");
        charts["weeklyBar"] = new Chart(document.getElementById("weeklyBar").getContext("2d"), {
            type:"bar",
            data:{labels:last4Wks.map(w=>w.week_label),datasets:[
                {label:"Actual Work",type:"line",data:last4Wks.map(w=>w.completed_di||null),borderColor:"#2563eb",borderWidth:2,fill:false,tension:0.3,order:0,datalabels:{display:true,align:'top',color:'#2563eb',font:{weight:'bold',size:10},offset:4,formatter:(v)=>v>0?fmtNum(v,1):''}},
                {label:"Ideal Plan",data:last4Wks.map(w=>(w.ideal_di>0)?w.ideal_di:null),backgroundColor:"rgba(148,163,184,0.2)",borderColor:"rgba(148,163,184,0.4)",borderWidth:1,barPercentage:0.5,categoryPercentage:0.5,order:2},
                {label:"Actual Plan",data:last4Wks.map(w=>(w.plan_di>0)?w.plan_di:null),backgroundColor:"rgba(34,197,94,0.45)",borderColor:"rgba(34,197,94,0.6)",borderWidth:1,barPercentage:0.5,categoryPercentage:0.5,order:1}
            ]},
            options:{...chartOpts("DI"),scales:{...chartOpts("DI").scales,y:{...chartOpts("DI").scales.y,beginAtZero:true}},plugins:{...chartOpts("DI").plugins,legend:{display:true,position:"top",labels:{boxWidth:12,font:{size:10},color:"#475569"}}}}
        });

        document.getElementById("unitOverview").innerHTML = units.map(u => {
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
        const dash=await getDashData(), data=dash.systems;
        document.getElementById("systemBars").innerHTML = data.map(s=>{ const p=s.progress_pct,c=pctColor(p); return `<div class="prog-row"><div class="prog-head"><span class="prog-name">${s.system}</span><div class="prog-stats"><span>${fmtNum(s.completed_di,0)} / ${fmtNum(s.plan_di,0)} DI</span><span class="prog-pct" style="color:${c}">${p}%</span></div></div><div class="prog-track"><div class="prog-fill" style="width:${Math.min(p,100)}%;background:linear-gradient(90deg,${c}60,${c})"></div></div></div>`; }).join("");
        const sorted=[...data].sort((a,b)=>a.progress_pct-b.progress_pct);
        destroyChart("systemChart");
        const ctxSys=document.getElementById("systemChart");
        if(ctxSys) charts["systemChart"]=new Chart(ctxSys.getContext("2d"),{type:"bar",data:{labels:sorted.map(s=>s.system),datasets:[{label:"Plan",data:sorted.map(s=>s.plan_di),backgroundColor:"rgba(74,96,128,0.4)"},{label:"Actual",data:sorted.map(s=>s.completed_di),backgroundColor:sorted.map(s=>pctColor(s.progress_pct))}]},options:{...chartOpts("DI"),indexAxis:"y",plugins:{...chartOpts("DI").plugins}}});
    } catch(e) { console.error("Systems failed",e); }
}

// ================================================================================
//  SUB AREA
// ================================================================================
async function loadSubArea() {
    try {
        const dash=await getDashData(), data=dash.subareas||[];
        if(!data.length){document.getElementById("subareaBars").innerHTML='<div style="color:#7a95b8;padding:20px;text-align:center;font-size:12px">No sub_area data found in joint_master</div>';return;}
        document.getElementById("subareaBars").innerHTML=data.map(s=>{const p=s.progress_pct,c=pctColor(p);return `<div class="prog-row"><div class="prog-head"><span class="prog-name">${s.sub_area}</span><div class="prog-stats"><span>${fmtNum(s.completed_di,0)} / ${fmtNum(s.total_di,0)} DI</span><span class="prog-pct" style="color:${c}">${p}%</span></div></div><div class="prog-track"><div class="prog-fill" style="width:${Math.min(p,100)}%;background:linear-gradient(90deg,${c}60,${c})"></div></div></div>`;}).join("");
        const sorted=[...data].sort((a,b)=>a.progress_pct-b.progress_pct);
        destroyChart("subareaChart");
        const ctxSub=document.getElementById("subareaChart");
        if(ctxSub) charts["subareaChart"]=new Chart(ctxSub.getContext("2d"),{type:"bar",data:{labels:sorted.map(s=>s.sub_area),datasets:[{label:"Plan DI",data:sorted.map(s=>s.total_di),backgroundColor:"rgba(74,96,128,0.4)"},{label:"Actual DI",data:sorted.map(s=>s.completed_di),backgroundColor:sorted.map(s=>pctColor(s.progress_pct))}]},options:{...chartOpts("DI"),indexAxis:"y"}});
    } catch(e) { console.error("SubArea failed",e); }
}

// ================================================================================
//  WEEKLY
// ================================================================================
async function loadWeekly() {
    try {
        const dash=await getDashData(), data=dash.weekly;
        const actWks=data.filter(w=>w.completed_di>0), lw=actWks[actWks.length-1];
        if(lw){
            const dev=lw.completed_di-lw.plan_di, c=dev>=0?"#22d3a1":"#ff5252";
            document.getElementById("weeklyKpi").innerHTML=[["This Week Plan",fmtNum(lw.plan_di,0),"#4a6080"],["This Week Actual",fmtNum(lw.completed_di,0),c],["Deviation (DI)",`${dev>=0?"+":""}${fmtNum(dev,0)}`,c],["Cumul. Actual",fmtNum(actWks.reduce((s,w)=>s+w.completed_di,0),0),"var(--accent)"]]
                .map(([l,v,c])=>`<div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value" style="font-size:20px;color:${c};font-weight:400">${v}</div></div>`).join("");
        }
        destroyChart("weeklyTrend");
        charts["weeklyTrend"]=new Chart(document.getElementById("weeklyTrend").getContext("2d"),{
            type:"line",
            data:{labels:actWks.map(w=>w.week_label),datasets:[
                {label:"Plan DI",data:actWks.map(w=>w.plan_di),borderColor:"rgba(148,163,184,0.7)",borderDash:[6,4],borderWidth:1.5,pointRadius:3,pointBackgroundColor:"rgba(148,163,184,0.7)",pointBorderColor:"rgba(148,163,184,0.7)",tension:0.2,order:2,datalabels:{display:true,align:"bottom",offset:4,color:"rgba(148,163,184,0.85)",font:{size:9,family:"DM Mono, monospace"},formatter:v=>v>0?fmtNum(v,0):""}},
                {label:"Actual DI",data:actWks.map(w=>w.completed_di),borderColor:"#2563eb",borderWidth:2.5,pointRadius:6,pointBackgroundColor:actWks.map(w=>w.completed_di>=w.plan_di?"#22d3a1":"#ef4444"),pointBorderColor:"#fff",pointBorderWidth:2,tension:0.2,order:1,datalabels:{display:true,align:"top",offset:5,color:"#60a5fa",font:{size:10,weight:"700",family:"DM Mono, monospace"},formatter:v=>v>0?fmtNum(v,0):""}}
            ]},
            options:{...chartOpts("DI"),plugins:{...chartOpts("DI").plugins,legend:{display:true,position:"top",labels:{color:"#7a95b8",boxWidth:20,font:{size:11},usePointStyle:true,pointStyle:"line"}}}}
        });
        const tbody=document.querySelector("#weeklyTable tbody");
        tbody.innerHTML=actWks.map(w=>{const dev=w.completed_di-w.plan_di,c=dev>=0?"#22d3a1":"#ff5252";return `<tr><td style="color:var(--accent)">${w.week_label}</td><td>${fmtNum(w.plan_di,0)}</td><td style="color:${c}">${fmtNum(w.completed_di,0)}</td><td style="color:${c}">${dev>=0?"+":""}${fmtNum(dev,0)}</td></tr>`;}).join("");
    } catch(e) { console.error("Weekly failed",e); }
}

// ================================================================================
//  UNIT / AREA
// ================================================================================
async function loadUnitArea() {
    try {
        const dash = await getDashData();

        // ── KPI Cards: show only active units/areas (with some completed work)
        const activeUnits = (dash.units||[]).filter(u => (u.completed_di||0) > 0);
        document.getElementById("unitCards").innerHTML = activeUnits.map(u => {
            const p=u.progress_pct, c=pctColor(p);
            return `<div class="unit-card"><div class="unit-card-name">Unit ${u.unit}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(u.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(u.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p}% complete</div><div class="unit-card-di">${u.total_joints.toLocaleString()} joints</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
        }).join("");

        const activeAreas = (dash.areas||[]).filter(a => (a.completed_di||0) > 0);
        document.getElementById("areaCards").innerHTML = activeAreas.map(a => {
            const p=a.progress_pct, c=pctColor(p);
            return `<div class="unit-card" style="flex:1;"><div class="unit-card-name">Area: ${a.area}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(a.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(a.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p}% complete</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
        }).join("");

        // ── Unit Chart: ALL units shown (gray total_di bars for all)
        //    Completed DI bar only when > 0 → null = 0px (no ghost bars)
        const allUnits = dash.units || [];
        destroyChart("unitChart");
        charts["unitChart"] = new Chart(document.getElementById("unitChart").getContext("2d"), {
            type: "bar",
            data: {
                labels: allUnits.map(u => `Unit ${u.unit}`),
                datasets: [
                    {
                        label: "Total DI",
                        data: allUnits.map(u => u.total_di),
                        backgroundColor: "rgba(100,116,139,0.3)",
                        borderColor: "rgba(100,116,139,0.5)",
                        borderWidth: 1, borderRadius: 3, barPercentage: 0.55,
                        order: 2, datalabels: { display: false }
                    },
                    {
                        label: "Completed DI",
                        data: allUnits.map(u => u.completed_di > 0 ? u.completed_di : null),
                        backgroundColor: "rgba(37,99,235,0.85)",
                        borderColor: "#2563eb",
                        borderWidth: 1, borderRadius: 3, barPercentage: 0.55,
                        order: 1,
                        datalabels: { display: true, anchor: "end", align: "top", offset: 3,
                            color: "#e2eaf6", font: { size: 10, weight: "700", family: "DM Mono, monospace" },
                            formatter: v => v > 0 ? fmtNum(v, 0) : "" }
                    }
                ]
            },
            options: {
                ...chartOpts("DI"),
                scales: { ...chartOpts("DI").scales, y: { ...chartOpts("DI").scales.y, beginAtZero: true } },
                plugins: { ...chartOpts("DI").plugins, legend: { display: true, position: "top", labels: { color: "#7a95b8", boxWidth: 12, font: { size: 10 } } } }
            }
        });
        charts["unitChart"].resize();

        // ── Area Chart: ALL areas shown (gray total_di bars for all)
        //    Completed DI bar only when > 0 → null = 0px
        const allAreas = dash.areas || [];
        const areaOrder = { "MB #1": 1, "MB #2": 2, "YD BLDG": 3, "YARD": 4 };
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
                            label: "Total DI",
                            data: sortedAreas.map(a => a.total_di),
                            backgroundColor: "rgba(100,116,139,0.3)",
                            borderColor: "rgba(100,116,139,0.5)",
                            borderWidth: 1, borderRadius: 3, barPercentage: 0.6,
                            order: 2, datalabels: { display: false }
                        },
                        {
                            label: "Completed DI",
                            data: sortedAreas.map(a => a.completed_di > 0 ? a.completed_di : null),
                            backgroundColor: "rgba(245,197,66,0.85)",
                            borderColor: "#f5c542",
                            borderWidth: 1, borderRadius: 3, barPercentage: 0.6,
                            order: 1,
                            datalabels: { display: true, anchor: "end", align: "right", offset: 4,
                                color: "#e2eaf6", font: { size: 10, weight: "700", family: "DM Mono, monospace" },
                                formatter: v => v > 0 ? fmtNum(v, 0) : "" }
                        }
                    ]
                },
                options: {
                    ...chartOpts("DI"),
                    indexAxis: "y",
                    scales: { ...chartOpts("DI").scales, x: { ...chartOpts("DI").scales.x, beginAtZero: true }, y: { ...chartOpts("DI").scales.y } },
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
    document.getElementById("jm-iso-info").textContent=`${isoVal}  ·  ${isoRows.length} joints  ·  ${completedCount} completed`;
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
        toast(`✓ ${saved} joints saved (${isoVal}) — Refresh to update KPI`);
        _dashData=null;
        fetch("/api/cache/clear").catch(()=>{});
        updateIsoBulkPanel(isoVal,jmData);
    }catch(e){toast(`✗ Bulk save failed: ${e.message}`,"error");}
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
        toast(`✓ ${targets.length} joints cleared (${isoVal}) — Refresh to update KPI`);
        _dashData=null;
        fetch("/api/cache/clear").catch(()=>{});
        updateIsoBulkPanel(isoVal,jmData);
    }catch(e){toast(`✗ Bulk clear failed: ${e.message}`,"error");}
}

function jmPage(dir){jmCurrentPage=Math.max(0,jmCurrentPage+dir);loadJointMaster();}

function renderJMTable(rows){
    const tbody=document.getElementById("jmBody");
    tbody.innerHTML=rows.map(r=>{
        const dStr=r.date_completed?r.date_completed.substring(0,10):"";
        return `<tr id="jmrow-${r.id}"><td>${r.id}</td><td>${r.unit||""}</td><td>${r.system||""}</td><td>${r.sub_area||""}</td><td>${r.iso_drawing||""}</td><td>${r.rev||""}</td><td>${r.spool_no||""}</td><td>${r.mat||""}</td><td>${r.size_inch||""}</td><td>${r.sf||""}</td><td>${r.joint_no||""}</td><td><input class="cell-input" id="date-${r.id}" type="text" value="${dStr}" placeholder="YY-MM-DD"></td><td style="white-space:nowrap"><button class="btn-save-row" onclick="saveJointDate(${r.id})">Save</button><button class="btn-clear-row" onclick="clearJointDate(${r.id})">Clear</button><button class="btn-clear-row" style="color:#ff5252;border-color:#ff5252;margin-left:5px" onclick="deleteJoint(${r.id})">&#128465;</button></td></tr>`;
    }).join("");
}

function openAddJointModal(){document.getElementById("addJointModal").style.display="flex";}
function closeAddJointModal(){document.getElementById("addJointModal").style.display="none";}

async function submitNewJoint(){
    const data={unit:document.getElementById("new-unit").value.trim(),system:document.getElementById("new-system").value.trim(),sub_area:document.getElementById("new-area").value.trim(),line_no:document.getElementById("new-line_no").value.trim(),iso_drawing:document.getElementById("new-iso").value.trim(),rev:document.getElementById("new-rev").value.trim(),spool_no:document.getElementById("new-spool").value.trim(),mat:document.getElementById("new-mat").value.trim(),size_inch:parseFloat(document.getElementById("new-size").value)||0,sf:document.getElementById("new-sf").value.trim(),joint_no:document.getElementById("new-joint_no").value.trim(),completed:false};
    try{
        const r=await fetch(`${API}/api/joints`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast("✓ Joint added successfully");closeAddJointModal();loadJointMaster();fetch("/api/cache/clear");
    }catch(e){toast("✗ Failed to add joint","error");}
}

async function deleteJoint(id){
    if(!confirm("Are you sure you want to delete this joint? (ID: "+id+")"))return;
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"DELETE"});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`✓ Joint ID ${id} deleted`);loadJointMaster();fetch("/api/cache/clear");
    }catch(e){toast("✗ Failed to delete","error");}
}

async function clearJointDate(id){
    const el=document.getElementById(`date-${id}`);if(el)el.value='';
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`✓ ID ${id} date cleared! (Refresh to update KPI)`);
        _dashData=null;
        fetch("/api/cache/clear").catch(()=>{});
    }catch(e){toast(`✗ Clear failed: ${e.message}`,"error");}
}

async function saveJointDate(id){
    let val=document.getElementById(`date-${id}`)?.value?.trim()||'';
    if(val){if(!/^\d{2,4}-\d{2}-\d{2}$/.test(val)){toast("Invalid date format (YY-MM-DD)","error");return;}if(val.length===8)val="20"+val;}
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:val||null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`✓ ID ${id} saved! (Refresh to update KPI)`);
        _dashData=null;
        fetch("/api/cache/clear").catch(()=>{});
    }catch(e){toast(`✗ Save failed: ${e.message}`,"error");}
}

// ================================================================================
//  WEEK PLAN
// ================================================================================
let isoSummaryData=[], weekPlanItems=[], selectedWeekNo=null, selectedWeekId=null;

async function refreshWeeklySummary(){
    try{
        await fetch("/api/cache/clear").catch(()=>{});_dashData=null;
        const fresh=await getDashData(true);if(!fresh)return;
        weekData=fresh.weekly||[];weekScheduleFull=fresh.weeks||weekScheduleFull;
        if(weekScheduleFull.length>0)renderWeekTable(weekScheduleFull);
        renderKPI(fresh.kpi,fresh.weekly);
        const visPage=document.querySelector(".page:not(.hidden)")?.id?.replace("page-","");
        if(visPage==="overview")renderOverview(fresh.kpi,fresh.weekly,fresh.units);
    }catch(e){console.warn("Weekly summary refresh failed:",e);}
}

async function loadWeekPlan(){
    try{
        let dash=await getDashData();
        if(!dash.weeks||dash.weeks.length===0){_dashData=null;dash=await getDashData(true);}
        weekData=dash.weekly||[];const wkFull=dash.weeks||[];weekScheduleFull=wkFull;
        const sel=document.getElementById("wp-sel-week");
        if(sel){
            sel.innerHTML=wkFull.map(w=>`<option value="${w.id||w.week_no||""}" data-wk="${w.week_no}" data-start="${w.start_date||w.week_start_date||""}" data-end="${w.end_date||w.week_end_date||""}">W${w.week_no} · ${w.start_date||w.week_start_date||""} ~ ${w.end_date||w.week_end_date||""}</option>`).join("");
            const today=new Date();let bestIdx=0;
            wkFull.forEach((w,i)=>{const s=new Date(w.week_start_date),e=new Date(w.week_end_date);if(today>=s&&today<=e)bestIdx=i;});
            sel.selectedIndex=bestIdx;await onWeekSelected();
        }
        renderWeekTable(wkFull);refreshWeeklySummary();
        loadIsoSummary();
    }catch(e){console.error("WeekPlan load failed",e);}
}

async function loadIsoSummary(filterSystem="", filterUnit="", filterArea="", filterSubArea=""){
    const loadingEl=document.getElementById("wp-iso-loading");
    const countEl=document.getElementById("wp-iso-count");
    if(loadingEl)loadingEl.style.display="inline";
    try{
        const showAll=document.getElementById("wp-show-all")?.checked||false;
        const params=new URLSearchParams({show_all:showAll?"true":"false"});
        if(filterSystem)  params.set("system",   filterSystem);
        if(filterUnit)    params.set("unit",     filterUnit);
        if(filterArea)    params.set("area",     filterArea);
        if(filterSubArea) params.set("sub_area", filterSubArea);
        console.log(`[ISO] Requesting: /api/iso-summary?${params}`);
        isoSummaryData=await apiFetch(`/api/iso-summary?${params}`);
        console.log(`[ISO] Loaded ${isoSummaryData.length} records`);
        if(!filterSystem&&!filterUnit&&!filterArea&&!filterSubArea)populateIsoFilters();
        renderIsoSearchTable();
    }catch(e){
        if(countEl)countEl.textContent="Failed to load ISO data";
        console.error("ISO summary load failed",e);
    }finally{if(loadingEl)loadingEl.style.display="none";}
}

function searchIsoDrawings(){
    const filterSystem  =(document.getElementById("wp-filter-system")?.value||"").trim();
    const filterUnit    =(document.getElementById("wp-filter-unit")?.value||"").trim();
    const filterSubArea =(document.getElementById("wp-filter-subarea")?.value||"").trim();
    loadIsoSummary(filterSystem,filterUnit,"",filterSubArea);
}

function populateIsoFilters(){
    const units=metaData.units||[],systems=metaData.systems||[],areas=metaData.areas||["MB #1","MB #2","YD BLDG","YARD"],subareas=metaData.sub_areas||[];
    const fill=(id,items,label)=>{const el=document.getElementById(id);if(!el)return;const v=el.value;el.innerHTML=`<option value="">${label}</option>`+items.map(x=>`<option value="${x}">${x}</option>`).join("");el.value=v;};
    fill("wp-filter-unit",units,"All Units");fill("wp-filter-area",areas,"All Areas");fill("wp-filter-subarea",subareas,"All Sub Areas");fill("wp-filter-system",systems,"All Systems");
}

function renderIsoSearchTable(){
    const searchText=(document.getElementById("wp-iso-search")?.value||"").toLowerCase().trim();
    const showAll=document.getElementById("wp-show-all")?.checked||false;
    const filtered=isoSummaryData.filter(r=>{
        if(!showAll&&(r.remain_fab_di||0)<=0&&(r.remain_erect_di||0)<=0)return false;
        if(searchText){
            const haystack=`${r.iso_drawing||""} ${r.line_no||""} ${r.system||""}`.toLowerCase();
            if(!haystack.includes(searchText))return false;
        }
        return true;
    }).slice(0,500);
    const addedIsos=new Set(weekPlanItems.map(i=>i.iso_drawing));
    const tbody=document.getElementById("wpIsoSearchBody");if(!tbody)return;
    if(filtered.length===0){tbody.innerHTML=`<tr><td colspan="11" style="text-align:center;color:var(--text-dim);padding:20px">No results found (${isoSummaryData.length} ISOs loaded)</td></tr>`;return;}
    tbody.innerHTML=filtered.map(r=>{
        const added=addedIsos.has(r.iso_drawing);
        const rFab=r.remain_fab_di||0,rErect=r.remain_erect_di||0;
        const fabCol=rFab>0?"var(--accent)":"var(--text-dim)",erectCol=rErect>0?"var(--indigo)":"var(--text-dim)";
        return `<tr style="${added?'opacity:0.45':''}"><td>${r.unit||""}</td><td>${r.area||""}</td><td>${r.sub_area||""}</td><td>${r.system||""}</td><td style="font-family:'DM Mono',monospace;font-size:11px">${r.line_no||""}</td><td style="color:var(--text);font-family:'DM Mono',monospace;font-size:11px">${r.iso_drawing}</td><td style="color:${fabCol};font-family:'DM Mono',monospace">${fmtNum(rFab,1)}</td><td style="color:${erectCol};font-family:'DM Mono',monospace">${fmtNum(rErect,1)}</td><td style="color:var(--text-dim);font-size:11px">${fmtNum(r.total_fab_di,1)}</td><td style="color:var(--text-dim);font-size:11px">${fmtNum(r.total_erect_di,1)}</td><td>${added?`<span style="font-size:11px;color:var(--green);font-weight:600">&#10003; Added</span>`:`<button class="btn-sm" onclick="addIsoToPlan('${r.iso_drawing}')" style="background:var(--accent);color:#fff;border:none;padding:4px 12px;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer">+ Add</button>`}</td></tr>`;
    }).join("");
}

async function onWeekSelected(){
    const sel=document.getElementById("wp-sel-week"),opt=sel?.options[sel.selectedIndex];
    if(!opt)return;
    selectedWeekId=parseInt(sel.value);selectedWeekNo=parseInt(opt.dataset.wk);
    const periodEl=document.getElementById("wp-period");
    if(periodEl)periodEl.textContent=`W${selectedWeekNo} · ${opt.dataset.start} ~ ${opt.dataset.end}`;
    await loadWeekPlanItems();renderIsoSearchTable();
}

async function addIsoToPlan(isoNo){
    if(!selectedWeekId){toast("Please select a week first","error");return;}
    if(weekPlanItems.some(i=>i.iso_drawing===isoNo)){toast(`${isoNo} is already in the plan`,"error");return;}
    const iso=isoSummaryData.find(r=>r.iso_drawing===isoNo);
    if(!iso){toast("ISO data not found","error");return;}
    const body={week_schedule_id:selectedWeekId,week_no:selectedWeekNo,unit:iso.unit||"",area:iso.area||"",sub_area:iso.sub_area||"",system:iso.system||"",line_no:iso.line_no||"",iso_drawing:isoNo,plan_fab_di:0,plan_erect_di:0,remain_fab_di:iso.remain_fab_di,remain_erect_di:iso.remain_erect_di,total_fab_di:iso.total_fab_di,total_erect_di:iso.total_erect_di};
    try{
        const res=await fetch(`${API}/api/week-plan-items`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        const data=await res.json();if(!data.ok)throw new Error(data.error);
        toast(`✓ ${isoNo} added to plan`);await loadWeekPlanItems();renderIsoSearchTable();
    }catch(e){toast(`✗ Failed to add: ${e.message}`,"error");}
}

async function loadWeekPlanItems(){
    if(selectedWeekNo===null)return;
    try{weekPlanItems=await apiFetch(`/api/week-plan-items?week_no=${selectedWeekNo}`);renderPlanItemsTable();updateWeekPlanSummary();}
    catch(e){console.error("Plan items load failed",e);}
}

function renderPlanItemsTable(){
    const tbody=document.getElementById("wpPlanItemsBody");if(!tbody)return;
    if(weekPlanItems.length===0){tbody.innerHTML=`<tr><td colspan="11" style="text-align:center;color:var(--text-dim);padding:20px">No ISO drawings planned for this week. Use the search panel above to add ISOs.</td></tr>`;return;}
    tbody.innerHTML=weekPlanItems.map(item=>{
        const rFab=item.remain_fab_di||0,rErect=item.remain_erect_di||0,pFab=item.plan_fab_di||0,pErect=item.plan_erect_di||0;
        const fabWarn=pFab>rFab&&rFab>0?"border-color:var(--orange)":"",erectWarn=pErect>rErect&&rErect>0?"border-color:var(--orange)":"";
        return `<tr id="wpi-row-${item.id}"><td>${item.unit||""}</td><td>${item.area||""}</td><td>${item.sub_area||""}</td><td>${item.system||""}</td><td style="font-family:'DM Mono',monospace;font-size:11px">${item.line_no||""}</td><td style="color:var(--accent);font-family:'DM Mono',monospace;font-size:11px">${item.iso_drawing}</td><td style="color:var(--accent);font-family:'DM Mono',monospace;font-size:11px">${fmtNum(rFab,1)}</td><td style="color:var(--indigo);font-family:'DM Mono',monospace;font-size:11px">${fmtNum(rErect,1)}</td><td class="td-plan"><input type="number" class="cell-input" style="width:72px;${fabWarn}" id="wpi-fab-${item.id}" value="${pFab}" step="0.1" min="0" title="${rFab>0?'Remain: '+fmtNum(rFab,1)+' DI':''}"></td><td class="td-plan"><input type="number" class="cell-input" style="width:72px;${erectWarn}" id="wpi-erect-${item.id}" value="${pErect}" step="0.1" min="0" title="${rErect>0?'Remain: '+fmtNum(rErect,1)+' DI':''}"></td><td style="white-space:nowrap"><button class="btn-save-row" onclick="savePlanItemField(${item.id})">Save</button><button class="btn-clear-row" onclick="deletePlanItem(${item.id})">Del</button></td></tr>`;
    }).join("");
}

async function savePlanItemField(itemId){
    const fab=parseFloat(document.getElementById(`wpi-fab-${itemId}`)?.value)||0,erect=parseFloat(document.getElementById(`wpi-erect-${itemId}`)?.value)||0;
    const item=weekPlanItems.find(i=>i.id==itemId);
    if(item){
        if(fab>item.remain_fab_di){toast(`✗ Plan Fab DI cannot exceed Remain (${fmtNum(item.remain_fab_di,1)})`,"error");document.getElementById(`wpi-fab-${itemId}`).value=item.plan_fab_di;return;}
        if(erect>item.remain_erect_di){toast(`✗ Plan Erect DI cannot exceed Remain (${fmtNum(item.remain_erect_di,1)})`,"error");document.getElementById(`wpi-erect-${itemId}`).value=item.plan_erect_di;return;}
    }
    try{
        const r=await fetch(`${API}/api/week-plan-items/${itemId}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan_fab_di:fab,plan_erect_di:erect})});
        const d=await r.json();if(!d.ok)throw new Error(d.error);
        const it=weekPlanItems.find(i=>i.id===itemId);if(it){it.plan_fab_di=fab;it.plan_erect_di=erect;}
        updateWeekPlanSummary();toast("✓ Saved");_dashData=null;
        const wkEntry=weekData.find(w=>w.week_no===selectedWeekNo);
        if(wkEntry){const tf=weekPlanItems.reduce((s,r)=>s+(r.plan_fab_di||0),0),te=weekPlanItems.reduce((s,r)=>s+(r.plan_erect_di||0),0);wkEntry.fab_di=tf;wkEntry.erect_di=te;wkEntry.plan_di=tf+te;}
        if(weekScheduleFull.length>0)renderWeekTable(weekScheduleFull);refreshWeeklySummary();
    }catch(e){toast(`✗ Save failed: ${e.message}`,"error");}
}

async function deletePlanItem(itemId){
    if(!window.confirm("Delete this ISO plan item?"))return;
    try{
        const r=await fetch(`/api/week-plan-items/${itemId}`,{method:"DELETE"});
        const text=await r.text();let d;try{d=JSON.parse(text);}catch(pe){throw new Error("Server error: "+text.slice(0,100));}
        if(!d.ok)throw new Error(d.error||"Delete failed");
        weekPlanItems=weekPlanItems.filter(i=>i.id!=itemId);
        renderPlanItemsTable();updateWeekPlanSummary();renderIsoSearchTable();
        toast("✓ Item deleted");_dashData=null;
        const wkEntry=weekData.find(w=>w.week_no===selectedWeekNo);
        if(wkEntry){const tf=weekPlanItems.reduce((s,r)=>s+(r.plan_fab_di||0),0),te=weekPlanItems.reduce((s,r)=>s+(r.plan_erect_di||0),0);wkEntry.fab_di=tf;wkEntry.erect_di=te;wkEntry.plan_di=tf+te;}
        if(weekScheduleFull.length>0)renderWeekTable(weekScheduleFull);refreshWeeklySummary();
    }catch(e){console.error("Delete failed:",e);toast(`✗ Delete failed: ${e.message}`,"error");}
}

function updateWeekPlanSummary(){
    const totalFab=weekPlanItems.reduce((s,r)=>s+(r.plan_fab_di||0),0),totalErect=weekPlanItems.reduce((s,r)=>s+(r.plan_erect_di||0),0);
    const setTxt=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
    setTxt("wp-total-fab",fmtNum(totalFab,1));setTxt("wp-total-erect",fmtNum(totalErect,1));setTxt("wp-total-di",fmtNum(totalFab+totalErect,1));
    setTxt("wp-item-count",weekPlanItems.length);setTxt("wp-foot-fab",fmtNum(totalFab,1));setTxt("wp-foot-erect",fmtNum(totalErect,1));
}

function exportWeekPlanExcel(){
    if(!weekPlanItems||weekPlanItems.length===0){toast("No plan items to export","error");return;}
    const data=weekPlanItems.map(r=>({"Week No":selectedWeekNo,"Unit":r.unit||"","Area":r.area||"","Sub Area":r.sub_area||"","System":r.system||"","Line No":r.line_no||"","ISO Drawing":r.iso_drawing||"","Remain Fab DI":r.remain_fab_di||0,"Remain Erect DI":r.remain_erect_di||0,"Plan Fab DI":r.plan_fab_di||0,"Plan Erect DI":r.plan_erect_di||0}));
    const ws=XLSX.utils.json_to_sheet(data),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"WeekPlan");
    XLSX.writeFile(wb,`WeekPlan_W${selectedWeekNo}.xlsx`,{bookType:'xlsx'});toast("✓ Excel export complete (.xlsx)");
}

function exportWeekScheduleExcel(){
    if(!weekScheduleFull||weekScheduleFull.length===0){toast("No schedule data to export","error");return;}
    const actMap={};weekData.forEach(w=>{actMap[w.week_no]=w;});
    const data=weekScheduleFull.map(w=>{
        const act=actMap[w.week_no]||{},if1=w.plan_fab_di||0,ie1=w.plan_erect_di||0,it1=(if1+ie1)||w.plan_di||0;
        const apf=act.plan_fab_di||0,ape=act.plan_erect_di||0,apt=act.plan_di||0;
        const cd=act.completed_di||0,rd=apt-cd,pct=apt>0?parseFloat((cd/apt*100).toFixed(1)):0;
        return{"ID":w.id,"Week No":w.week_no,"Start Date":w.week_start_date,"End Date":w.week_end_date,"Ideal Plan FAB DI":if1,"Ideal Plan ERECT DI":ie1,"Ideal Plan TOTAL DI":it1,"Actual Plan FAB DI":apf,"Actual Plan ERECT DI":ape,"Actual Plan TOTAL DI":apt,"Completed DI":cd,"Remaining DI":rd,"Progress %":pct};
    });
    const ws=XLSX.utils.json_to_sheet(data),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"WeekSchedule");
    XLSX.writeFile(wb,"Weekly_Schedule_Summary.xlsx",{bookType:'xlsx'});toast("✓ Weekly Schedule exported (.xlsx)");
}

function loadWeekForm(){} function updateTotal(){}
async function saveWeekPlan(){toast("Please use the ISO plan items method","error");}
async function addWeekRow(){
    const wkno=parseInt(document.getElementById("nw-no")?.value),start=document.getElementById("nw-start")?.value?.trim(),end=document.getElementById("nw-end")?.value?.trim();
    const fab=parseFloat(document.getElementById("nw-fab")?.value)||0,erect=parseFloat(document.getElementById("nw-erect")?.value)||0;
    if(!start||!end){toast("Please enter Start and End Date","error");return;}
    try{
        await fetch(`${API}/api/weeks`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({week_no:wkno,week_start_date:start,week_end_date:end,plan_fab_di:fab,plan_erect_di:erect})});
        toast(`✓ Week ${wkno} added`);_dashData=null;await loadWeekPlan();
    }catch(e){toast(`✗ ${e.message}`,"error");}
}

// ================================================================================
//  WEEKLY SCHEDULE SUMMARY TABLE RENDER
// ================================================================================
function renderWeekTable(wkFull){
    const tbody=document.getElementById("wpBody");if(!tbody)return;
    const actMap={};weekData.forEach(w=>{actMap[w.week_no]=w;});
    if(!wkFull||wkFull.length===0){tbody.innerHTML=`<tr><td colspan="13" style="text-align:center;color:var(--text-dim);padding:20px;font-size:12px">No schedule data. Add weeks in the Week Plan section.</td></tr>`;return;}
    tbody.innerHTML=wkFull.map(w=>{
        const act=actMap[w.week_no]||{};
        const ideal_fab=w.ideal_fab_di||0,ideal_erect=w.ideal_erect_di||0,ideal_total=w.ideal_di||0;
        const act_plan_fab=w.plan_fab_di||0,act_plan_erect=w.plan_erect_di||0,act_plan_total=w.plan_di||0;
        const completed_di=act.completed_di||0,remaining_di=act_plan_total-completed_di;
        const pct=act_plan_total>0?(completed_di/act_plan_total*100).toFixed(1):"0.0";
        const pc=pctColor(parseFloat(pct));
        return `<tr><td>${w.id||'-'}</td><td>${w.week_no}</td><td>${w.start_date||w.week_start_date||'-'}</td><td>${w.end_date||w.week_end_date||'-'}</td><td class="td-plan" style="color:#93c5fd">${fmtNum(ideal_fab,1)}</td><td class="td-plan" style="color:#93c5fd">${fmtNum(ideal_erect,1)}</td><td class="td-plan" style="color:#93c5fd;font-weight:600">${fmtNum(ideal_total,1)}</td><td class="td-actual" style="color:#86efac">${fmtNum(act_plan_fab,1)}</td><td class="td-actual" style="color:#86efac">${fmtNum(act_plan_erect,1)}</td><td class="td-actual" style="color:#86efac;font-weight:600">${fmtNum(act_plan_total,1)}</td><td style="color:${pc};font-weight:600;font-family:'DM Mono',monospace">${fmtNum(completed_di,1)}</td><td style="color:${pc};font-weight:600;font-family:'DM Mono',monospace">${fmtNum(remaining_di,1)}</td><td style="color:${pc};font-weight:600">${pct}%</td></tr>`;
    }).join("");
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
        toast("↺ Data refreshed!");
    }catch(e){toast("Refresh failed: "+e.message,"error");}
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
    const exportData=jmData.map(r=>({"ID":r.id,"UNIT":r.unit||"","SYSTEM":r.system||"","SUB AREA":r.sub_area||"","ISO DRAWING":r.iso_drawing||"","REV":r.rev||"","SPOOL NO":r.spool_no||"","MAT":r.mat||"","SIZE":r.size_inch||"","S/F":r.sf||"","JOINT NO":r.joint_no||"","COMPLETED DATE":r.date_completed?r.date_completed.substring(0,10):""}));
    const ws=XLSX.utils.json_to_sheet(exportData),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"JointMaster");
    const success=await downloadWithPicker(wb,"Joint_Master_Export.xlsx");if(success)toast("Exported to .xlsx successfully");
}

function printPage(pageId){
    const pages=document.querySelectorAll('.page');pages.forEach(p=>p.classList.remove('page-print-active'));
    const target=document.getElementById("page-"+pageId);if(target)target.classList.add('page-print-active');
    window.print();pages.forEach(p=>p.classList.remove('page-print-active'));
}
