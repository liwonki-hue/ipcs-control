// dashboard.js Full frontend logic  v18.8

const API = "";  // Flask runs on same origin
let charts = {};
let jmData = [];
let jmCurrentPage = 0;
const JM_PAGE_SIZE = 50;
let weekData = [];
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
        // Load meta and dashboard data in parallel — saves 200-500ms vs sequential
        const [, data] = await Promise.all([loadMeta(), getDashData()]);
        renderKPI(data.kpi, data.weekly);
        renderOverview(data.kpi, data.weekly, data.units, data.systems);
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
    const subTxt = `${wd.stats?.active_welders || 0} welders · AVG DI/Day`;
    // Update both project KPI bar and EP KPI row
    ["kpi-welder-perf",  "ep-kpi-welder"]     .forEach(id => { const el=document.getElementById(id); if(el) el.textContent = avgTxt; });
    ["kpi-welder-sub",   "ep-kpi-welder-sub"]  .forEach(id => { const el=document.getElementById(id); if(el) el.textContent = subTxt; });
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
        
        // Hide KPI row for Data Input/Reports and EP page (EP has its own KPI row)
        const dataInputPages = ["joint_master", "support_master", "nde_pwht", "testpkg_master", "simulation", "welder"];
        const epKpiRow = document.getElementById("epKpiRow");
        if (kpiRow) {
            kpiRow.style.display = (dataInputPages.includes(page) || page === "early_power") ? "none" : "grid";
        }
        if (epKpiRow) {
            epKpiRow.style.display = page === "early_power" ? "grid" : "none";
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
        case "welder":      loadWelder();       break;
        case "support_master": loadSupportMaster(); break;
        case "nde_pwht":    loadNdePwht();      break;
        case "testpkg_master": loadTestPkgMaster(); break;
        case "simulation":  /* handled above */ break;
    }
}



// ================================================================================
//  API HELPERS
// ================================================================================
async function apiFetch(url) {
    const ts = new Date().getTime();
    const separator = url.includes("?") ? "&" : "?";
    const res = await fetch(API + url + separator + "_t=" + ts, { cache: "no-store" });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

function pctColor(v) {
    if (v >= 80) return "#22d3a1";
    if (v >= 50) return "#60a5fa";
    if (v > 0)   return "#2563eb";
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
        
        // Populate Joint Master filters
        const jmUnit = document.getElementById("jm-unit");
        const jmSys  = document.getElementById("jm-system");
        const jmSub  = document.getElementById("jm-subarea");
        if (jmUnit) { jmUnit.innerHTML = '<option value="">Unit</option>'; metaData.units.forEach(u => jmUnit.add(new Option(u, u))); }
        if (jmSys)  { jmSys.innerHTML = '<option value="">System</option>'; metaData.systems.forEach(s => jmSys.add(new Option(s, s))); }
        if (jmSub && metaData.sub_areas) {
            jmSub.innerHTML = '<option value="">Sub Area</option>';
            metaData.sub_areas.forEach(s => jmSub.add(new Option(s, s)));
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

        const ndeUnit = document.getElementById("nde-unit");
        const ndeSys  = document.getElementById("nde-system");
        if (ndeUnit) { ndeUnit.innerHTML = '<option value="">Unit</option>'; metaData.units.forEach(u => ndeUnit.add(new Option(u, u))); }
        if (ndeSys)  { ndeSys.innerHTML = '<option value="">System</option>'; metaData.systems.forEach(s => ndeSys.add(new Option(s, s))); }
    } catch(e) { console.error("Meta load failed", e); }
}

// ================================================================================
//  KPI RENDER
// ================================================================================
function renderKPI(d, wkData) {
    if (!d || !d.total_plan_di) return;
    document.getElementById("reportDate").textContent = d.report_date || "—";
    document.getElementById("kpi-overall").textContent     = `${d.overall_pct || 0}%`;
    document.getElementById("kpi-overall-sub").textContent = `${fmtNum(d.completed_di,0)} / ${fmtNum(d.total_plan_di,0)} DI · ${d.completed_joints?.toLocaleString() || "0"} joints`;
    document.getElementById("kpi-bar").style.width = `${Math.min(d.overall_pct || 0, 100)}%`;

    const totalEl    = document.getElementById("kpi-total-di");
    const totalSubEl = document.getElementById("kpi-total-di-sub");
    if (totalEl)    totalEl.textContent    = fmtNum(d.total_plan_di, 0);
    if (totalSubEl) totalSubEl.textContent = `${d.overall_pct || 0}% · ${d.total_joints?.toLocaleString() || "–"} joints`;

    const completedEl    = document.getElementById("kpi-completed");
    const completedSubEl = document.getElementById("kpi-completed-sub");
    if (completedEl)    completedEl.textContent    = fmtNum(d.completed_di, 0);
    if (completedSubEl) completedSubEl.textContent = `Fab ${fmtNum(d.fab_di,0)} · Erect ${fmtNum(d.erect_di,0)}`;
    document.getElementById("kpi-remain").textContent     = fmtNum(d.remaining_di, 0);
    document.getElementById("kpi-remain-sub").textContent = `${(100 - (d.overall_pct || 0)).toFixed(1)}% remaining`;

    const actWks = (wkData || []).filter(w => w.completed_di > 0);
    const kpiWeekVal = document.getElementById("kpi-week");
    const kpiWeekSub = document.getElementById("kpi-week-sub");
    if (actWks.length) {
        const lw  = actWks[actWks.length - 1];
        const card = document.getElementById("kpi-week-card");
        if (kpiWeekVal) {
            kpiWeekVal.textContent = fmtNum(lw.completed_di, 0);
            kpiWeekVal.style.color = "var(--accent)";
        }
        if (kpiWeekSub) {
            kpiWeekSub.textContent = `Current Week Progress (${lw.week_label})`;
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
    renderOverview(data.kpi, data.weekly, data.units, data.systems);
}

async function renderOverview(kpi, wkData, units, systems) {
    try {
        const d = kpi;
        const _mkStats = (rows) => rows.map(([l,v]) =>
            `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`).join("");
        const _fillGauge = (pathId, textId, p) => {
            const gp = document.getElementById(pathId), gt = document.getElementById(textId);
            if (!gp || !gt) return;
            gp.style.stroke = "#f97316"; gp.style.strokeDashoffset = Math.PI * 84 * (1 - Math.min(p/100,1));
            gt.textContent = `${p}%`; gt.style.fill = "#f97316";
        };

        // Piping Progress gauge
        _fillGauge("gaugePath", "gaugeText", d.overall_pct || 0);

        // Piping Progress stats
        const stats = document.getElementById("overviewStats");
        const _remDI = Math.max(0, (d.total_plan_di||0) - (d.completed_di||0));
        if (stats) stats.innerHTML = _mkStats([
            ["D/I Completion", `${d.overall_pct||0}%`],
            ["Total Plan DI",  fmtNum(d.total_plan_di,0)],
            ["Completed DI",   fmtNum(d.completed_di,0)],
            ["Remaining DI",   fmtNum(_remDI,0)]
        ]);

        // Support Progress gauge
        const sPct = d.support_pct || 0;
        _fillGauge("supportGaugePath", "supportGaugeText", sPct);
        const sStats = document.getElementById("supportStats");
        if (sStats) {
            const sRem = Math.max(0, (d.support_total||0) - (d.support_comp||0));
            sStats.innerHTML = _mkStats([
                ["Support Completion", `${sPct}%`],
                ["Total Support (EA)", fmtNum(d.support_total||0,0)],
                ["Completed (EA)",     fmtNum(d.support_comp||0,0)],
                ["Remaining (EA)",     fmtNum(sRem,0)]
            ]);
        }

        // Test Package Progress gauge
        const tPct = d.testpkg_pct || 0;
        _fillGauge("testpkgGaugePath", "testpkgGaugeText", tPct);
        const tStats = document.getElementById("testpkgStats");
        if (tStats) {
            const tRem = Math.max(0, (d.testpkg_total||0) - (d.testpkg_comp||0));
            tStats.innerHTML = _mkStats([
                ["Test Pkg Completion", `${tPct}%`],
                ["Total Test Pkg",      fmtNum(d.testpkg_total||0,0)],
                ["Completed",           fmtNum(d.testpkg_comp||0,0)],
                ["Remaining",           fmtNum(tRem,0)]
            ]);
        }

        // ── By System: split 23 systems across two tables ──────────────
        const sysList = (systems || []).slice().sort((a, b) => (b.progress_pct||0) - (a.progress_pct||0));
        const mid = Math.ceil(sysList.length / 2);
        const mkSysRows = arr => arr.map(s => {
            const p = s.progress_pct || 0, c = pctColor(p);
            const rem = Math.max(0, (s.total_di||s.plan_di||0) - (s.completed_di||0));
            return `<tr>
                <td style="text-align:left">${s.system||"—"}</td>
                <td style="text-align:right">${fmtNum(s.total_di||s.plan_di||0,0)}</td>
                <td style="text-align:right">${fmtNum(s.completed_di||0,0)}</td>
                <td style="text-align:right;color:var(--orange)">${fmtNum(rem,0)}</td>
                <td style="text-align:right;color:${c}">${p}%</td>
            </tr>`;
        }).join("");
        const sysThead = `<thead><tr><th style="text-align:left">System</th><th style="text-align:right">Plan DI</th><th style="text-align:right">Done DI</th><th style="text-align:right">Remaining</th><th>Progress</th></tr></thead>`;
        const t1 = document.getElementById("overviewSysTable1");
        const t2 = document.getElementById("overviewSysTable2");
        if (t1) t1.innerHTML = `<table class="data-table" style="width:100%">${sysThead}<tbody>${mkSysRows(sysList.slice(0,mid))}</tbody></table>`;
        if (t2) t2.innerHTML = `<table class="data-table" style="width:100%">${sysThead}<tbody>${mkSysRows(sysList.slice(mid))}</tbody></table>`;

        const indMap = {};
        const actWks = wkData.filter(w => w.completed_di > 0);
        actWks.forEach(w => { indMap[w.week_no] = w.completed_di; });

        destroyChart("scurveChart");
        const firstActIdx = wkData.findIndex(w => w.completed_di > 0);
        const lastActIdx  = wkData.reduce((last, w, i) => w.completed_di > 0 ? i : last, -1);
        const cumulLine   = wkData.map((w, i) => (firstActIdx >= 0 && i >= firstActIdx && i <= lastActIdx) ? w.cumul_actual : null);

        // Plan S-Curve: smooth theoretical S-shape (cubic smoothstep) over plan span
        const totalPlanDI = (kpi && kpi.total_plan_di) ? kpi.total_plan_di : 0;
        const pStart = 0;
        const pEnd   = wkData.length - 1;
        const pDur   = pEnd - pStart;
        const planSCurve = wkData.map((_, i) => {
            if (totalPlanDI <= 0 || pDur <= 0) return null;
            if (i < pStart || i > pEnd) return null;
            const t = (i - pStart) / pDur;
            return Math.round(totalPlanDI * (3*t*t - 2*t*t*t));  // cubic smoothstep S-curve
        });

        const scurveLabels = wkData.map((_, i) => `W${i + 1}`);
        charts["scurveChart"] = new Chart(document.getElementById("scurveChart").getContext("2d"), {
            type: "bar",
            data: { labels: scurveLabels, datasets: [
                { label:"Weekly DI",   type:"bar",  yAxisID:"yBar", data:wkData.map(w=>w.completed_di||null), backgroundColor:"rgba(37,99,235,0.5)", borderColor:"#2563eb", borderWidth:1, borderRadius:2, barPercentage:0.8, order:3, datalabels:{display:false} },
                { label:"Plan S-Curve",type:"line", yAxisID:"yCum", data:planSCurve, borderColor:"rgba(180,185,195,0.55)", borderWidth:2, borderDash:[6,4], fill:false, pointRadius:0, pointHoverRadius:4, tension:0, order:2, datalabels:{display:false} },
                { label:"Actual Cum.", type:"line", yAxisID:"yCum", data:cumulLine,  borderColor:"#2563eb", borderWidth:2, fill:false, pointRadius:0, pointHoverRadius:4, tension:0.3, order:1, spanGaps:false, datalabels:{display:false} }
            ]},
            options: { ...chartOpts("Weekly DI Progress"),
                scales: {
                    x:{ ...chartOpts("").scales.x, ticks:{...chartOpts("").scales.x.ticks,maxRotation:0,autoSkip:false,callback:function(val,index){if(index===0||index%5===4)return this.getLabelForValue(val);return "";}} },
                    yBar:{ type:"linear", position:"left",  beginAtZero:true, grid:{color:"rgba(255,255,255,0.05)"}, ticks:{color:"#4a6080",font:{size:9}}, title:{display:false} },
                    yCum:{ type:"linear", position:"right", beginAtZero:true, grid:{display:false}, ticks:{color:"#2563eb",font:{size:9}}, title:{display:false} }
                },
                plugins:{...chartOpts("").plugins,legend:{display:true,position:'top',labels:{color:'#7a95b8',boxWidth:12,font:{size:10}}}}, animation:{duration:600} }
        });

        let latestPlanIdx = -1;
        for (let i=wkData.length-1; i>=0; i--) { if (wkData[i].completed_di>0) { latestPlanIdx=i; break; } }
        let last4Wks = [];
        if (latestPlanIdx===-1) { last4Wks=wkData.slice(0,4); }
        else { let s=latestPlanIdx-3; if(s<0)s=0; last4Wks=wkData.slice(s,s+4); }

        destroyChart("weeklyBar");
        charts["weeklyBar"] = new Chart(document.getElementById("weeklyBar").getContext("2d"), {
            type:"bar",
            data:{labels:last4Wks.map(w=>w.week_label),datasets:[
                {label:"Actual Work",type:"line",data:last4Wks.map(w=>w.completed_di||null),borderColor:"#2563eb",borderWidth:2,fill:false,tension:0.3,order:0,datalabels:{display:true,align:'top',color:'#2563eb',font:{weight:'bold',size:10},offset:4,formatter:(v)=>v>0?fmtNum(v,1):''}},
                {label:"Weekly DI",data:last4Wks.map(w=>(w.completed_di>0)?w.completed_di:null),backgroundColor:"rgba(37,99,235,0.3)",borderColor:"rgba(37,99,235,0.6)",borderWidth:1,barPercentage:0.5,categoryPercentage:0.5,order:1}
            ]},
            options:{...chartOpts("Weekly Progress"),scales:{...chartOpts("DI").scales,y:{...chartOpts("DI").scales.y,beginAtZero:true}},plugins:{...chartOpts("DI").plugins,legend:{display:true,position:"top",labels:{boxWidth:12,font:{size:10},color:"#475569"}}}}
        });

        document.getElementById("unitOverview").innerHTML = units.map(u => {
            const p=u.progress_pct, c=pctColor(p);
            return `<div style="margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid var(--border)"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px"><div><div style="font-size:11px;font-weight:400">Unit ${u.unit}</div><div style="font-size:10px;color:var(--text-dim)">Plan: ${fmtNum(u.total_di,0)} DI</div></div><div style="font-size:13px;font-weight:400;color:${c};font-family:'DM Mono',monospace">${p}%</div></div><div style="height:3px;background:var(--border);border-radius:2px"><div style="height:100%;width:${Math.min(p,100)}%;background:${c};border-radius:2px"></div></div><div style="font-size:10px;color:var(--text-dim);margin-top:2px;font-family:'DM Mono',monospace">${fmtNum(u.completed_di,0)} / ${fmtNum(u.total_di,0)} DI</div></div>`;
        }).join("");
    } catch(e) { console.error("Overview failed", e); }
}

// ================================================================================
//  EARLY POWER OVERVIEW
// ================================================================================
async function loadEarlyPower() {
    const data = await getDashData();
    renderEarlyPower(data.ep_kpi ? data.ep_kpi[0] : null, data.ep_unit, data.ep_sys, data.ep_area, data.ep_weekly, data.kpi);
}

async function renderEarlyPower(d, _units, systems, areas, weekly, kpi) {
    if(!d) return;
    try {
        const d_total_di = d.total_di || 0;
        const d_completed_di = d.completed_di || 0;
        const pct = d_total_di > 0 ? Math.round((d_completed_di / d_total_di) * 100) : 0;

        // ── EP KPI Row (replaces global kpiRow on EP page) ────────────
        const support_pct  = kpi ? Math.round(kpi.support_pct  || 0) : 0;
        const testpkg_pct  = kpi ? Math.round(kpi.testpkg_pct  || 0) : 0;
        const support_comp = kpi ? (kpi.completed_supports || 0) : 0;
        const support_tot  = kpi ? (kpi.total_supports    || 0) : 0;
        const test_comp    = kpi ? (kpi.completed_testpkg  || 0) : 0;
        const test_tot     = kpi ? (kpi.total_testpkg      || 0) : 0;
        const readiness_pct = Math.round(pct * 0.7 + support_pct * 0.2 + testpkg_pct * 0.1);

        const _setKpi = (id, val) => { const el=document.getElementById(id); if(el) el.textContent=val; };
        const _setCol = (id, col) => { const el=document.getElementById(id); if(el) el.style.color=col; };

        _setKpi("ep-kpi-readiness", `${readiness_pct}%`);
        _setCol("ep-kpi-readiness", pctColor(readiness_pct));
        const rBar = document.getElementById("ep-kpi-readiness-bar");
        if(rBar) { rBar.style.width = `${Math.min(readiness_pct,100)}%`; rBar.style.background = pctColor(readiness_pct); }

        _setKpi("ep-kpi-piping", `${pct}%`);
        _setCol("ep-kpi-piping", pctColor(pct));
        _setKpi("ep-kpi-piping-sub", `${fmtNum(d_completed_di,0)} / ${fmtNum(d_total_di,0)} DI · ${(d.completed_joints||0).toLocaleString()} joints`);

        _setKpi("ep-kpi-support", `${support_pct}%`);
        _setCol("ep-kpi-support", pctColor(support_pct));
        _setKpi("ep-kpi-support-sub", support_tot > 0 ? `${fmtNum(support_comp,0)} / ${fmtNum(support_tot,0)}` : "—");

        _setKpi("ep-kpi-testpkg", `${testpkg_pct}%`);
        _setCol("ep-kpi-testpkg", pctColor(testpkg_pct));
        _setKpi("ep-kpi-testpkg-sub", test_tot > 0 ? `${fmtNum(test_comp,0)} / ${fmtNum(test_tot,0)}` : "—");

        // EP Week Actual = last week with EP completed DI (from ep_weekly)
        const actEpWks = (weekly || []).filter(w => w.completed_di > 0);
        const lastEpWk = actEpWks.length ? actEpWks[actEpWks.length - 1] : null;
        if(lastEpWk) {
            _setKpi("ep-kpi-week",     fmtNum(lastEpWk.completed_di, 0));
            _setKpi("ep-kpi-week-sub", `W${lastEpWk.week_no} · EP Piping D/I`);
        }
        // Avg Welder Performance is kept in sync by _updateWelderKpiBar (runs on startup + loadWelder)
        if(_welderData) _updateWelderKpiBar(_welderData);

        // ── Gauge ─────────────────────────────────────────────────────
        const r = 84, circ = Math.PI * r;
        const offset = circ * (1 - Math.min(pct/100,1));
        const gc = pct>=80?"#22d3a1":pct>=50?"#f5c542":"#ff8c42";
        const gp = document.getElementById("epGaugePath");
        if(gp) { gp.style.stroke = gc; gp.style.strokeDashoffset = offset; }
        const gt = document.getElementById("epGaugeText");
        if(gt) { gt.textContent = `${pct}%`; gt.style.fill = gc; }

        const stats = document.getElementById("epStats");
        if(stats) {
            stats.innerHTML = [
                ["EP PIPING",       `${fmtNum(d_completed_di,0)} / ${fmtNum(d_total_di,0)}`],
                ["EP Support",      `${fmtNum(support_comp,0)} / ${fmtNum(support_tot,0)}`],
                ["EP Test Package", `${fmtNum(test_comp,0)} / ${fmtNum(test_tot,0)}`]
            ].map(([l,v]) => `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`).join("");
        }

        // ── Progress tables ────────────────────────────────────────────
        // allForTotal: optional, provides the full row set for the aggregate row
        function _epTableRows(rows, nameKey, showTotal, allForTotal) {
            const totRows = allForTotal || rows;
            let sumT=0, sumC=0;
            totRows.forEach(r => { sumT += r.total_di||0; sumC += r.completed_di||0; });
            const td = "padding:3px 5px;font-size:11px";
            const rowHtml = rows.map(row => {
                const tot=row.total_di||0, comp=row.completed_di||0, rem=tot-comp;
                const p=tot>0?Math.round(comp/tot*100):0, c=pctColor(p);
                return `<tr>
                    <td style="${td};text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0">${row[nameKey]||""}</td>
                    <td style="${td}">${fmtNum(tot,0)}</td>
                    <td style="${td};color:var(--green)">${fmtNum(comp,0)}</td>
                    <td style="${td};color:${rem>0?"var(--orange)":"var(--green)"}">${fmtNum(rem,0)}</td>
                    <td style="${td};color:${c}">${p}%</td>
                </tr>`;
            }).join("");
            if(!showTotal) return rowHtml;
            const totRem = sumT-sumC, totP = sumT>0?Math.round(sumC/sumT*100):0, totC=pctColor(totP);
            return rowHtml + `<tr style="background:rgba(37,99,235,0.07);border-top:2px solid var(--border);font-weight:700">
                <td style="${td};text-align:left;color:var(--accent)">TOTAL</td>
                <td style="${td}">${fmtNum(sumT,0)}</td>
                <td style="${td};color:var(--green)">${fmtNum(sumC,0)}</td>
                <td style="${td};color:${totRem>0?"var(--orange)":"var(--green)"}">${fmtNum(totRem,0)}</td>
                <td style="${td};color:${totC}">${totP}%</td>
            </tr>`;
        }

        const sysTb = document.getElementById("epSysTableBody");
        if(sysTb && systems) sysTb.innerHTML = _epTableRows(systems, "system", true);

        // Split sub areas evenly; TOTAL in col 2 uses ALL areas for correct aggregate
        if(areas && areas.length) {
            const mid = Math.ceil(areas.length / 2);
            const areaTb  = document.getElementById("epAreaTableBody");
            const areaTb2 = document.getElementById("epAreaTableBody2");
            if(areaTb)  areaTb.innerHTML  = _epTableRows(areas.slice(0, mid), "sub_area", false);
            if(areaTb2) areaTb2.innerHTML = _epTableRows(areas.slice(mid),    "sub_area", true, areas);
        }

        if(weekly && weekly.length > 0) {
            // EP Target = week 40 (2026-12-30). Show all weeks 1-40 on x-axis.
            const EP_TARGET_WK = 40;
            const wkView = weekly.slice(0, EP_TARGET_WK); // weeks 1..40
            const lastEpActIdx = wkView.reduce((last, w, i) => w.completed_di > 0 ? i : last, -1);
            // Cumulative actual: show up to last active week, null after
            const cumulData = wkView.map((w, i) => i <= lastEpActIdx ? w.cumul_actual : null);
            destroyChart("epScurveChart");
            const ctx = document.getElementById("epScurveChart")?.getContext("2d");
            if(ctx) {
                charts["epScurveChart"] = new Chart(ctx, {
                    type: "bar",
                    data: { labels: wkView.map(w=>`W${w.week_no}`), datasets: [
                        { label:"EP Target DI",    type:"line", yAxisID:"yL", data:wkView.map(()=>d_total_di), borderColor:"rgba(255,82,82,0.55)", borderDash:[4,4], borderWidth:1.5, fill:false, pointRadius:0, tension:0, order:1, datalabels:{display:false} },
                        { label:"Cumulative Actual",type:"line", yAxisID:"yL", data:cumulData, borderColor:"#22d3a1", borderWidth:2, fill:false, pointRadius:3, pointBackgroundColor:"#22d3a1", pointHoverRadius:5, tension:0.1, order:2, spanGaps:false, datalabels:{display:false} },
                        { label:"Weekly DI",       type:"bar",  yAxisID:"yR", data:wkView.map(w=>w.completed_di>0?w.completed_di:null), backgroundColor:"rgba(37,99,235,0.5)", borderColor:"rgba(37,99,235,0.8)", borderWidth:1, borderRadius:2, barPercentage:0.8, categoryPercentage:0.9, order:3,
                          datalabels:{display:true, align:"end", anchor:"end", offset:2, clamp:false, color:"#5b8def", font:{size:8,weight:"600"}, formatter:(v)=>v?fmtNum(v,0):""} }
                    ]},
                    options: { ...chartOpts(""),
                        scales: {
                            x:{...chartOpts("").scales.x, ticks:{...chartOpts("").scales.x.ticks, maxRotation:0, autoSkip:false,
                                callback:function(_val,idx){ const wn=idx+1; return (wn===1||wn%5===0)?`W${wn}`:""; }}},
                            yL:{type:"linear", position:"left",  beginAtZero:true, grid:{color:"rgba(255,255,255,0.05)"}, ticks:{color:"#4a6080",font:{size:9}}, title:{display:true,text:"Cumulative DI",color:"#4a6080",font:{size:9}}},
                            yR:{type:"linear", position:"right", beginAtZero:true, grid:{display:false}, ticks:{color:"#5b8def",font:{size:9}}, title:{display:true,text:"Weekly DI",color:"#5b8def",font:{size:9}}}
                        },
                        layout:{padding:{top:18}},
                        plugins:{...chartOpts("").plugins,
                            legend:{display:true,position:'top',labels:{color:'#7a95b8',boxWidth:10,padding:8,font:{size:10}}},
                            tooltip:{...chartOpts("").plugins?.tooltip, callbacks:{label:(ctx)=>`${ctx.dataset.label}: ${fmtNum(ctx.parsed.y,0)}`}}},
                        animation:{duration:400} }
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

        // Sort by unified_readiness (D/I 70% + Support 20% + Test 10%) descending
        const sorted = [...data].sort((a, b) => (b.unified_readiness || 0) - (a.unified_readiness || 0));

        document.getElementById("systemBars").innerHTML = sorted.map(s => {
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

        // Sort by unified_readiness descending (highest progress first)
        const sortedSub = [...data].sort((a, b) => (b.unified_readiness || 0) - (a.unified_readiness || 0));

        document.getElementById("subareaBars").innerHTML = sortedSub.map(s => {
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
        const actWks=data.filter(w=>w.completed_di>0);
        const displayWks=actWks.slice(-5);
        destroyChart("weeklyTrend");
        charts["weeklyTrend"]=new Chart(document.getElementById("weeklyTrend").getContext("2d"),{
            type:"line",
            data:{labels:displayWks.map(w=>w.week_label),datasets:[
                {label:"Actual DI",data:displayWks.map(w=>w.completed_di),borderColor:"#2563eb",borderWidth:2.5,pointRadius:6,pointBackgroundColor:"#22d3a1",pointBorderColor:"#fff",pointBorderWidth:2,tension:0.2,datalabels:{display:true,align:"top",offset:5,color:"#60a5fa",font:{size:10,weight:"700",family:"DM Mono, monospace"},formatter:v=>v>0?fmtNum(v,0):""}}
            ]},
            options:{...chartOpts("DI"),plugins:{...chartOpts("DI").plugins,legend:{display:false}}}
        });

        const tbody=document.querySelector("#weeklyTable tbody");
        let totalFab=0, totalErect=0, totalComp=0;
        actWks.forEach(w=>{ totalFab+=w.fab_di||0; totalErect+=w.erect_di||0; totalComp+=w.completed_di||0; });
        let html=displayWks.map(w=>{
            const comp=w.completed_di||0, fab=w.fab_di||0, erect=w.erect_di||0;
            const dateStr = w.week_start && w.week_end ? `${w.week_start.slice(5)} ~ ${w.week_end.slice(5)}` : (w.week_start ? w.week_start.slice(5) : "");
            return `<tr>
                <td style="color:var(--accent)">${w.week_label}</td>
                <td style="font-size:11px;color:var(--text-dim)">${dateStr}</td>
                <td>${fmtNum(fab,0)}</td>
                <td>${fmtNum(erect,0)}</td>
                <td>${fmtNum(comp,0)}</td>
            </tr>`;
        }).join("");
        html+=`<tr style="background:rgba(37,99,235,0.05);border-top:1px solid var(--border)">
            <td style="color:var(--accent)">Total</td><td></td>
            <td>${fmtNum(totalFab,0)}</td>
            <td>${fmtNum(totalErect,0)}</td>
            <td>${fmtNum(totalComp,0)}</td>
        </tr>`;
        tbody.innerHTML=html;

        // Breakdown panels — 5분 클라이언트 캐시로 반복 요청 방지
        try {
            const _now = Date.now();
            if (!loadWeekly._bdCache || (_now - loadWeekly._bdCacheTime > 300000)) {
                loadWeekly._bdCache = await fetch("/api/weekly-last-breakdown").then(r=>r.json());
                loadWeekly._bdCacheTime = _now;
            }
            const bd = loadWeekly._bdCache;
            const weekLabel = bd.week_label || "";
            const dateRange = bd.week_start && bd.week_end ? `${bd.week_start.slice(5)} ~ ${bd.week_end.slice(5)}` : "";
            document.getElementById("weeklySystemTitle").textContent  = `${weekLabel} Breakdown — By System`;
            document.getElementById("weeklyMaterialTitle").textContent = `${weekLabel} Breakdown — By Material`;
            document.getElementById("weeklySubareaTitle").textContent = `${weekLabel} Breakdown — By Sub Area`;
            const mkTotalRow = arr => {
                const sf=arr.reduce((s,r)=>s+(r.fab_di||0),0);
                const se=arr.reduce((s,r)=>s+(r.erect_di||0),0);
                const sc=arr.reduce((s,r)=>s+(r.completed_di||0),0);
                const bld="font-weight:700";
                return `<tr style="background:rgba(37,99,235,0.07);border-top:2px solid var(--border)">
                    <td style="${bld};color:var(--accent)">Total</td>
                    <td style="${bld};font-size:11px;color:var(--text-dim)">${dateRange}</td>
                    <td style="${bld}">${fmtNum(sf,1)}</td>
                    <td style="${bld}">${fmtNum(se,1)}</td>
                    <td style="${bld};color:var(--accent)">${fmtNum(sc,1)}</td>
                </tr>`;
            };
            const mkSysRows = arr => arr.map(r=>`<tr>
                <td>${r.system||r.mat||r.name||""}</td>
                <td style="font-size:11px;color:var(--text-dim)">${dateRange}</td>
                <td>${fmtNum(r.fab_di||0,1)}</td>
                <td>${fmtNum(r.erect_di||0,1)}</td>
                <td style="color:var(--accent)">${fmtNum(r.completed_di||0,1)}</td>
            </tr>`).join("") + mkTotalRow(arr);
            const mkSubRows = (arr, showTotal=false, totalArr=null) => arr.map(r=>`<tr>
                <td>${r.sub_area||r.name||""}</td>
                <td style="font-size:11px;color:var(--text-dim)">${dateRange}</td>
                <td>${fmtNum(r.fab_di||0,1)}</td>
                <td>${fmtNum(r.erect_di||0,1)}</td>
                <td style="color:var(--accent)">${fmtNum(r.completed_di||0,1)}</td>
            </tr>`).join("") + (showTotal ? mkTotalRow(totalArr||arr) : "");
            document.querySelector("#weeklySystemTable tbody").innerHTML = mkSysRows(bd.systems||[]);
            if(document.querySelector("#weeklyMaterialTable tbody")) {
                document.querySelector("#weeklyMaterialTable tbody").innerHTML = mkSysRows(bd.materials||[]);
            }
            const allSubs = bd.subareas || [];
            const mid = Math.ceil(allSubs.length / 2);
            document.querySelector("#weeklySubareaTable tbody").innerHTML  = mkSubRows(allSubs.slice(0, mid), false);
            document.querySelector("#weeklySubareaTable2 tbody").innerHTML = mkSubRows(allSubs.slice(mid), true, allSubs);
            const title2El = document.getElementById("weeklySubareaTitle2");
            if (title2El) title2El.textContent = `${weekLabel} Breakdown — By Sub Area (2)`;
        } catch(e2) { console.warn("Breakdown fetch failed", e2); }

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
            return `<div class="unit-card"><div class="unit-card-name">Unit ${u.unit}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(u.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(u.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p}% complete</div><div class="unit-card-di">${(u.total_joints||0).toLocaleString()} joints</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
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
                            color: "#fb923c", font: { size: 10, weight: "700", family: "DM Mono, monospace" },
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
                            backgroundColor: "rgba(37,99,235,0.85)",
                            borderColor: "#2563eb",
                            borderWidth: 1, barPercentage: 0.6, stack: "s",
                            datalabels: { display: ctx => (sortedAreas[ctx.dataIndex]?.completed_di||0) > 0,
                                anchor: "end", align: "right", offset: 4,
                                color: "#fb923c", font: { size: 10, weight: "700", family: "DM Mono, monospace" },
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
          insp=document.getElementById("jm-inspection")?.value||"", offset=jmCurrentPage*JM_PAGE_SIZE;
    try {
        const params=new URLSearchParams({limit:JM_PAGE_SIZE,offset});
        if(unit)params.set("unit",unit); if(system)params.set("system",system); if(status)params.set("status",status);
        if(isoVal)params.set("iso",isoVal); if(subarea)params.set("sub_area",subarea); if(phase)params.set("phase",phase);
        if(insp)params.set("inspection",insp);
        const res=await apiFetch(`/api/joints?${params}`);
        jmData=res.data;
        document.getElementById("jm-count").textContent=`${res.count.toLocaleString()} rows loaded (page ${jmCurrentPage+1})`;
        document.getElementById("jm-page-info").textContent=`Page ${jmCurrentPage+1}`;
        
        // Update navigation buttons
        const prevBtn = document.getElementById("jm-prev-btn");
        const nextBtn = document.getElementById("jm-next-btn");
        if (prevBtn) prevBtn.disabled = (jmCurrentPage === 0);
        if (nextBtn) nextBtn.disabled = (res.data.length < JM_PAGE_SIZE);

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
        const pkgVal=r.package||"";
        return `<tr id="jmrow-${r.id}">
            <td style="display:none">${r.id}</td>
            <td><input class="cell-input" id="phase-${r.id}" type="text" value="${phaseVal}" style="text-align:center;padding:2px 3px"></td>
            <td><input class="cell-input" id="pkg-${r.id}" type="text" value="${pkgVal}" style="text-align:center;padding:2px 3px"></td>
            <td style="text-align:center">${r.system||""}</td>
            <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.sub_area||""}</td>
            <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.iso_drawing||""}">${r.iso_drawing||""}</td>
            <td style="text-align:center">${r.rev||""}</td>
            <td>${r.mat||""}</td>
            <td style="text-align:center">${r.size_inch||""}</td>
            <td style="text-align:center">${r.sf||""}</td>
            <td style="text-align:center">${r.joint_no||""}</td>
            <td><input class="cell-input" id="welder-${r.id}" type="text" value="${wVal}" title="${wVal}" style="width:100%;overflow:hidden;text-overflow:ellipsis"></td>
            <td><input class="cell-input" id="date-${r.id}" type="text" value="${dStr}" placeholder="YY-MM-DD"></td>
            <td>
                <select class="cell-input" id="inspection-${r.id}" style="text-align:center;text-align-last:center;padding:2px 2px">
                    <option value="">-</option>
                    <option value="VT" ${r.inspection==='VT'?'selected':''}>VT</option>
                    <option value="MT" ${r.inspection==='MT'?'selected':''}>MT</option>
                    <option value="PT" ${r.inspection==='PT'?'selected':''}>PT</option>
                    <option value="RT" ${r.inspection==='RT'?'selected':''}>RT</option>
                </select>
            </td>
            <td>
                <select class="cell-input" id="pwht-${r.id}" style="text-align:center;text-align-last:center;padding:2px 2px">
                    <option value="">-</option>
                    <option value="Y" ${r.pwht==='Y'?'selected':''}>Y</option>
                    <option value="N" ${r.pwht==='N'?'selected':''}>N</option>
                </select>
            </td>
            <td style="white-space:nowrap">
                <button class="btn-save-row" onclick="saveJointDate(${r.id})">Save</button>
                <button class="btn-clear-row" onclick="clearJointDate(${r.id})">Clear</button>
                <button class="btn-del-row" onclick="deleteJoint(${r.id})" title="Delete">DEL</button>
            </td>
        </tr>`;
    }).join("");
}


function openAddJointModal(){document.getElementById("addJointModal").style.display="flex";}
function closeAddJointModal(){document.getElementById("addJointModal").style.display="none";}

// ================================================================================
//  NDE & PWHT
// ================================================================================
let ndeCurrentPage=0;
const NDE_PAGE_SIZE=50;
let ndeData=[];

async function loadNdePwht() {
    const unit=document.getElementById("nde-unit")?.value||"", system=document.getElementById("nde-system")?.value||"";
    const isoVal=document.getElementById("nde-iso")?.value?.trim()||"";
    const offset=ndeCurrentPage*NDE_PAGE_SIZE;
    try {
        const params=new URLSearchParams({limit:NDE_PAGE_SIZE,offset,nde_only:"true"});
        if(unit)params.set("unit",unit); if(system)params.set("system",system);
        if(isoVal)params.set("iso",isoVal);
        const res=await apiFetch(`/api/joints?${params}`);
        ndeData=res.data;
        document.getElementById("nde-count").textContent=`${res.count.toLocaleString()} rows loaded (page ${ndeCurrentPage+1})`;
        document.getElementById("nde-page-info").textContent=`Page ${ndeCurrentPage+1}`;
        
        const prevBtn = document.getElementById("nde-prev-btn");
        const nextBtn = document.getElementById("nde-next-btn");
        if (prevBtn) prevBtn.disabled = (ndeCurrentPage === 0);
        if (nextBtn) nextBtn.disabled = (res.data.length < NDE_PAGE_SIZE);

        renderNdeTable(ndeData);
    } catch(e) { console.error("NDE load failed",e); }
}

function ndePage(dir){ndeCurrentPage=Math.max(0,ndeCurrentPage+dir);loadNdePwht();}

function renderNdeTable(rows){
    const tbody=document.getElementById("ndeBody");
    tbody.innerHTML=rows.map(r=>{
        const pt_date = r.pt_date ? r.pt_date.substring(0,10) : "";
        const mt_date = r.mt_date ? r.mt_date.substring(0,10) : "";
        const rt_date = r.rt_date ? r.rt_date.substring(0,10) : "";
        const pwht_date = r.pwht_date ? r.pwht_date.substring(0,10) : "";
        
        return `<tr id="nderow-${r.id}">
            <td title="${r.iso_drawing||""}">${r.iso_drawing||""}</td>
            <td>${r.rev||""}</td>
            <td>${r.joint_no||""}</td>
            <td>${r.welder||""}</td>
            <td style="font-weight:700;color:var(--accent)">${r.inspection||""}</td>
            
            <td style="border-right:none; padding-right:2px;"><input type="text" class="cell-input" id="nde-pt-date-${r.id}" value="${pt_date}" placeholder="YY-MM-DD" style="width:100%"></td>
            <td style="border-left:none; padding-left:2px;">
                <select class="cell-input" id="nde-pt-res-${r.id}" style="width:100%; text-align-last:center;">
                    <option value="">-</option>
                    <option value="PASS" ${r.pt_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.pt_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            
            <td style="border-right:none; padding-right:2px;"><input type="text" class="cell-input" id="nde-mt-date-${r.id}" value="${mt_date}" placeholder="YY-MM-DD" style="width:100%"></td>
            <td style="border-left:none; padding-left:2px;">
                <select class="cell-input" id="nde-mt-res-${r.id}" style="width:100%; text-align-last:center;">
                    <option value="">-</option>
                    <option value="PASS" ${r.mt_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.mt_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            
            <td style="border-right:none; padding-right:2px;"><input type="text" class="cell-input" id="nde-rt-date-${r.id}" value="${rt_date}" placeholder="YY-MM-DD" style="width:100%"></td>
            <td style="border-left:none; padding-left:2px;">
                <select class="cell-input" id="nde-rt-res-${r.id}" style="width:100%; text-align-last:center;">
                    <option value="">-</option>
                    <option value="PASS" ${r.rt_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.rt_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            
            <td style="border-right:none; padding-right:2px;"><input type="text" class="cell-input" id="nde-pwht-date-${r.id}" value="${pwht_date}" placeholder="YY-MM-DD" style="width:100%"></td>
            <td style="border-left:none; padding-left:2px;">
                <select class="cell-input" id="nde-pwht-res-${r.id}" style="width:100%; text-align-last:center;">
                    <option value="">-</option>
                    <option value="PASS" ${r.pwht_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.pwht_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            <td>
                <button class="btn-save-row" onclick="saveNdeRow(${r.id})">Save</button>
            </td>
        </tr>`;
    }).join("");
}

async function saveNdeRow(id){
    const data = {
        pt_date: document.getElementById(`nde-pt-date-${id}`).value.trim() || null,
        pt_result: document.getElementById(`nde-pt-res-${id}`).value,
        mt_date: document.getElementById(`nde-mt-date-${id}`).value.trim() || null,
        mt_result: document.getElementById(`nde-mt-res-${id}`).value,
        rt_date: document.getElementById(`nde-rt-date-${id}`).value.trim() || null,
        rt_result: document.getElementById(`nde-rt-res-${id}`).value,
        pwht_date: document.getElementById(`nde-pwht-date-${id}`).value.trim() || null,
        pwht_result: document.getElementById(`nde-pwht-res-${id}`).value
    };
    
    // Date normalization
    ['pt_date', 'mt_date', 'rt_date', 'pwht_date'].forEach(k => {
        if(data[k] && data[k].length === 8) data[k] = "20" + data[k];
    });

    try{
        const r = await fetch(`${API}/api/joints/${id}`, {
            method: "PATCH",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify(data)
        });
        if(!r.ok) throw new Error('HTTP ' + r.status);
        toast("✓ NDE data saved!");
    }catch(e){ toast("✗ Save failed: " + e.message, "error"); }
}

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
        await fetch("/api/cache/clear").catch(()=>{});
        toast(`✓ Joint ID ${id} deleted`);
        loadJointMaster();
        loadNdePwht(); // Sync NDE tab
    }catch(e){toast("✗ Failed to delete","error");}
}

async function clearJointDate(id){
    const el=document.getElementById(`date-${id}`);if(el)el.value='';
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        // cache/clear 제거: 단순 날짜 삭제는 백그라운드 캐시가 자연 만료되도록 둠
        toast(`✓ ID ${id} date cleared!`);
        _dashData = null; // 메모리 내 캐시만 무효화
        _autoRefreshKpi();
    }catch(e){toast(`✗ Clear failed: ${e.message}`,"error");}
}

async function saveJointDate(id){
    let val=document.getElementById(`date-${id}`)?.value?.trim()||'';
    let welder=document.getElementById(`welder-${id}`)?.value?.trim()||'';
    let phase=document.getElementById(`phase-${id}`)?.value?.trim()||'';
    let pkg=document.getElementById(`pkg-${id}`)?.value?.trim()||'';
    let inspection=document.getElementById(`inspection-${id}`)?.value?.trim()||'';
    let pwht=document.getElementById(`pwht-${id}`)?.value?.trim()||'';
    if(val){if(!/^\d{2,4}-\d{2}-\d{2}$/.test(val)){toast("Invalid date format (YY-MM-DD)","error");return;}if(val.length===8)val="20"+val;}
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:val||null, welder:welder||null, phase:phase||null, package:pkg||null, inspection:inspection||null, pwht:pwht||null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        // cache/clear + loadNdePwht() 제거: 행 1개 저장 시마다 전체 재빌드는 과도한 부하
        // _dashData null 처리만으로 다음 navigate 시 자동 갱신됨
        _dashData = null;
        toast(`✓ ID ${id} saved!`);
        _autoRefreshKpi();
    }catch(e){toast(`✗ Save failed: ${e.message}`,"error");}
}

async function refreshWeeklySummary(){
    try{
        await fetch("/api/cache/clear").catch(()=>{});_dashData=null;
        const fresh=await getDashData(true);if(!fresh)return;
        weekData=fresh.weekly||[];
        renderKPI(fresh.kpi,fresh.weekly);
        const visPage=document.querySelector(".page:not(.hidden)")?.id?.replace("page-","");
        if(visPage==="overview")renderOverview(fresh.kpi,fresh.weekly,fresh.units,fresh.systems);
    }catch(e){console.warn("Weekly summary refresh failed:",e);}
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
// polling 횟수를 20→8회로 줄여 서버 부하 감소 (캐시 TTL=1200초이므로 충분)
async function _autoRefreshKpi(){
    fetch("/api/cache/clear").catch(()=>{});
    await new Promise(r=>setTimeout(r,2000));
    for(let i=0;i<8;i++){
        await new Promise(r=>setTimeout(r,2000));
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
        responsive:true,maintainAspectRatio:false,animation:{duration:500},layout:{padding:{right:30, top:20}},
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
         welder:"",phase:"Phase 2",date_completed:"",remark:""}
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
    try {
        const [res, dailyRes, dashData] = await Promise.all([
            fetch("/api/welder-summary"),
            fetch("/api/welder-daily"),
            getDashData()
        ]);
        if (!res.ok) throw new Error("API error " + res.status);
        _welderData = await res.json();
        const dailyData = dailyRes.ok ? await dailyRes.json() : [];
        renderWelder(_welderData, dashData);
        renderWelderDaily(dailyData, _welderData.weekly || []);
    } catch(e) {
        console.error("Welder load failed", e);
        const bodyA = document.getElementById("welderRankBodyA");
        if(bodyA) bodyA.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">${e.message}</td></tr>`;
    }
}

function renderWelderDaily(daily, weekly) {
    const wrap  = document.getElementById("welderDailyTableWrap");
    const title = document.querySelector("#welderDailyPanel .panel-title");
    if (!wrap) return;
    if (!daily.length) { wrap.innerHTML = `<p style="color:var(--text-dim);font-size:11px;padding:10px">No daily data.</p>`; return; }

    // ── Last work week: Mon–Sun of most recent date ──
    const sortedDesc  = [...daily].sort((a, b) => b.day.localeCompare(a.day));
    const latestDate  = new Date(sortedDesc[0].day);
    const daysFromMon = (latestDate.getDay() + 6) % 7;
    const monDate     = new Date(latestDate); monDate.setDate(latestDate.getDate() - daysFromMon);
    const sunDate     = new Date(monDate);    sunDate.setDate(monDate.getDate() + 6);
    const monStr      = monDate.toISOString().slice(0, 10);
    const sunStr      = sunDate.toISOString().slice(0, 10);
    const wkDates     = daily.filter(d => d.day >= monStr && d.day <= sunStr)
                             .sort((a, b) => a.day.localeCompare(b.day));

    // Match week label
    const sortedWkly = [...weekly].sort((a, b) => (b.week_no || 0) - (a.week_no || 0));
    const matchedWk  = sortedWkly.find(w => w.week_start && w.week_end
        ? (monStr >= w.week_start && monStr <= w.week_end)
        : w.total_di > 0);
    const wkLabel = matchedWk?.week_label || "";
    if (title) title.textContent = `Daily Welder Activity${wkLabel ? " — " + wkLabel : ""}`;

    const sumWelders = wkDates.reduce((s, d) => s + d.welder_count, 0);
    const totalDI    = wkDates.reduce((s, d) => s + d.total_di, 0);

    // ── Horizontal layout: dates as columns ──
    const thCells = wkDates.map(d => {
        const dt   = new Date(d.day);
        const isWe = dt.getDay() === 0 || dt.getDay() === 6;
        return `<th style="text-align:center${isWe ? ";color:var(--orange)" : ""}">${d.day.slice(5)}</th>`;
    }).join("") + `<th style="text-align:center;color:var(--accent)">Total</th>`;

    // Welders row
    const welderCells = wkDates.map(d =>
        `<td style="text-align:center">${d.welder_count}</td>`
    ).join("") + `<td style="text-align:center;color:var(--accent)">${sumWelders}</td>`;

    // DI row
    const diCells = wkDates.map(d =>
        `<td style="text-align:center">${fmtNum(d.total_di, 1)}</td>`
    ).join("") + `<td style="text-align:center;color:var(--accent)">${fmtNum(totalDI, 1)}</td>`;

    wrap.innerHTML = `<table class="data-table" style="width:100%">
        <thead><tr>
            <th style="text-align:left;min-width:80px"></th>${thCells}
        </tr></thead>
        <tbody>
            <tr>
                <td style="color:var(--text-dim)">Welders</td>${welderCells}
            </tr>
            <tr>
                <td style="color:var(--text-dim)">Total DI</td>${diCells}
            </tr>
        </tbody>
    </table>`;
}

// Helper: render one half of a welder table (No / Welder ID / Joint / Total DI / Avg DI/Day)
function _welderHalfRows(rows, startIdx, accentColor) {
    if (!rows.length) return "";
    return rows.map((r, i) => `<tr>
        <td style="text-align:center;color:var(--text-dim)">${startIdx + i + 1}</td>
        <td style="color:${accentColor}">${r.welder}</td>
        <td style="text-align:right;font-family:'DM Mono',monospace">${fmtNum(r.joints, 1)}</td>
        <td style="text-align:right;font-family:'DM Mono',monospace">${fmtNum(r.total_di, 1)}</td>
        <td style="text-align:right;font-family:'DM Mono',monospace;color:var(--green)">${fmtNum(r.avg_di_per_day, 2)}</td>
    </tr>`).join("");
}

// Helper: render a split (2-col) welder table into two tbody elements
function _renderSplitWelderTable(rows, bodyIdA, bodyIdB, accentColor) {
    const mid = Math.ceil(rows.length / 2);
    const half1 = rows.slice(0, mid);
    const half2 = rows.slice(mid);
    const bA = document.getElementById(bodyIdA);
    const bB = document.getElementById(bodyIdB);
    const empty = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:16px">No data</td></tr>`;
    if (bA) bA.innerHTML = half1.length ? _welderHalfRows(half1, 0, accentColor) : empty;
    if (bB) bB.innerHTML = half2.length ? _welderHalfRows(half2, mid, accentColor) : "";
}

// Helper: build a compact table HTML for last-active-week/month split
function _welderSubTable(rows, startIdx, accentColor) {
    return `<table class="data-table" style="font-size:11px;width:100%">
        <thead><tr>
          <th style="min-width:42px;width:42px">No</th><th>Welder ID</th>
          <th style="text-align:right">Joint</th>
          <th style="text-align:right">Total DI</th>
          <th style="text-align:right">Avg DI/Day</th>
        </tr></thead>
        <tbody>${_welderHalfRows(rows, startIdx, accentColor)}</tbody>
    </table>`;
}

function renderWelder(data, dashData) {
    const s = data.stats || {};
    document.getElementById("welder-active").textContent       = s.active_welders || 0;
    document.getElementById("welder-total-joints").textContent = (s.total_joints || 0).toLocaleString();
    document.getElementById("welder-total-di").textContent     = fmtNum(s.total_di, 0);
    const ranking = data.ranking || [];
    const avgDiDay = ranking.length
        ? ranking.reduce((sum, r) => sum + (r.avg_di_per_day || 0), 0) / ranking.length
        : 0;
    document.getElementById("welder-avg-di").textContent = fmtNum(avgDiDay, 2);

    // Overall Week Actual: last active week DI from main dashboard data
    const weekDiEl = document.getElementById("welder-week-di");
    if (weekDiEl && dashData) {
        const wkData  = dashData.weekly || [];
        const actWks  = wkData.filter(w => w.completed_di > 0);
        const lastWk  = actWks[actWks.length - 1];
        weekDiEl.textContent = lastWk ? fmtNum(lastWk.completed_di, 0) : "—";
        const subEl = weekDiEl.nextElementSibling;
        if (subEl && lastWk) subEl.textContent = lastWk.week_label || "Last Week DI";
    }

    _updateWelderKpiBar(data);  // sync top-bar KPI card

    // ── Welder Performance: dual-column split table ────────────────────────────
    if (!ranking.length) {
        const empty = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:20px">No data. Enter completion dates in Joint Master.</td></tr>`;
        const bA = document.getElementById("welderRankBodyA");
        const bB = document.getElementById("welderRankBodyB");
        if (bA) bA.innerHTML = empty;
        if (bB) bB.innerHTML = "";
    } else {
        const sortedRanking = ranking.slice().sort((a, b) => (b.avg_di_per_day || 0) - (a.avg_di_per_day || 0));
        _renderSplitWelderTable(sortedRanking, "welderRankBodyA", "welderRankBodyB", "var(--accent)");
    }

    // ── Weekly chart: fixed 6-week frame ending at last active week ─────────────
    destroyChart("welderTrendChart");
    const trendEl = document.getElementById("welderTrendChart");
    const weeklyAll = data.weekly || [];
    const maxWkNo = weeklyAll.length ? Math.max(...weeklyAll.map(w => w.week_no)) : 6;
    const wkNos = Array.from({length: 6}, (_, i) => maxWkNo - 5 + i);
    const wkMap = {};
    weeklyAll.forEach(w => wkMap[w.week_no] = w);
    const wkSlice = wkNos.map(n => wkMap[n] || { week_label: "W" + n, total_di: null, avg_di_per_welder: null });
    if (trendEl) {
        charts["welderTrendChart"] = new Chart(trendEl.getContext("2d"), {
            type: "bar",
            data: {
                labels: wkSlice.map(w => w.week_label),
                datasets: [
                    {
                        type: "bar",
                        label: "Total DI",
                        data: wkSlice.map(w => w.total_di),
                        backgroundColor: "rgba(34,211,161,0.45)",
                        borderColor: "#22d3a1",
                        borderWidth: 1,
                        yAxisID: "y",
                        datalabels: { display: false }
                    },
                    {
                        type: "line",
                        label: "AVG DI/DAY PER WELDER",
                        data: wkSlice.map(w => w.avg_di_per_welder),
                        borderColor: "#60a5fa",
                        backgroundColor: "rgba(96,165,250,0.1)",
                        borderWidth: 2,
                        pointRadius: 5,
                        pointBackgroundColor: "#60a5fa",
                        tension: 0.35,
                        yAxisID: "y2",
                        datalabels: {
                            display: true,
                            color: "#60a5fa",
                            font: { size: 10, weight: "bold" },
                            anchor: "end",
                            align: "top",
                            formatter: v => fmtNum(v, 1)
                        }
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                animation: { duration: 400 },
                scales: {
                    x: { ticks: { color: "#7a95b8", font: { size: 10 } }, grid: { display: false } },
                    y: { type: "linear", position: "left", beginAtZero: true,
                         ticks: { color: "#22d3a1", font: { size: 10 } },
                         grid: { display: false },
                         title: { display: true, text: "Total DI", color: "#4a6080", font: { size: 10 } } },
                    y2: { type: "linear", position: "right", beginAtZero: true,
                          ticks: { color: "#60a5fa", font: { size: 10 } },
                          grid: { display: false },
                          title: { display: true, text: "AVG DI/DAY PER WELDER", color: "#4a6080", font: { size: 10 } } }
                },
                plugins: {
                    legend: { labels: { color: "#7a95b8", font: { size: 10 }, boxWidth: 10 } },
                    tooltip: { backgroundColor: "#111827", borderColor: "#1e2d45", borderWidth: 1,
                               titleColor: "#e2eaf6", bodyColor: "#7a95b8", padding: 10 }
                }
            }
        });
    }

    // ── Monthly chart: fixed 6-month frame starting from first active month ─────
    destroyChart("welderSysChart");
    const sysEl = document.getElementById("welderSysChart");
    const monthlyAll = data.monthly || [];
    // Anchor = first (earliest) month in data → show 6 months forward
    const _anchorMonth = monthlyAll.length
        ? monthlyAll[0].month
        : (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}`; })();
    const [_ay, _am] = _anchorMonth.split("-").map(Number);
    const moFrame = Array.from({length: 6}, (_, i) => {
        let mo = _am + i, yr = _ay;
        while (mo > 12) { mo -= 12; yr++; }
        return `${yr}-${String(mo).padStart(2, "0")}`;
    });
    const moMap = {};
    monthlyAll.forEach(m => moMap[m.month] = m);
    const moSlice = moFrame.map(mo => moMap[mo] || { month: mo, total_di: null, avg_di_per_welder: null });
    if (sysEl) {
        charts["welderSysChart"] = new Chart(sysEl.getContext("2d"), {
            type: "bar",
            data: {
                labels: moSlice.map(m => m.month),
                datasets: [
                    {
                        type: "bar",
                        label: "Total DI",
                        data: moSlice.map(m => m.total_di),
                        backgroundColor: "rgba(99,102,241,0.45)",
                        borderColor: "#6366f1",
                        borderWidth: 1,
                        yAxisID: "y",
                        datalabels: { display: false }
                    },
                    {
                        type: "line",
                        label: "AVG DI/DAY PER WELDER",
                        data: moSlice.map(m => m.avg_di_per_welder),
                        borderColor: "#60a5fa",
                        backgroundColor: "rgba(96,165,250,0.1)",
                        borderWidth: 2,
                        pointRadius: 5,
                        pointBackgroundColor: "#60a5fa",
                        tension: 0.3,
                        yAxisID: "y2",
                        datalabels: {
                            display: true,
                            color: "#60a5fa",
                            font: { size: 10, weight: "bold" },
                            anchor: "end",
                            align: "top",
                            formatter: v => fmtNum(v, 1)
                        }
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                animation: { duration: 400 },
                scales: {
                    x: { ticks: { color: "#7a95b8", font: { size: 10 } }, grid: { display: false } },
                    y: { type: "linear", position: "left", beginAtZero: true,
                         ticks: { color: "#6366f1", font: { size: 10 } },
                         grid: { display: false },
                         title: { display: true, text: "Total DI", color: "#4a6080", font: { size: 10 } } },
                    y2: { type: "linear", position: "right", beginAtZero: true,
                          ticks: { color: "#60a5fa", font: { size: 10 } },
                          grid: { display: false },
                          title: { display: true, text: "AVG DI/DAY PER WELDER", color: "#4a6080", font: { size: 10 } } }
                },
                plugins: {
                    legend: { labels: { color: "#7a95b8", font: { size: 10 }, boxWidth: 10 } },
                    tooltip: { backgroundColor: "#111827", borderColor: "#1e2d45", borderWidth: 1,
                               titleColor: "#e2eaf6", bodyColor: "#7a95b8", padding: 10 }
                }
            }
        });
    }

    // ── Weekly Welder Performance: dual-column last-week table ─────────────────
    const lw = data.last_week || [];
    const weekEl1 = document.getElementById("weeklyWelderTable");
    const weekEl2 = document.getElementById("weeklyWelderTable2");
    if (weekEl1 && weekEl2) {
        if (lw.length > 0) {
            const weekLabel = lw[0].week_label || "";
            const mid = Math.ceil(lw.length / 2);
            weekEl1.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:5px">${weekLabel} — Active Welders</div>`
                + _welderSubTable(lw.slice(0, mid), 0, "var(--accent)");
            weekEl2.innerHTML = lw.length > mid
                ? `<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:5px">&nbsp;</div>`
                  + _welderSubTable(lw.slice(mid), mid, "var(--accent)")
                : "";
        } else {
            weekEl1.innerHTML = `<p style="color:var(--text-dim);font-size:11px;padding:10px">No data for last active week.</p>`;
            weekEl2.innerHTML = "";
        }
    }

    // ── Monthly Work Status: dual-column last-month table ──────────────────────
    const lm = data.last_month || [];
    const monthEl1 = document.getElementById("monthlyWelderTable");
    const monthEl2 = document.getElementById("monthlyWelderTable2");
    if (monthEl1 && monthEl2) {
        if (lm.length > 0) {
            const monthLabel = lm[0].month || "";
            const mid = Math.ceil(lm.length / 2);
            monthEl1.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--indigo);margin-bottom:5px">${monthLabel} — Active Welders</div>`
                + _welderSubTable(lm.slice(0, mid), 0, "var(--indigo)");
            monthEl2.innerHTML = lm.length > mid
                ? `<div style="font-size:11px;font-weight:700;color:var(--indigo);margin-bottom:5px">&nbsp;</div>`
                  + _welderSubTable(lm.slice(mid), mid, "var(--indigo)")
                : "";
        } else {
            monthEl1.innerHTML = `<p style="color:var(--text-dim);font-size:11px;padding:10px">No data for last active month.</p>`;
            monthEl2.innerHTML = "";
        }
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

    document.getElementById("drill-welder-name").textContent  = `👷 ${welderId}`;
    document.getElementById("drill-joints").textContent       = wInfo.joints;
    document.getElementById("drill-total-di").textContent     = fmtNum(wInfo.total_di, 1);
    document.getElementById("drill-working-days").textContent = wInfo.working_days || "-";
    document.getElementById("drill-avg-di-day").textContent   = fmtNum(wInfo.avg_di_per_day, 2);

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
            "Welder ID":       r.welder,
            "Total Joints":    r.joints,
            "Total DI":        r.total_di,
            "Working Days":    r.working_days,
            "Avg DI/Day":      r.avg_di_per_day
        });
    }
    const ws  = XLSX.utils.json_to_sheet(rows);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "WelderRanking");

    // Weekly productivity sheet
    if ((_welderData.weekly || []).length) {
        const ws2 = XLSX.utils.json_to_sheet(_welderData.weekly.map(w => ({
            "Week":              w.week_label,
            "Completed DI":     w.total_di,
            "Joints":           w.joints,
            "Active Welders":   w.active_welders,
            "Avg DI/Welder":    w.avg_di_per_welder
        })));
        XLSX.utils.book_append_sheet(wb, ws2, "WeeklyProductivity");
    }

    // Monthly productivity sheet
    if ((_welderData.monthly || []).length) {
        const ws3 = XLSX.utils.json_to_sheet(_welderData.monthly.map(m => ({
            "Month":            m.month,
            "Completed DI":     m.total_di,
            "Joints":           m.joints,
            "Active Welders":   m.active_welders,
            "Avg DI/Welder":    m.avg_di_per_welder
        })));
        XLSX.utils.book_append_sheet(wb, ws3, "MonthlyProductivity");
    }
    const success = await downloadWithPicker(wb, "Welder_Performance.xlsx");
    if (success) toast("✓ Welder performance exported");
}

// ================================================================================
//  SUPPORT MASTER
// ================================================================================
let smData = [], smCurrentPage = 0;
const SM_PAGE_SIZE = 50;

async function loadSupportMaster() {
    const unit    = document.getElementById("sm-unit")?.value    || "";
    const system  = document.getElementById("sm-system")?.value  || "";
    const subarea = document.getElementById("sm-subarea")?.value || "";
    const status  = document.getElementById("sm-status")?.value  || "";
    const phase   = document.getElementById("sm-phase")?.value   || "";
    const iso     = document.getElementById("sm-iso")?.value?.trim() || "";
    const offset  = smCurrentPage * SM_PAGE_SIZE;
    
    try {
        const params = new URLSearchParams({limit: SM_PAGE_SIZE, offset});
        if (unit)    params.set("unit",     unit);
        if (system)  params.set("system",   system);
        if (subarea) params.set("sub_area", subarea);
        if (status)  params.set("status",   status);
        if (phase)   params.set("phase",    phase);
        if (iso)     params.set("iso",      iso);
        
        const res = await apiFetch(`/api/support-master?${params}`);
        smData = res.data;
        document.getElementById("sm-count").textContent = `${(res.count||0).toLocaleString()} rows loaded`;
        document.getElementById("sm-page-info").textContent = `Page ${smCurrentPage+1}`;
        
        const prevBtn = document.getElementById("sm-prev-btn");
        const nextBtn = document.getElementById("sm-next-btn");
        if (prevBtn) prevBtn.disabled = (smCurrentPage === 0);
        if (nextBtn) nextBtn.disabled = (res.data.length < SM_PAGE_SIZE);

        renderSMTable(smData);
        updateSmIsoBulkPanel(iso, smData);
    } catch(e) { console.error("Support Master load failed", e); }
}

function updateSmIsoBulkPanel(isoVal, rows) {
    const panel = document.getElementById("sm-iso-bulk-panel");
    if (!panel) return;
    if (!isoVal || rows.length === 0) { panel.style.display = "none"; return; }
    
    // Filter rows that match the search (support_drawing or iso_drawing)
    const targets = rows.filter(r => 
        (r.support_drawing && r.support_drawing.toLowerCase().includes(isoVal.toLowerCase())) || 
        (r.iso_drawing && r.iso_drawing.toLowerCase().includes(isoVal.toLowerCase()))
    );
    
    if (targets.length === 0) { panel.style.display = "none"; return; }
    
    panel.style.display = "flex";
    const completedCount = targets.filter(r => r.date_completed).length;
    document.getElementById("sm-iso-info").textContent = `${isoVal}  ·  ${targets.length} items  ·  ${completedCount} completed`;
}

async function applySmBulkDate() {
    const isoVal = document.getElementById("sm-iso")?.value?.trim();
    let dateVal = document.getElementById("sm-bulk-date")?.value?.trim();
    if (!isoVal) { toast("Please enter Search Drawing first", "error"); return; }
    if (!dateVal) { toast("Please enter date (YY-MM-DD)", "error"); return; }
    if (!/^\d{2,4}-\d{2}-\d{2}$/.test(dateVal)) { toast("Invalid date format (YY-MM-DD)", "error"); return; }
    if (dateVal.length === 8) dateVal = "20" + dateVal;
    
    const targets = smData.filter(r => 
        (r.support_drawing && r.support_drawing.toLowerCase().includes(isoVal.toLowerCase())) || 
        (r.iso_drawing && r.iso_drawing.toLowerCase().includes(isoVal.toLowerCase()))
    );
    
    if (targets.length === 0) { toast("No items found for this search", "error"); return; }
    const btn = document.getElementById("sm-bulk-apply-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving..."; }
    
    try {
        let saved = 0;
        for (const r of targets) {
            await fetch(`${API}/api/support-master/${r.id}`, {
                method: "PATCH", 
                headers: {"Content-Type": "application/json"}, 
                body: JSON.stringify({date_completed: dateVal, completed: true})
            });
            const el = document.getElementById(`sm-date-${r.id}`);
            if (el) el.value = dateVal;
            saved++;
        }
        toast(`✓ ${saved} items saved — KPI updating...`);
        fetch("/api/cache/clear");
        updateSmIsoBulkPanel(isoVal, smData);
    } catch(e) { toast(`✗ Bulk save failed: ${e.message}`, "error"); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "Apply to All"; } }
}

async function clearSmBulkDate() {
    const isoVal = document.getElementById("sm-iso")?.value?.trim();
    if (!isoVal) { toast("Please enter Search Drawing first", "error"); return; }
    
    const targets = smData.filter(r => 
        (r.support_drawing && r.support_drawing.toLowerCase().includes(isoVal.toLowerCase())) || 
        (r.iso_drawing && r.iso_drawing.toLowerCase().includes(isoVal.toLowerCase()))
    );
    
    if (targets.length === 0) { toast("No items found for this search", "error"); return; }
    if (!confirm(`Delete dates for all ${targets.length} items?`)) return;
    
    try {
        for (const r of targets) {
            await fetch(`${API}/api/support-master/${r.id}`, {
                method: "PATCH", 
                headers: {"Content-Type": "application/json"}, 
                body: JSON.stringify({date_completed: null, completed: false})
            });
            const el = document.getElementById(`sm-date-${r.id}`);
            if (el) el.value = "";
        }
        toast(`✓ ${targets.length} items cleared — KPI updating...`);
        fetch("/api/cache/clear");
        updateSmIsoBulkPanel(isoVal, smData);
    } catch(e) { toast(`✗ Bulk clear failed: ${e.message}`, "error"); }
}

function smPage(dir) { smCurrentPage = Math.max(0, smCurrentPage + dir); loadSupportMaster(); }

function renderSMTable(rows) {
    const tbody = document.getElementById("smBody");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--text-dim);padding:20px">No data. Add items or import from Excel.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const dc = r.date_completed ? r.date_completed.substring(0,10) : "";
        return `<tr id="smrow-${r.id}">
          <td>${r.id}</td>
          <td><input class="cell-input" id="sm-phase-${r.id}" type="text" value="${r.phase||""}" style="text-align:center"></td>
          <td>${r.unit||""}</td>
          <td>${r.system||""}</td>
          <td>${r.area||""}</td>
          <td>${r.sub_area||""}</td>
          <td>${r.support_drawing||""}</td>
          <td>${r.revision||""}</td>
          <td style="font-size:11px;font-family:'DM Mono',monospace">${r.iso_drawing||""}</td>
          <td>${r.line_no||""}</td>
          <td><input class="cell-input" id="sm-welder-${r.id}" type="text" value="${r.welder||""}"></td>
          <td><input class="cell-input" id="sm-date-${r.id}" type="text" value="${dc}" placeholder="YY-MM-DD" style="width:100px"></td>
          <td style="white-space:nowrap">
            <button class="btn-save-row" onclick="saveSMRow(${r.id})">Save</button>
            <button class="btn-clear-row" onclick="deleteSMItem(${r.id})">Del</button>
          </td>
        </tr>`;
    }).join("");
}

async function saveSMRow(id) {
    let dateVal = document.getElementById(`sm-date-${id}`)?.value?.trim() || "";
    let welder  = document.getElementById(`sm-welder-${id}`)?.value?.trim() || "";
    let phase   = document.getElementById(`sm-phase-${id}`)?.value?.trim() || "";
    
    if (dateVal && !/^\d{2,4}-\d{2}-\d{2}$/.test(dateVal)) { toast("Invalid date (YY-MM-DD)", "error"); return; }
    if (dateVal && dateVal.length === 8) dateVal = "20" + dateVal;
    
    try {
        const r = await fetch(`/api/support-master/${id}`, {
            method: "PATCH", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({
                date_completed: dateVal || null, 
                completed: !!dateVal,
                welder: welder || null,
                phase: phase || null
            })
        });
        if (!r.ok) throw new Error("HTTP "+r.status);
        toast(`✓ Support #${id} saved`); 
        fetch("/api/cache/clear");
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
        phase:           document.getElementById("sm-new-phase").value.trim(),
        unit:            document.getElementById("sm-new-unit").value.trim(),
        system:          document.getElementById("sm-new-system").value.trim(),
        area:            document.getElementById("sm-new-area").value.trim(),
        sub_area:        document.getElementById("sm-new-subarea").value.trim(),
        support_drawing: document.getElementById("sm-new-support_drawing").value.trim(),
        revision:        document.getElementById("sm-new-revision").value.trim(),
        iso_drawing:     document.getElementById("sm-new-iso").value.trim(),
        line_no:         document.getElementById("sm-new-line_no").value.trim(),
        welder:          document.getElementById("sm-new-welder").value.trim(),
        completed:       false
    };
    if (!data.system && !data.support_drawing) { toast("System or Support Drawing required", "error"); return; }
    try {
        const r = await fetch("/api/support-master", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data)});
        const d = await r.json(); if (!d.ok) throw new Error(d.error);
        toast("✓ Support added"); closeSMModal(); loadSupportMaster();
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

async function importSMExcel() {
    const fi = document.getElementById("sm-import-file");
    if (!fi?.files.length) { toast("Select file first", "error"); return; }
    
    // Show a loading toast
    toast("Uploading and processing Support Master Excel...", "info");
    
    const fd = new FormData(); 
    fd.append("file", fi.files[0]);
    
    try {
        const res = await fetch("/api/support-master/import", {method:"POST", body:fd});
        const data = await res.json(); 
        if (!data.ok) throw new Error(data.error);
        
        const msg = `✓ Imported ${data.inserted} rows${data.skipped>0?` (${data.skipped} skipped)`:""}`;
        toast(msg); 
        fi.value = "";
        fetch("/api/cache/clear"); 
        loadSupportMaster();
    } catch(e) { 
        toast(`✗ Import failed: ${e.message}`, "error"); 
    }
}

async function exportSMExcel() {
    if (!smData?.length) { toast("No data", "error"); return; }
    const rows = smData.map(r => ({
        "NO. ": r.id,
        "PHASE": r.phase || "",
        "UNIT": r.unit || "",
        "SYSTEM": r.system || "",
        "AREA": r.area || "",
        "SUB AREA": r.sub_area || "",
        "SUPPORT DRAWING": r.support_drawing || "",
        "REVISION": r.revision || "",
        "ISO DRAWING": r.iso_drawing || "",
        "LINE NO": r.line_no || "",
        "WELDER": r.welder || "",
        "ACTUAL DATE": r.date_completed ? r.date_completed.substring(0,10) : "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows); 
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SupportMaster");
    const ok = await downloadWithPicker(wb, "Support_Master_Export.xlsx"); 
    if (ok) toast("✓ Exported");
}

// ================================================================================
//  TEST PACKAGE MASTER
// ================================================================================
let tpData = [], tpCurrentPage = 0;
const TP_PAGE = 100;

async function loadTestPkgMaster() {
    const pkg    = document.getElementById("tp-package")?.value || "";
    const system = document.getElementById("tp-system")?.value  || "";
    const status = document.getElementById("tp-status")?.value  || "";
    const offset = tpCurrentPage * TP_PAGE;
    try {
        // Populate package dropdown on first load
        const tpPkg = document.getElementById("tp-package");
        const tpSys = document.getElementById("tp-system");
        if (tpPkg && tpPkg.options.length <= 1) {
            ["TRU-CCW-001","TRU-CCW-002"].forEach(p => tpPkg.add(new Option(p, p)));
        }
        if (tpSys && tpSys.options.length <= 1) (metaData.systems||[]).forEach(s => tpSys.add(new Option(s,s)));

        const params = new URLSearchParams({limit: TP_PAGE, offset});
        if (pkg)    params.set("package", pkg);
        if (system) params.set("system",  system);
        if (status) params.set("status",  status);
        const res = await apiFetch(`/api/testpkg-joints?${params}`);
        tpData = res.data;
        document.getElementById("tp-count").textContent = `${(res.count||0).toLocaleString()} rows (page ${tpCurrentPage+1})`;
        document.getElementById("tp-page-info").textContent = `Page ${tpCurrentPage+1}`;
        const prevBtn = document.getElementById("tp-prev-btn");
        const nextBtn = document.getElementById("tp-next-btn");
        if (prevBtn) prevBtn.disabled = (tpCurrentPage === 0);
        if (nextBtn) nextBtn.disabled = (res.data.length < TP_PAGE);
        renderTPTable(tpData);
    } catch(e) { console.error("Test Pkg Master load failed", e); }
}

function tpPage(dir) { tpCurrentPage = Math.max(0, tpCurrentPage + dir); loadTestPkgMaster(); }

function _tpResultBadge(result) {
    if (!result) return '<span style="color:var(--text-dim)">-</span>';
    const color = result === "PASS" ? "var(--green)" : "var(--orange)";
    return `<span style="font-weight:700;color:${color}">${result}</span>`;
}

function renderTPTable(rows) {
    const tbody = document.getElementById("tpBody");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="18" style="text-align:center;color:var(--text-dim);padding:20px">No data. Package 필터를 선택하거나 Sync Phase/Pkg 버튼을 클릭하세요.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const weldDate = r.date_completed ? r.date_completed.substring(0,10) : "";
        const vtDate   = r.vt_date   ? r.vt_date.substring(0,10)   : "";
        const mtDate   = r.mt_date   ? r.mt_date.substring(0,10)   : "";
        const ptDate   = r.pt_date   ? r.pt_date.substring(0,10)   : "";
        const rtDate   = r.rt_date   ? r.rt_date.substring(0,10)   : "";
        const pwhtDate = r.pwht_date ? r.pwht_date.substring(0,10) : "";
        const statusColor = r.status === "Completed" ? "var(--green)" : "var(--orange)";
        const statusIcon  = r.status === "Completed" ? "&#10003;" : "&#9679;";
        return `<tr id="tprow-${r.id}">
          <td style="text-align:center">${r.system||""}</td>
          <td style="font-weight:600;color:var(--indigo)">${r.package||""}</td>
          <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title="${r.iso_drawing||""}">${r.iso_drawing||""}</td>
          <td style="text-align:center">${r.joint_no||""}</td>
          <td style="text-align:center;color:var(--accent)">${weldDate||"-"}</td>
          <td style="padding:2px;text-align:center"><input type="text" class="cell-input" id="tp-vt-date-${r.id}" value="${vtDate}" placeholder="YY-MM-DD" style="padding:3px 4px;text-align:center"></td>
          <td style="padding:2px;text-align:center">
            <select class="cell-input" id="tp-vt-res-${r.id}" style="padding:3px 4px;text-align:center;text-align-last:center;cursor:pointer">
              <option value="" style="color:#000">-</option>
              <option value="PASS" style="color:#000" ${r.vt_result==="PASS"?"selected":""}>PASS</option>
              <option value="FAIL" style="color:#000" ${r.vt_result==="FAIL"?"selected":""}>FAIL</option>
            </select>
          </td>
          <td style="text-align:center;font-size:11px">${mtDate||"-"}</td>
          <td style="text-align:center">${_tpResultBadge(r.mt_result)}</td>
          <td style="text-align:center;font-size:11px">${ptDate||"-"}</td>
          <td style="text-align:center">${_tpResultBadge(r.pt_result)}</td>
          <td style="text-align:center;font-size:11px">${rtDate||"-"}</td>
          <td style="text-align:center">${_tpResultBadge(r.rt_result)}</td>
          <td style="text-align:center;font-size:11px">${pwhtDate||"-"}</td>
          <td style="text-align:center">${_tpResultBadge(r.pwht_result)}</td>
          <td style="text-align:center;font-weight:700;font-size:11px;color:${statusColor}">${statusIcon} ${r.status}</td>
          <td style="text-align:center"><button class="btn-save-row" style="padding:3px 8px;font-size:10px" onclick="saveTPVT(${r.id})">Save</button></td>
        </tr>`;
    }).join("");
}

async function saveTPVT(id) {
    let vtDate = document.getElementById(`tp-vt-date-${id}`)?.value?.trim() || "";
    const vtRes  = document.getElementById(`tp-vt-res-${id}`)?.value || "";
    if (vtDate && !/^\d{2,4}-\d{2}-\d{2}$/.test(vtDate)) { toast("VT Date: YY-MM-DD 형식으로 입력", "error"); return; }
    if (vtDate && vtDate.length === 8) vtDate = "20" + vtDate;
    try {
        const r = await fetch(`${API}/api/joints/${id}`, {
            method: "PATCH",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({vt_date: vtDate||null, vt_result: vtRes||null})
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        toast(`✓ VT saved (ID ${id})`);
        loadTestPkgMaster();
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

async function syncPhasePackage() {
    if (!confirm("Raw File 폴더의 BOP Piping Joint Master.xlsx에서 PHASE와 PACKAGE를 동기화합니다.\n계속하시겠습니까?")) return;
    toast("Syncing...");
    try {
        const r = await fetch("/api/joints/sync-phase-package", {method:"POST"});
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        toast(`✓ Sync complete: ${d.updated} joints updated (${d.rows_read} rows read)`);
        loadTestPkgMaster();
    } catch(e) { toast(`✗ Sync failed: ${e.message}`, "error"); }
}

async function exportTPExcel() {
    if (!tpData?.length) { toast("No data", "error"); return; }
    const rows = tpData.map(r => ({
        "ID": r.id,
        "System": r.system||"",
        "Package": r.package||"",
        "ISO Drawing No": r.iso_drawing||"",
        "Joint No": r.joint_no||"",
        "Welding Date": r.date_completed ? r.date_completed.substring(0,10) : "",
        "VT Date": r.vt_date ? r.vt_date.substring(0,10) : "",
        "VT Result": r.vt_result||"",
        "MT Date": r.mt_date ? r.mt_date.substring(0,10) : "",
        "MT Result": r.mt_result||"",
        "PT Date": r.pt_date ? r.pt_date.substring(0,10) : "",
        "PT Result": r.pt_result||"",
        "RT Date": r.rt_date ? r.rt_date.substring(0,10) : "",
        "RT Result": r.rt_result||"",
        "PWHT Date": r.pwht_date ? r.pwht_date.substring(0,10) : "",
        "PWHT Result": r.pwht_result||"",
        "Status": r.status||""
    }));
    const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "TestPkgMaster");
    const ok = await downloadWithPicker(wb, "TestPkg_Master_Export.xlsx"); if (ok) toast("✓ Exported");
}
