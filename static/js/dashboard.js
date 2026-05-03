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

    // Hide all pages
    document.querySelectorAll(".page").forEach(p => {
        p.classList.add("hidden");
        p.style.display = "";   // reset any inline display override
    });

    // Reset scroll to top on every page transition (forced)
    const pageBody = document.querySelector(".page-body");
    if (pageBody) {
        pageBody.scrollTop = 0;
        // Reinforce with a small timeout to ensure it hits after content load
        setTimeout(() => { pageBody.scrollTop = 0; }, 50);
    }
    window.scrollTo(0, 0);

    // Show target page
    const target = document.getElementById(`page-${page}`);
    const kpiRow = document.getElementById("kpiRow");

    if (target) {
        target.classList.remove("hidden");
        
        // --- PAGE SPECIFIC UI ADJUSTMENTS ---
        
        // Hide KPI row for Data Input and Reports to maximize workspace
        const dataInputPages = ["joint_master", "support_master", "testpkg_master", "simulation", "week_plan"];
        if (kpiRow) {
            kpiRow.style.display = dataInputPages.includes(page) ? "none" : "flex";
        }

        // Simulation page specific (already handled but reinforced)
        if (page === "simulation") {
            target.style.display = "flex";
            target.style.flexDirection = "column";
            target.style.height = "calc(100vh - 80px)"; // Increased height since KPI row is hidden
            const frame = document.getElementById("simulationFrame");
            if (frame && !frame.src.includes("localhost:8501")) {
                frame.src = "http://localhost:8501";
            }
        }
    }

    switch(page) {
        case "overview":    loadOverview();     break;
        case "early_power": loadEarlyPower();   break;
        case "systems":     loadSystems(); loadSubArea(); break;
        case "weekly":      loadWeekly();       break;
        case "unitarea":    requestAnimationFrame(() => loadUnitArea()); break;
        case "joint_master":loadJointMaster();  break;
        case "week_plan":   loadWeekPlan();     break;
        case "welder":      loadWelder();       break;
        case "support_master": loadSupportMaster(); break;
        case "testpkg_master": loadTestPkgMaster(); break;
        case "simulation":  /* handled above */ break;
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
    if (!d) return;
    document.getElementById("reportDate").textContent = d.report_date || "—";
    document.getElementById("kpi-overall").textContent     = `${d.overall_pct || 0}%`;
    document.getElementById("kpi-overall-sub").textContent = `${fmtNum(d.completed_di,0)} / ${fmtNum(d.total_plan_di,0)} DI · ${d.completed_joints?.toLocaleString() || "0"} joints`;
    document.getElementById("kpi-bar").style.width = `${Math.min(d.overall_pct || 0, 100)}%`;

    const totalEl    = document.getElementById("kpi-total-di");
    const totalSubEl = document.getElementById("kpi-total-di-sub");
    if (totalEl)    totalEl.textContent    = fmtNum(d.total_plan_di, 0);
    if (totalSubEl) totalSubEl.textContent = `${d.overall_pct || 0}% · ${d.total_joints?.toLocaleString() || "–"} joints`;

    document.getElementById("kpi-fab").textContent     = fmtNum(d.fab_di, 0);
    document.getElementById("kpi-fab-sub").textContent = `${d.fab_pct ?? "0"}% fabricated`;
    document.getElementById("kpi-erect").textContent     = fmtNum(d.erect_di, 0);
    document.getElementById("kpi-erect-sub").textContent = `${d.erect_pct ?? "0"}% erected`;
    document.getElementById("kpi-remain").textContent     = fmtNum(d.remaining_di, 0);
    document.getElementById("kpi-remain-sub").textContent = `${(100 - (d.overall_pct || 0)).toFixed(1)}% remaining`;

    const actWks = (wkData || []).filter(w => w.completed_di > 0);
    const kpiWeekVal = document.getElementById("kpi-week");
    const kpiWeekSub = document.getElementById("kpi-week-sub");
    if (actWks.length) {
        const lw  = actWks[actWks.length - 1];
        const weeksTbl = (_dashData?.weeks || []).find(w => w.week_no === lw.week_no);
        const realPlan = weeksTbl ? (weeksTbl.plan_fab_di || 0) + (weeksTbl.plan_erect_di || 0) : 0;
        const color = realPlan > 0 ? (lw.completed_di >= realPlan ? "#22d3a1" : "#ff5252") : "#f5c542";
        const card = document.getElementById("kpi-week-card");
        if (card) card.style.borderTopColor = color;
        if (kpiWeekVal) {
            kpiWeekVal.textContent = fmtNum(lw.completed_di, 0);
            kpiWeekVal.style.color = color;
        }
        if (kpiWeekSub) {
            if (realPlan > 0) {
                const dev = lw.completed_di - realPlan;
                kpiWeekSub.textContent = (dev >= 0 ? "▲" : "▼") + fmtNum(Math.abs(dev), 0) + " DI vs Plan " + fmtNum(realPlan, 0);
            } else {
                kpiWeekSub.textContent = fmtNum(lw.completed_di, 0) + " DI · No plan set";
            }
        }
    } else {
        const card = document.getElementById("kpi-week-card");
        if (card) card.style.borderTopColor = "#1e2d45";
        if (kpiWeekVal) {
            kpiWeekVal.textContent = "0";
            kpiWeekVal.style.color = "#4a6080";
        }
        if (kpiWeekSub) kpiWeekSub.textContent = "No activity this week";
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
        const d = kpi, pct = d.unified_readiness || d.overall_pct || 0;
        const r = 84, circ = Math.PI * r;
        const offset = circ * (1 - Math.min(pct/100,1));
        const gc = pct>=80?"#22d3a1":pct>=50?"#f5c542":"#ff8c42";
        const gp = document.getElementById("gaugePath");
        gp.style.stroke = gc; gp.style.strokeDashoffset = offset;
        document.getElementById("gaugeText").textContent = `${pct}%`;
        document.getElementById("gaugeText").style.fill = gc;

        const stats = document.getElementById("overviewStats");
        stats.innerHTML = [
            ["D/I Completion (wt 60%)", `${d.overall_pct||0}%`],
            ["Support (EA) (wt 20%)", `${d.support_pct||0}%`],
            ["Test Package (wt 20%)", `${d.testpkg_pct||0}%`],
            ["Total Plan DI", fmtNum(d.total_plan_di,0)],
            ["Completed DI", fmtNum(d.completed_di,0)]
        ].map(([l,v]) => `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`).join("");

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
                {label:"Actual Plan",data:last4Wks.map(w=>(w.plan_di>0)?w.plan_di:null),backgroundColor:"rgba(34,197,94,0.45)",borderColor:"rgba(34,197,94,0.6)",borderWidth:1,barPercentage:0.5,categoryPercentage:0.5,order:1,datalabels:{display:true,anchor:'end',align:'top',offset:2,color:'#22c55e',font:{weight:'bold',size:10},formatter:(v)=>v>0?fmtNum(v,1):''}}
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
//  EARLY POWER OVERVIEW
// ================================================================================
async function loadEarlyPower() {
    const data = await getDashData();
    renderEarlyPower(data.ep_kpi ? data.ep_kpi[0] : null, data.ep_unit, data.ep_sys, data.ep_area, data.ep_weekly);
}

async function renderEarlyPower(d, units, systems, areas, weekly) {
    if(!d) return;
    try {
        const d_total_di = d.total_di || 0;
        const d_completed_di = d.completed_di || 0;
        const pct = d_total_di > 0 ? Math.round((d_completed_di / d_total_di) * 100) : 0;
        
        let bottleneck = "";
        if(systems && systems.length > 0) {
            let maxRem = -1;
            let btnSys = "";
            for(const s of systems) {
                const rem = (s.total_di || 0) - (s.completed_di || 0);
                if(rem > maxRem && rem > 0) {
                    maxRem = rem;
                    btnSys = s.system;
                }
            }
            if(btnSys) bottleneck = `delayed by System ${btnSys} (${fmtNum(maxRem, 0)} DI remaining)`;
            else bottleneck = "All EP systems completed!";
        }
        
        const rdPct = document.getElementById("epReadinessPct");
        const rdTxt = document.getElementById("epReadinessText");
        if(rdPct) rdPct.textContent = `${pct}%`;
        if(rdTxt) rdTxt.textContent = `Early Power is ${pct}% ready, ${bottleneck}`;

        const r = 84, circ = Math.PI * r;
        const offset = circ * (1 - Math.min(pct/100,1));
        const gc = pct>=80?"#22d3a1":pct>=50?"#f5c542":"#ff8c42";
        const gp = document.getElementById("epGaugePath");
        if(gp) { gp.style.stroke = gc; gp.style.strokeDashoffset = offset; }
        const gt = document.getElementById("epGaugeText");
        if(gt) { gt.textContent = `${pct}%`; gt.style.fill = gc; }

        const stats = document.getElementById("epStats");
        if(stats) {
            stats.innerHTML = [["EP Plan DI",fmtNum(d_total_di,0)],["EP Completed DI",fmtNum(d_completed_di,0)],["EP Remaining DI",fmtNum(Math.max(0, d_total_di - d_completed_di),0)],["EP Completed Joints",`${(d.completed_joints||0).toLocaleString()} / ${(d.total_joints||0).toLocaleString()}`]]
                .map(([l,v]) => `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`).join("");
        }

        const disc = document.getElementById("epDisciplineList");
        if(disc) {
            const fab_pct = d.fab_total_di > 0 ? Math.round((d.fab_completed_di / d.fab_total_di) * 100) : 0;
            const erect_pct = d.erect_total_di > 0 ? Math.round((d.erect_completed_di / d.erect_total_di) * 100) : 0;
            disc.innerHTML = [["Fabrication (S)",fab_pct,"var(--accent)"],["Erection (F)",erect_pct,"var(--green)"]]
                .map(([n,p,c]) => `<div class="disc-row"><div class="disc-head"><span class="disc-name">${n}</span><span class="disc-pct" style="color:${c}">${p}%</span></div><div class="disc-track"><div class="disc-fill" style="width:${Math.min(p,100)}%;background:linear-gradient(90deg,${c}60,${c})"></div></div></div>`).join("");
        }

        const uDiv = document.getElementById("epUnitOverview");
        if(uDiv && units) {
            uDiv.innerHTML = units.map(u => {
                const u_pct = u.total_di > 0 ? Math.round((u.completed_di / u.total_di) * 100) : 0;
                const c = pctColor(u_pct);
                return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #162032"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px"><div><div style="font-size:13px;font-weight:600">Unit ${u.unit}</div><div style="font-size:10px;color:#7a95b8">Plan: ${fmtNum(u.total_di,0)} DI</div></div><div style="font-size:20px;font-weight:700;color:${c};font-family:'DM Mono',monospace">${u_pct}%</div></div><div style="height:4px;background:#1e2d45;border-radius:2px"><div style="height:100%;width:${Math.min(u_pct,100)}%;background:${c};border-radius:2px"></div></div><div style="font-size:10px;color:#7a95b8;margin-top:3px;font-family:'DM Mono',monospace">${fmtNum(u.completed_di,0)} / ${fmtNum(u.total_di,0)} DI</div></div>`;
            }).join("");
        }

        const sDiv = document.getElementById("epSysOverview");
        if(sDiv && systems) {
            sDiv.innerHTML = systems.map(s => {
                const s_pct = s.total_di > 0 ? Math.round((s.completed_di / s.total_di) * 100) : 0;
                const c = pctColor(s_pct);
                return `<div class="prog-row"><div class="prog-head"><span class="prog-name">${s.system}</span><div class="prog-stats"><span>${fmtNum(s.completed_di,0)} / ${fmtNum(s.total_di,0)} DI</span><span class="prog-pct" style="color:${c}">${s_pct}%</span></div></div><div class="prog-track"><div class="prog-fill" style="width:${Math.min(s_pct,100)}%;background:linear-gradient(90deg,${c}60,${c})"></div></div></div>`;
            }).join("");
        }

        const aDiv = document.getElementById("epAreaOverview");
        if(aDiv && areas) {
            aDiv.innerHTML = areas.map(a => {
                const a_pct = a.total_di > 0 ? Math.round((a.completed_di / a.total_di) * 100) : 0;
                const c = pctColor(a_pct);
                return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #162032"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px"><div><div style="font-size:13px;font-weight:600">${a.area}</div><div style="font-size:10px;color:#7a95b8">Plan: ${fmtNum(a.total_di,0)} DI</div></div><div style="font-size:20px;font-weight:700;color:${c};font-family:'DM Mono',monospace">${a_pct}%</div></div><div style="height:4px;background:#1e2d45;border-radius:2px"><div style="height:100%;width:${Math.min(a_pct,100)}%;background:${c};border-radius:2px"></div></div><div style="font-size:10px;color:#7a95b8;margin-top:3px;font-family:'DM Mono',monospace">${fmtNum(a.completed_di,0)} / ${fmtNum(a.total_di,0)} DI</div></div>`;
            }).join("");
        }

        if(weekly && weekly.length > 0) {
            const wkView = weekly.slice(0, 60);
            destroyChart("epScurveChart");
            const ctx = document.getElementById("epScurveChart")?.getContext("2d");
            if(ctx) {
                charts["epScurveChart"] = new Chart(ctx, {
                    type: "bar",
                    data: { labels: wkView.map(w=>w.week_label), datasets: [
                        { label:"Target DI", type:"line", data:wkView.map(w=>d_total_di), borderColor:"rgba(255,82,82,0.6)", borderDash:[5,5], borderWidth:1.5, fill:false, pointRadius:0, tension:0, order:1 },
                        { label:"Cumulative Actual", type:"line", data:wkView.map(w=>w.cumul_actual), borderColor:"#22d3a1", borderWidth:2, fill:false, pointRadius:0, tension:0.1, order:2 },
                        { label:"Actual Work DI", type:"bar", data:wkView.map(w=>w.completed_di>0?w.completed_di:null), backgroundColor:"rgba(37,99,235,0.6)", borderColor:"#2563eb", borderWidth:1, borderRadius:2, barPercentage:0.7, order:3, datalabels:{display:true,align:'top',anchor:'end',offset:2,color:'#2563eb',font:{size:9,weight:'600'},formatter:(v)=>v>0?fmtNum(v,0):''} }
                    ]},
                    options: { ...chartOpts("Cumulative DI (Lines) / Weekly DI (Bars)"),
                        scales: { ...chartOpts("").scales, x:{...chartOpts("").scales.x, ticks:{...chartOpts("").scales.x.ticks,maxRotation:0,autoSkip:false,callback:function(val,index){const label=this.getLabelForValue(val);const wkNum=parseInt(label.replace("W",""));if(wkNum===1||wkNum%5===0)return label;return "";}}}, y:{...chartOpts("").scales.y,beginAtZero:true} },
                        plugins:{...chartOpts("").plugins,legend:{display:true,position:'top',labels:{color:'#7a95b8',boxWidth:12,font:{size:10}}}}, animation:{duration:600} }
                });
            }
        }

    } catch(e) { console.error("EP Overview failed", e); }
}

// ================================================================================
//  SYSTEMS
// ================================================================================
async function loadSystems() {
    try {
        const dash = await getDashData(), data = dash.systems || [];
        if (!data.length) { document.getElementById("systemBars").innerHTML = '<div style="color:#7a95b8;padding:20px;text-align:center;font-size:12px">No systems data found</div>'; return; }
        
        document.getElementById("systemBars").innerHTML = data.map(s => {
            const p1 = s.total_di > 0 ? Math.round((s.completed_di / s.total_di) * 100) : 0;
            const p2 = s.support_total > 0 ? Math.round((s.support_comp / s.support_total) * 100) : 0;
            const p3 = s.testpkg_total > 0 ? Math.round((s.testpkg_comp / s.testpkg_total) * 100) : 0;
            
            const unified = Math.round((p1 * 0.7) + (p2 * 0.2) + (p3 * 0.1));
            const warn = (p3 > p1 || p3 > p2) ? `<span title="Test Pkg ahead of DI/Support" style="cursor:help">⚠️</span>` : "";

            return `<div class="prog-row" style="margin-bottom:15px; border-bottom:1px solid #f1f5f9; padding-bottom:12px;">
                <div class="prog-head">
                    <span class="prog-name" style="font-weight:700; color:#1e293b">${s.system} ${warn}</span>
                    <span style="font-size:12px; font-weight:bold; color:${pctColor(unified)}">Ready: ${unified}%</span>
                </div>
                <!-- Triple Bar -->
                <div class="triple-bar-container">
                    <div class="bar-group">
                        <div class="bar-label"><span>D/I Progress</span><span>${fmtNum(p1,1)}%</span></div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(p1,100)}%; background:${pctColor(p1)}"></div></div>
                    </div>
                    <div class="bar-group">
                        <div class="bar-label"><span>Support EA</span><span>${fmtNum(p2,1)}%</span></div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(p2,100)}%; background:${pctColor(p2)}"></div></div>
                    </div>
                    <div class="bar-group">
                        <div class="bar-label"><span>Test Package</span><span>${fmtNum(p3,1)}%</span></div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(p3,100)}%; background:${pctColor(p3)}"></div></div>
                    </div>
                </div>
            </div>`;
        }).join("");
    } catch(e) { console.error("Systems failed", e); }
}

// ================================================================================
//  SUB AREA
// ================================================================================
async function loadSubArea() {
    try {
        const dash = await getDashData(), data = dash.subareas || [];
        if (!data.length) { document.getElementById("subareaBars").innerHTML = '<div style="color:#7a95b8;padding:20px;text-align:center;font-size:12px">No sub_area data found</div>'; return; }
        
        document.getElementById("subareaBars").innerHTML = data.map(s => {
            const p1 = s.total_di > 0 ? Math.round((s.completed_di / s.total_di) * 100) : 0;
            const p2 = s.support_total > 0 ? Math.round((s.support_comp / s.support_total) * 100) : 0;
            const p3 = s.testpkg_total > 0 ? Math.round((s.testpkg_comp / s.testpkg_total) * 100) : 0;
            const unified = Math.round((p1 * 0.7) + (p2 * 0.2) + (p3 * 0.1));
            const warn = (p3 > p1 || p3 > p2) ? `<span title="Test Pkg ahead of DI/Support" style="color:#ffcc00">⚠️</span>` : "";

            return `<div class="prog-row" style="margin-bottom:15px; border-bottom:1px solid #f1f5f9; padding-bottom:12px;">
                <div class="prog-head">
                    <span class="prog-name" style="font-weight:700; color:#1e293b">${s.sub_area} ${warn}</span>
                    <span style="font-size:12px; font-weight:bold; color:${pctColor(unified)}">${unified}%</span>
                </div>
                <div class="triple-bar-container">
                    <div class="bar-group">
                        <div class="bar-label"><span>D/I Progress</span><span>${p1}%</span></div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(p1,100)}%; background:${pctColor(p1)}"></div></div>
                    </div>
                    <div class="bar-group">
                        <div class="bar-label"><span>Supports</span><span>${p2}%</span></div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(p2,100)}%; background:${pctColor(p2)}"></div></div>
                    </div>
                    <div class="bar-group">
                        <div class="bar-label"><span>Testing</span><span>${p3}%</span></div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(p3,100)}%; background:${pctColor(p3)}"></div></div>
                    </div>
                </div>
            </div>`;

        }).join("");
    } catch(e) { console.error("SubArea failed", e); }
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

        // ── KPI Cards: show all units/areas regardless of completion
        const allUnitsKpi = dash.units || [];
        document.getElementById("unitCards").innerHTML = allUnitsKpi.map(u => {
            const p=u.progress_pct, c=pctColor(p);
            return `<div class="unit-card"><div class="unit-card-name">Unit ${u.unit}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(u.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(u.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p}% complete</div><div class="unit-card-di">${u.total_joints.toLocaleString()} joints</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
        }).join("");

        const allAreasKpi = dash.areas || [];
        document.getElementById("areaCards").innerHTML = allAreasKpi.map(a => {
            const p=a.progress_pct, c=pctColor(p);
            return `<div class="unit-card" style="flex:1;"><div class="unit-card-name">Area: ${a.area}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(a.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(a.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p}% complete</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
        }).join("");

        // ── Unit Chart: Stacked (Completed DI + Remaining DI)
        const allUnits = dash.units || [];
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

        // ── Area Chart: Stacked horizontal (Completed DI + Remaining DI)
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
                            label: "Completed DI",
                            data: sortedAreas.map(a => a.completed_di || 0),
                            backgroundColor: "rgba(245,197,66,0.85)",
                            borderColor: "#f5c542",
                            borderWidth: 1, barPercentage: 0.6, stack: "s",
                            datalabels: { display: ctx => (sortedAreas[ctx.dataIndex]?.completed_di||0) > 0,
                                anchor: "end", align: "right", offset: 4,
                                color: "#fef08a", font: { size: 10, weight: "700", family: "DM Mono, monospace" },
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
          subarea=document.getElementById("jm-subarea")?.value||"", phase=document.getElementById("jm-phase")?.value||"", 
          offset=jmCurrentPage*JM_PAGE_SIZE;
    try {
        const params=new URLSearchParams({limit:JM_PAGE_SIZE,offset});
        if(unit)params.set("unit",unit); if(system)params.set("system",system); if(status)params.set("status",status);
        if(isoVal)params.set("iso",isoVal); if(subarea)params.set("sub_area",subarea); if(phase)params.set("phase",phase);
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
        toast(`✓ ${saved} joints saved (${isoVal}) — KPI updating...`);
        _autoRefreshKpi();
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
        toast(`✓ ${targets.length} joints cleared (${isoVal}) — KPI updating...`);
        _autoRefreshKpi();
        updateIsoBulkPanel(isoVal,jmData);
    }catch(e){toast(`✗ Bulk clear failed: ${e.message}`,"error");}
}

function jmPage(dir){jmCurrentPage=Math.max(0,jmCurrentPage+dir);loadJointMaster();}

function renderJMTable(rows){
    const tbody=document.getElementById("jmBody");
    tbody.innerHTML=rows.map(r=>{
        const dStr=r.date_completed?r.date_completed.substring(0,10):"";
        const wVal=r.welder||"";
        const phaseVal=r.phase||"";
        return `<tr id="jmrow-${r.id}"><td>${r.id}</td><td><input class="cell-input" id="phase-${r.id}" type="text" value="${phaseVal}" style="width:50px"></td><td>${r.unit||""}</td><td>${r.system||""}</td><td>${r.sub_area||""}</td><td>${r.iso_drawing||""}</td><td>${r.rev||""}</td><td>${r.spool_no||""}</td><td>${r.mat||""}</td><td>${r.size_inch||""}</td><td>${r.sf||""}</td><td>${r.joint_no||""}</td><td><input class="cell-input" id="welder-${r.id}" type="text" value="${wVal}" style="width:100px" title="Use comma for multiple welders"></td><td><input class="cell-input" id="date-${r.id}" type="text" value="${dStr}" placeholder="YY-MM-DD"></td><td style="white-space:nowrap"><button class="btn-save-row" onclick="saveJointDate(${r.id})">Save</button><button class="btn-clear-row" onclick="clearJointDate(${r.id})">Clear</button></td></tr>`;
    }).join("");
}


function openAddJointModal(){document.getElementById("addJointModal").style.display="flex";}
function closeAddJointModal(){document.getElementById("addJointModal").style.display="none";}

async function submitNewJoint(){
    const data={unit:document.getElementById("new-unit").value.trim(),system:document.getElementById("new-system").value.trim(),sub_area:document.getElementById("new-area").value.trim(),line_no:document.getElementById("new-line_no").value.trim(),iso_drawing:document.getElementById("new-iso").value.trim(),rev:document.getElementById("new-rev").value.trim(),spool_no:document.getElementById("new-spool").value.trim(),mat:document.getElementById("new-mat").value.trim(),size_inch:parseFloat(document.getElementById("new-size").value)||0,sf:document.getElementById("new-sf").value.trim(),joint_no:document.getElementById("new-joint_no").value.trim(),welder:document.getElementById("new-welder").value.trim(),phase:document.getElementById("new-phase").value.trim(),completed:false};
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
        toast(`✓ ID ${id} date cleared! KPI updating...`);
        _autoRefreshKpi();
    }catch(e){toast(`✗ Clear failed: ${e.message}`,"error");}
}

async function saveJointDate(id){
    let val=document.getElementById(`date-${id}`)?.value?.trim()||'';
    let welder=document.getElementById(`welder-${id}`)?.value?.trim()||'';
    let phase=document.getElementById(`phase-${id}`)?.value?.trim()||'';
    if(val){if(!/^\d{2,4}-\d{2}-\d{2}$/.test(val)){toast("Invalid date format (YY-MM-DD)","error");return;}if(val.length===8)val="20"+val;}
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:val||null, welder:welder||null, phase:phase||null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`✓ ID ${id} saved! KPI updating...`);
        _autoRefreshKpi();
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
                toast("✓ KPI updated");
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
    const exportData=jmData.map(r=>({
        "ID":r.id, "UNIT":r.unit||"", "SYSTEM":r.system||"", "AREA":r.area||"",
        "SUB AREA":r.sub_area||"", "LINE NO":r.line_no||"", "ISO DRAWING":r.iso_drawing||"",
        "REV":r.rev||"", "SPOOL NO":r.spool_no||"", "MAT":r.mat||"",
        "SIZE":r.size_inch||"", "S/F":r.sf||"", "JOINT NO":r.joint_no||"",
        "DI":r.di||"", "WELDER":r.welder||"", "PHASE":r.phase||"",
        "COMPLETED DATE":r.date_completed?r.date_completed.substring(0,10):"",
        "REMARK":r.remark||""
    }));
    const ws=XLSX.utils.json_to_sheet(exportData),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"JointMaster");
    const success=await downloadWithPicker(wb,"Joint_Master_Export.xlsx");if(success)toast("Exported to .xlsx successfully");
}

function printPage(pageId){
    const pages=document.querySelectorAll('.page');pages.forEach(p=>p.classList.remove('page-print-active'));
    const target=document.getElementById("page-"+pageId);if(target)target.classList.add('page-print-active');
    window.print();pages.forEach(p=>p.classList.remove('page-print-active'));
}

// ================================================================================
//  JOINT MASTER - TEMPLATE DOWNLOAD & EXCEL IMPORT
// ================================================================================
function downloadJMTemplate() {
    const headers = [
        "unit","system","area","sub_area","line_no","iso_drawing","rev",
        "spool_no","mat","size_inch","sf","joint_no","di","welder","phase",
        "date_completed","remark"
    ];
    const sample = [
        {unit:"B1",system:"CCP",area:"MB #1",sub_area:"PR#3",line_no:"L-001",iso_drawing:"ISO-001",
         rev:"0",spool_no:"",mat:"CS",size_inch:"4",sf:"F",joint_no:"J-001",di:"4",
         welder:"",phase:"Normal",date_completed:"",remark:""}
    ];
    const ws = XLSX.utils.json_to_sheet(sample, {header: headers});
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "JointMaster");
    XLSX.writeFile(wb, "Joint_Master_Template.xlsx");
    toast("✓ Template downloaded");
}

async function importJMExcel() {
    const fileInput = document.getElementById("jm-import-file");
    if (!fileInput || !fileInput.files.length) {
        toast("Please select an Excel file first", "error"); return;
    }
    const file = fileInput.files[0];
    const statusEl = document.getElementById("jm-import-status");
    if (statusEl) statusEl.textContent = "Uploading...";

    const formData = new FormData();
    formData.append("file", file);
    try {
        const res = await fetch("/api/joints/import", { method: "POST", body: formData });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        const msg = `✓ Imported ${data.inserted} rows${data.skipped > 0 ? ` (${data.skipped} skipped)` : ""}`;
        if (statusEl) statusEl.textContent = msg;
        toast(msg);
        fileInput.value = "";
        // Trigger KPI refresh
        _autoRefreshKpi();
        setTimeout(() => loadJointMaster(), 2000);
    } catch(e) {
        const msg = `✗ Import failed: ${e.message}`;
        if (statusEl) statusEl.textContent = msg;
        toast(msg, "error");
    }
}

// ================================================================================
//  WELDER PERFORMANCE  (Enhanced v2)
// ================================================================================
let _welderData = null;
let _selectedWelder = null;

async function loadWelder() {
    _selectedWelder = null;
    const dateFrom = document.getElementById("wd-from")?.value || "";
    const dateTo   = document.getElementById("wd-to")?.value   || "";
    const system   = document.getElementById("wd-system")?.value || "";
    const params   = new URLSearchParams();
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo)   params.set("date_to",   dateTo);
    if (system)   params.set("system",    system);

    try {
        const res = await fetch("/api/welder-summary?" + params);
        if (!res.ok) throw new Error("API error " + res.status);
        _welderData = await res.json();
        renderWelder(_welderData);
    } catch(e) {
        console.error("Welder load failed", e);
        document.getElementById("welderRankBody").innerHTML =
            `<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">${e.message}</td></tr>`;
    }
}

function renderWelder(data) {
    const s = data.stats;
    document.getElementById("welder-active").textContent       = s.active_welders;
    document.getElementById("welder-total-joints").textContent = s.total_joints.toLocaleString();
    document.getElementById("welder-total-di").textContent     = fmtNum(s.total_di, 0);
    document.getElementById("welder-avg-di").textContent       = fmtNum(s.avg_di, 1);

    // ── Ranking table ──
    const tbody = document.getElementById("welderRankBody");
    if (!data.ranking || data.ranking.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:20px">No data found. Enter completion dates in Joint Master.</td></tr>`;
    } else {
        const maxDI = data.ranking[0]?.total_di || 1;
        tbody.innerHTML = data.ranking.map((r, i) => {
            const barW = Math.max(2, Math.round((r.total_di / maxDI) * 100));
            const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}`;
            return `<tr style="cursor:pointer" onclick="drillWelder('${r.welder}')" title="Click for detail">
                <td style="font-weight:700;font-size:13px">${medal}</td>
                <td style="font-weight:600;color:var(--accent)">${r.welder}</td>
                <td>${r.joints}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:6px">
                    <div style="flex:1;background:rgba(0,200,255,0.1);border-radius:3px;height:6px">
                      <div style="width:${barW}%;background:var(--accent);height:6px;border-radius:3px"></div>
                    </div>
                    <span style="font-family:'DM Mono',monospace;font-size:12px;min-width:55px;text-align:right">${fmtNum(r.total_di,1)}</span>
                  </div>
                </td>
                <td style="font-size:11px;color:var(--text-dim)">${r.last_active || '-'}</td>
                <td><button class="btn-sm" onclick="event.stopPropagation();drillWelder('${r.welder}')" style="background:rgba(0,200,255,0.15);color:var(--accent);border:1px solid rgba(0,200,255,0.3);padding:2px 8px;border-radius:4px;font-size:10px;cursor:pointer">Detail ▸</button></td>
            </tr>`;
        }).join("");
    }

    // ── Overall daily trend chart ──
    destroyChart("welderTrendChart");
    if (data.trend && data.trend.length > 0) {
        charts["welderTrendChart"] = new Chart(
            document.getElementById("welderTrendChart").getContext("2d"), {
            type: "bar",
            data: {
                labels: data.trend.map(t => t.date),
                datasets: [{
                    label: "Daily Completed DI",
                    data: data.trend.map(t => t.di),
                    backgroundColor: "rgba(34,211,161,0.6)",
                    borderColor: "#22d3a1",
                    borderWidth: 1
                }]
            },
            options: {
                ...chartOpts("DI"),
                plugins: { ...chartOpts().plugins,
                    legend: { display: false },
                    datalabels: { display: false }
                }
            }
        });
    }

    // ── System breakdown chart ──
    destroyChart("welderSysChart");
    const sysEl = document.getElementById("welderSysChart");
    if (sysEl && data.system_breakdown && data.system_breakdown.length > 0) {
        const top10 = data.system_breakdown.slice(0, 10);
        charts["welderSysChart"] = new Chart(sysEl.getContext("2d"), {
            type: "bar",
            data: {
                labels: top10.map(s => s.system),
                datasets: [{
                    label: "Completed DI",
                    data: top10.map(s => s.total_di),
                    backgroundColor: "rgba(99,102,241,0.6)",
                    borderColor: "#6366f1",
                    borderWidth: 1
                }]
            },
            options: {
                indexAxis: "y",
                ...chartOpts("DI"),
                plugins: { legend: { display: false }, datalabels: { display: false } }
            }
        });
    }

    // Hide drill-down panel initially
    const drillPanel = document.getElementById("welder-drill-panel");
    if (drillPanel) drillPanel.style.display = "none";
}

function drillWelder(welderId) {
    if (!_welderData) return;
    _selectedWelder = welderId;
    const wInfo = _welderData.ranking.find(r => r.welder === welderId);
    if (!wInfo) return;

    const panel = document.getElementById("welder-drill-panel");
    if (!panel) return;
    panel.style.display = "block";

    document.getElementById("drill-welder-name").textContent = `👷 ${welderId}`;
    document.getElementById("drill-joints").textContent      = wInfo.joints;
    document.getElementById("drill-total-di").textContent    = fmtNum(wInfo.total_di, 1);
    document.getElementById("drill-last-active").textContent = wInfo.last_active || "-";

    // Per-welder daily trend
    destroyChart("drillDailyChart");
    const dEl = document.getElementById("drillDailyChart");
    if (dEl && wInfo.daily_list && wInfo.daily_list.length > 0) {
        charts["drillDailyChart"] = new Chart(dEl.getContext("2d"), {
            type: "bar",
            data: {
                labels: wInfo.daily_list.map(d => d.date),
                datasets: [{
                    label: "DI",
                    data: wInfo.daily_list.map(d => d.di),
                    backgroundColor: "rgba(0,200,255,0.5)",
                    borderColor: "#00c8ff",
                    borderWidth: 1
                }]
            },
            options: {
                ...chartOpts("DI"),
                plugins: { legend: { display: false }, datalabels: { display: false } }
            }
        });
    }

    // Per-welder system breakdown
    destroyChart("drillSysChart");
    const sEl = document.getElementById("drillSysChart");
    if (sEl && wInfo.system_list && wInfo.system_list.length > 0) {
        charts["drillSysChart"] = new Chart(sEl.getContext("2d"), {
            type: "doughnut",
            data: {
                labels: wInfo.system_list.map(s => s.system),
                datasets: [{
                    data: wInfo.system_list.map(s => s.di),
                    backgroundColor: [
                        "#00c8ff","#22d3a1","#f5c542","#ef4444","#6366f1",
                        "#ec4899","#14b8a6","#f97316","#8b5cf6","#a3e635"
                    ]
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: "#7a95b8", font: { size: 10 }, boxWidth: 10 } },
                    datalabels: {
                        display: true, color: "#fff", font: { size: 9 },
                        formatter: (v, ctx) => {
                            const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
                            return total > 0 ? (v/total*100).toFixed(0)+"%" : "";
                        }
                    }
                }
            }
        });
    }

    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function exportWelderExcel() {
    if (!_welderData || !_welderData.ranking.length) {
        toast("No welder data to export", "error"); return;
    }
    const rows = [];
    for (const r of _welderData.ranking) {
        rows.push({
            "Welder ID": r.welder,
            "Total Joints": r.joints,
            "Total DI": r.total_di,
            "Last Active": r.last_active
        });
    }
    const ws  = XLSX.utils.json_to_sheet(rows);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "WelderRanking");

    // Add daily trend sheet
    if (_welderData.trend.length) {
        const ws2 = XLSX.utils.json_to_sheet(_welderData.trend.map(t => ({"Date": t.date, "Completed DI": t.di})));
        XLSX.utils.book_append_sheet(wb, ws2, "DailyTrend");
    }
    const success = await downloadWithPicker(wb, "Welder_Performance.xlsx");
    if (success) toast("✓ Welder performance exported");
}

// ================================================================================
//  SUPPORT MASTER
// ================================================================================
let smData = [], smCurrentPage = 0;
const SM_PAGE = 100;

async function loadSupportMaster() {
    const system  = document.getElementById("sm-system")?.value  || "";
    const subarea = document.getElementById("sm-subarea")?.value || "";
    const status  = document.getElementById("sm-status")?.value  || "";
    const iso     = document.getElementById("sm-iso")?.value?.trim() || "";
    const offset  = smCurrentPage * SM_PAGE;
    try {
        const smSys = document.getElementById("sm-system");
        const smSub = document.getElementById("sm-subarea");
        if (smSys && smSys.options.length <= 1) (metaData.systems||[]).forEach(s => smSys.add(new Option(s,s)));
        if (smSub && smSub.options.length <= 1) (metaData.sub_areas||[]).forEach(s => smSub.add(new Option(s,s)));
        const params = new URLSearchParams({limit: SM_PAGE, offset});
        if (system)  params.set("system",   system);
        if (subarea) params.set("sub_area", subarea);
        if (status)  params.set("status",   status);
        if (iso)     params.set("iso",      iso);
        const res = await apiFetch(`/api/support-master?${params}`);
        smData = res.data;
        document.getElementById("sm-count").textContent = `${(res.count||0).toLocaleString()} rows (page ${smCurrentPage+1})`;
        document.getElementById("sm-page-info").textContent = `Page ${smCurrentPage+1}`;
        renderSMTable(smData);
    } catch(e) { console.error("Support Master load failed", e); }
}

function smPage(dir) { smCurrentPage = Math.max(0, smCurrentPage + dir); loadSupportMaster(); }

function renderSMTable(rows) {
    const tbody = document.getElementById("smBody");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-dim);padding:20px">No data. Add items or import from Excel template.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const dc = r.date_completed ? r.date_completed.substring(0,10) : "";
        return `<tr id="smrow-${r.id}">
          <td>${r.id}</td>
          <td>${r.system||""}</td>
          <td>${r.sub_area||""}</td>
          <td style="font-size:11px;font-family:'DM Mono',monospace">${r.iso_drawing||""}</td>
          <td style="font-weight:600;color:var(--accent)">${r.support_no||""}</td>
          <td><input class="cell-input" id="sm-date-${r.id}" type="text" value="${dc}" placeholder="YY-MM-DD" style="width:110px"></td>
          <td style="font-size:11px;color:var(--text-dim)">${r.remark||""}</td>
          <td style="white-space:nowrap">
            <button class="btn-save-row" onclick="saveSMDate(${r.id})">Save</button>
            <button class="btn-clear-row" onclick="deleteSMItem(${r.id})">Del</button>
          </td>
        </tr>`;
    }).join("");
}

async function saveSMDate(id) {
    let val = document.getElementById(`sm-date-${id}`)?.value?.trim() || "";
    if (val && !/^\d{2,4}-\d{2}-\d{2}$/.test(val)) { toast("Invalid date (YY-MM-DD)", "error"); return; }
    if (val && val.length === 8) val = "20" + val;
    try {
        const r = await fetch(`/api/support-master/${id}`, {
            method: "PATCH", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({date_completed: val||null, completed: !!val})
        });
        if (!r.ok) throw new Error("HTTP "+r.status);
        toast(`✓ Support #${id} saved`); fetch("/api/cache/clear");
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

async function deleteSMItem(id) {
    if (!confirm(`Delete Support ID ${id}?`)) return;
    try {
        const r = await fetch(`/api/support-master/${id}`, {method:"DELETE"});
        if (!r.ok) throw new Error("HTTP "+r.status);
        toast("✓ Deleted"); loadSupportMaster();
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

function openSMModal()  { document.getElementById("addSMModal").style.display = "flex"; }
function closeSMModal() { document.getElementById("addSMModal").style.display = "none"; }

async function submitSMItem() {
    const data = {
        system:      document.getElementById("sm-new-system").value.trim(),
        sub_area:    document.getElementById("sm-new-subarea").value.trim(),
        iso_drawing: document.getElementById("sm-new-iso").value.trim(),
        support_no:  document.getElementById("sm-new-support_no").value.trim(),
        remark:      document.getElementById("sm-new-remark").value.trim(),
        completed:   false
    };
    if (!data.system && !data.iso_drawing) { toast("System or ISO required", "error"); return; }
    try {
        const r = await fetch("/api/support-master", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data)});
        const d = await r.json(); if (!d.ok) throw new Error(d.error);
        toast("✓ Added"); closeSMModal(); loadSupportMaster();
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

function downloadSMTemplate() {
    const sample = [{system:"CCP", sub_area:"PR#3", iso_drawing:"ISO-001", support_no:"SP-001", completed:"", date_completed:"", remark:""}];
    const ws = XLSX.utils.json_to_sheet(sample); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SupportMaster");
    XLSX.writeFile(wb, "Support_Master_Template.xlsx"); toast("✓ Template downloaded");
}

async function importSMExcel() {
    const fi = document.getElementById("sm-import-file");
    if (!fi?.files.length) { toast("Select file first", "error"); return; }
    const st = document.getElementById("sm-import-status"); if (st) st.textContent = "Uploading...";
    const fd = new FormData(); fd.append("file", fi.files[0]);
    try {
        const res = await fetch("/api/support-master/import", {method:"POST", body:fd});
        const data = await res.json(); if (!data.ok) throw new Error(data.error);
        const msg = `✓ Imported ${data.inserted} rows${data.skipped>0?` (${data.skipped} skipped)`:""}`;
        if (st) st.textContent = msg; toast(msg); fi.value = "";
        fetch("/api/cache/clear"); loadSupportMaster();
    } catch(e) { const m=`✗ ${e.message}`; if(st) st.textContent=m; toast(m,"error"); }
}

async function exportSMExcel() {
    if (!smData?.length) { toast("No data", "error"); return; }
    const rows = smData.map(r => ({"ID":r.id,"System":r.system||"","Sub Area":r.sub_area||"","ISO Drawing":r.iso_drawing||"","Support No":r.support_no||"","Completed":r.completed?"Y":"N","Date Completed":r.date_completed?r.date_completed.substring(0,10):"","Remark":r.remark||""}));
    const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SupportMaster");
    const ok = await downloadWithPicker(wb, "Support_Master_Export.xlsx"); if (ok) toast("✓ Exported");
}

// ================================================================================
//  TEST PACKAGE MASTER
// ================================================================================
let tpData = [], tpCurrentPage = 0;
const TP_PAGE = 100;

async function loadTestPkgMaster() {
    const system  = document.getElementById("tp-system")?.value  || "";
    const subarea = document.getElementById("tp-subarea")?.value || "";
    const status  = document.getElementById("tp-status")?.value  || "";
    const offset  = tpCurrentPage * TP_PAGE;
    try {
        const tpSys = document.getElementById("tp-system");
        const tpSub = document.getElementById("tp-subarea");
        if (tpSys && tpSys.options.length <= 1) (metaData.systems||[]).forEach(s => tpSys.add(new Option(s,s)));
        if (tpSub && tpSub.options.length <= 1) (metaData.sub_areas||[]).forEach(s => tpSub.add(new Option(s,s)));
        const params = new URLSearchParams({limit: TP_PAGE, offset});
        if (system)  params.set("system",   system);
        if (subarea) params.set("sub_area", subarea);
        if (status)  params.set("status",   status);
        const res = await apiFetch(`/api/testpkg-master?${params}`);
        tpData = res.data;
        document.getElementById("tp-count").textContent = `${(res.count||0).toLocaleString()} rows (page ${tpCurrentPage+1})`;
        document.getElementById("tp-page-info").textContent = `Page ${tpCurrentPage+1}`;
        renderTPTable(tpData);
    } catch(e) { console.error("Test Pkg Master load failed", e); }
}

function tpPage(dir) { tpCurrentPage = Math.max(0, tpCurrentPage + dir); loadTestPkgMaster(); }

function renderTPTable(rows) {
    const tbody = document.getElementById("tpBody");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:20px">No data. Add items or import from Excel template.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const dc = r.date_completed ? r.date_completed.substring(0,10) : "";
        return `<tr id="tprow-${r.id}">
          <td>${r.id}</td>
          <td>${r.system||""}</td>
          <td>${r.sub_area||""}</td>
          <td style="font-weight:600;color:var(--indigo)">${r.test_pkg||""}</td>
          <td><input class="cell-input" id="tp-date-${r.id}" type="text" value="${dc}" placeholder="YY-MM-DD" style="width:110px"></td>
          <td style="font-size:11px;color:var(--text-dim)">${r.remark||""}</td>
          <td style="white-space:nowrap">
            <button class="btn-save-row" onclick="saveTPDate(${r.id})">Save</button>
            <button class="btn-clear-row" onclick="deleteTPItem(${r.id})">Del</button>
          </td>
        </tr>`;
    }).join("");
}

async function saveTPDate(id) {
    let val = document.getElementById(`tp-date-${id}`)?.value?.trim() || "";
    if (val && !/^\d{2,4}-\d{2}-\d{2}$/.test(val)) { toast("Invalid date (YY-MM-DD)", "error"); return; }
    if (val && val.length === 8) val = "20" + val;
    try {
        const r = await fetch(`/api/testpkg-master/${id}`, {
            method:"PATCH", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({date_completed: val||null, completed: !!val})
        });
        if (!r.ok) throw new Error("HTTP "+r.status);
        toast(`✓ Test Pkg #${id} saved`); fetch("/api/cache/clear");
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

async function deleteTPItem(id) {
    if (!confirm(`Delete Test Pkg ID ${id}?`)) return;
    try {
        const r = await fetch(`/api/testpkg-master/${id}`, {method:"DELETE"});
        if (!r.ok) throw new Error("HTTP "+r.status);
        toast("✓ Deleted"); loadTestPkgMaster();
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

function openTPModal()  { document.getElementById("addTPModal").style.display = "flex"; }
function closeTPModal() { document.getElementById("addTPModal").style.display = "none"; }

async function submitTPItem() {
    const data = {
        system:   document.getElementById("tp-new-system").value.trim(),
        sub_area: document.getElementById("tp-new-subarea").value.trim(),
        test_pkg: document.getElementById("tp-new-testpkg").value.trim(),
        remark:   document.getElementById("tp-new-remark").value.trim(),
        completed: false
    };
    if (!data.system && !data.test_pkg) { toast("System or Test Pkg No required", "error"); return; }
    try {
        const r = await fetch("/api/testpkg-master", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data)});
        const d = await r.json(); if (!d.ok) throw new Error(d.error);
        toast("✓ Test package added"); closeTPModal(); loadTestPkgMaster();
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

function downloadTPTemplate() {
    const sample = [{system:"CCP", sub_area:"PR#3", test_pkg:"TP-CCP-001", completed:"", date_completed:"", remark:""}];
    const ws = XLSX.utils.json_to_sheet(sample); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "TestPkgMaster");
    XLSX.writeFile(wb, "TestPkg_Master_Template.xlsx"); toast("✓ Template downloaded");
}

async function importTPExcel() {
    const fi = document.getElementById("tp-import-file");
    if (!fi?.files.length) { toast("Select file first", "error"); return; }
    const st = document.getElementById("tp-import-status"); if (st) st.textContent = "Uploading...";
    const fd = new FormData(); fd.append("file", fi.files[0]);
    try {
        const res = await fetch("/api/testpkg-master/import", {method:"POST", body:fd});
        const data = await res.json(); if (!data.ok) throw new Error(data.error);
        const msg = `✓ Imported ${data.inserted} rows${data.skipped>0?` (${data.skipped} skipped)`:""}`;
        if (st) st.textContent = msg; toast(msg); fi.value = "";
        fetch("/api/cache/clear"); loadTestPkgMaster();
    } catch(e) { const m=`✗ ${e.message}`; if(st) st.textContent=m; toast(m,"error"); }
}

async function exportTPExcel() {
    if (!tpData?.length) { toast("No data", "error"); return; }
    const rows = tpData.map(r => ({"ID":r.id,"System":r.system||"","Sub Area":r.sub_area||"","Test Pkg No":r.test_pkg||"","Completed":r.completed?"Y":"N","Date Completed":r.date_completed?r.date_completed.substring(0,10):"","Remark":r.remark||""}));
    const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "TestPkgMaster");
    const ok = await downloadWithPicker(wb, "TestPkg_Master_Export.xlsx"); if (ok) toast("✓ Exported");
}
