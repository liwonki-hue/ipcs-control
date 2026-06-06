// dashboard.js Full frontend logic  v7.16

const API = "";  // Flask runs on same origin
let charts = {};
let jmData = [];
let jmCurrentPage = 0;
const JM_PAGE_SIZE = 30;
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

    const _t0 = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        try {
            const res = await fetchWithTimeout("/api/dashboard", TIMEOUT_MS);
            const elapsed = Math.round((Date.now() - _t0) / 1000);
            if (res.status === 202) {
                const estMin = elapsed < 60 ? "1~2분" : elapsed < 150 ? "2~3분" : "잠시만";
                _updateLoader(`서버 기동 중... ${elapsed}s · 예상 대기: ${estMin} (${i+1}/${MAX_ATTEMPTS})`);
                await new Promise(r => setTimeout(r, RETRY_MS));
                continue;
            }
            // 503: 서버 캐시 빌드 실패 — 자동 재시도 대기
            if (res.status === 503) {
                let body = {};
                try { body = await res.json(); } catch(_) {}
                const msg = body.message || "Cache build failed. Auto-retrying...";
                _updateLoader(`⚠ ${msg} (${elapsed}s)`);
                await new Promise(r => setTimeout(r, 15000));
                continue;
            }
            if (!res.ok) {
                let body = {};
                try { body = await res.json(); } catch(_) {}
                throw new Error(body.message || `Server error ${res.status}`);
            }
            _dashData = await res.json();
            return _dashData;
        } catch(e) {
            const elapsed = Math.round((Date.now() - _t0) / 1000);
            if (e.message === "fetch_timeout") {
                _updateLoader(`Server starting... ${elapsed}s (${i+1}/${MAX_ATTEMPTS})`);
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
    let _loadError = false;
    try {
        // getDashData() 먼저 대기 → 캐시 빌드 완료 후 meta도 즉시 반환됨
        const data = await getDashData();
        await loadMeta();
        // Overview 페이지를 visible로 전환 후 렌더링 (Chart.js는 hidden 캔버스에서 크기 0으로 그림)
        document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === "overview"));
        document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
        document.getElementById("page-overview")?.classList.remove("hidden");
        document.getElementById("kpiRow") && (document.getElementById("kpiRow").style.display = "grid");
        renderKPI(data.kpi, data.weekly);
        renderOverview(data.kpi, data.weekly, data.units, data.systems);
    } catch(e) {
        _loadError = true;
        console.error("[BOP] Init error:", e);
        showLoader(false, "Load failed: " + e.message);
    } finally {
        // 에러 화면이 표시 중인 경우에는 loader를 숨기지 않음
        if (!_loadError) showLoader(false);
    }
    // Background: fetch welder summary after initial render (non-blocking, delayed)
    setTimeout(() => {
        fetch("/api/welder-summary").then(r => r.json()).then(wd => {
            _welderData = wd;
            _updateWelderKpiBar(wd);
        }).catch(() => {});
    }, 3000);
});

function _updateWelderKpiBar(wd) {
    const ranking = wd?.ranking || [];
    if (!ranking.length) return;
    const avg = ranking.reduce((s, r) => s + (r.avg_di_per_day || 0), 0) / ranking.length;
    const avgTxt = fmtNum(avg, 2);
    const subTxt = `${wd.stats?.active_welders || 0} welders · AVG DI/Day`;
    ["kpi-welder-perf",  "ep-kpi-welder"]    .forEach(id => { const el=document.getElementById(id); if(el) el.textContent = avgTxt; });
    ["kpi-welder-sub",   "ep-kpi-welder-sub"].forEach(id => { const el=document.getElementById(id); if(el) el.textContent = subTxt; });

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
          <div style="color:#7a95b8;font-size:11px;margin-top:6px;font-family:DM Mono,monospace">Cold start: 약 3~4분 소요 · 잠시 기다려 주세요...</div>
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        `;
        document.body.appendChild(el);
    }
    // Error mode: show message + retry button instead of spinner
    if (!show && msg) {
        el.style.display = "flex";
        el.style.pointerEvents = "auto";
        el.innerHTML = `
          <div style="color:#ff5252;font-size:18px;margin-bottom:10px">&#9888; Load Failed</div>
          <div style="color:#e0e6ef;font-size:13px;text-align:center;max-width:480px;line-height:1.6">${msg}</div>
          <button onclick="location.reload()" style="margin-top:20px;padding:10px 28px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;letter-spacing:0.04em">&#8635; Retry</button>
          <div style="color:#4a6080;font-size:11px;margin-top:10px">F5 또는 위 버튼으로 재시도</div>
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        `;
        return;
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
        const dataInputPages = ["joint_master", "support_master", "nde_pwht", "testpkg_master", "test_master", "welder"];
        const epKpiRow = document.getElementById("epKpiRow");
        if (kpiRow) {
            kpiRow.style.display = (dataInputPages.includes(page) || page === "early_power") ? "none" : "grid";
        }
        if (epKpiRow) {
            epKpiRow.style.display = page === "early_power" ? "grid" : "none";
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
        case "test_master":    loadTestMaster();    break;

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
        const ts = new Date().getTime();
        const res = await fetch("/api/meta?_t=" + ts, { cache: "no-store" });
        if (res.status === 202) {
            setTimeout(loadMeta, 3000);
            return;
        }
        if (!res.ok) throw new Error("API error: " + res.status);
        metaData = await res.json();
        
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

        // Populate Test Package Master filters
        const tpSys = document.getElementById("tp-system");
        if (tpSys) { tpSys.innerHTML = '<option value="">System</option>'; metaData.systems.forEach(s => tpSys.add(new Option(s, s))); }
    } catch(e) { console.error("Meta load failed", e); }
}

// ================================================================================
//  KPI RENDER
// ================================================================================
function renderKPI(d, wkData) {
    if (!d || !d.total_plan_di) return;
    document.getElementById("reportDate").textContent = d.report_date || "—";
    const pipingPct  = d.overall_pct   || 0;
    const supportPct = d.support_pct   || 0;
    const testPct    = d.testpkg_pct   || 0;
    const weightedPct = parseFloat((d.unified_readiness || (pipingPct * 0.7 + supportPct * 0.2 + testPct * 0.1)).toFixed(2));
    document.getElementById("kpi-overall").textContent     = `${weightedPct}%`;
    document.getElementById("kpi-bar").style.width = `${Math.min(weightedPct, 100)}%`;
    const weightSubEl = document.getElementById("kpi-overall-weight-sub");
    if (weightSubEl) weightSubEl.textContent = `PIPING ${Math.round(pipingPct)}% · SUP ${Math.round(supportPct)}% · TEST ${Math.round(testPct)}%`;

    const totalEl    = document.getElementById("kpi-total-di");
    const totalSubEl = document.getElementById("kpi-total-di-sub");
    if (totalEl)    totalEl.textContent    = fmtNum(d.total_plan_di, 0);
    if (totalSubEl) totalSubEl.textContent = `${Math.round(pipingPct)}% · ${d.total_joints?.toLocaleString() || "–"} joints`;

    const completedEl    = document.getElementById("kpi-completed");
    const completedSubEl = document.getElementById("kpi-completed-sub");
    if (completedEl)    completedEl.textContent    = fmtNum(d.completed_di, 0);
    if (completedSubEl) completedSubEl.textContent = `Fab ${fmtNum(d.fab_di,0)} · Erect ${fmtNum(d.erect_di,0)}`;
    document.getElementById("kpi-remain").textContent     = fmtNum(d.remaining_di, 0);
    document.getElementById("kpi-remain-sub").textContent = `${(100 - weightedPct).toFixed(1)}% remaining`;

    const actWks = (wkData || []).filter(w => w.completed_di > 0);
    const kpiWeekVal = document.getElementById("kpi-week");
    const kpiWeekSub = document.getElementById("kpi-week-sub");
    if (actWks.length) {
        const lw  = actWks[actWks.length - 1];
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
            // Show a minimal arc (2%) even at 0% so the gauge remains visible
            const visP   = Math.max(p, p > 0 ? p : 0);
            const offset = Math.PI * 84 * (1 - Math.min(visP / 100, 1));
            gp.style.stroke          = p > 0 ? "#f97316" : "#374151";  // 0% = gray
            gp.style.strokeDashoffset = p > 0 ? offset : Math.PI * 84 * 0.98; // 0% = 2% arc
            gt.textContent = `${p}%`;
            gt.style.fill  = p > 0 ? "#f97316" : "#6b7280";
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

        // ── By System: single merged-header table ──────────────────────
        const sysList = (systems || []).slice().sort((a, b) => (b.completed_di||0) - (a.completed_di||0));
        const sysBody = document.getElementById("sysBreakdownBody");
        if (sysBody) {
            if (!sysList.length) {
                sysBody.innerHTML = `<tr><td colspan="14" style="text-align:center;color:var(--text-dim);padding:16px">No system data</td></tr>`;
            } else {
                sysBody.innerHTML = sysList.map(s => {
                    const pipPlan = s.total_di || s.plan_di || 0;
                    const pipDone = s.completed_di || 0;
                    const pipRem  = Math.max(0, pipPlan - pipDone);
                    const pipPct  = s.progress_pct || 0;
                    const supTot  = s.support_total || 0;
                    const supDone = s.support_comp  || 0;
                    const supRem  = Math.max(0, supTot - supDone);
                    const supPct  = s.support_pct   || 0;
                    const tstTot  = s.testpkg_total || 0;
                    const tstDone = s.testpkg_comp  || 0;
                    const tstRem  = Math.max(0, tstTot - tstDone);
                    const tstPct  = s.testpkg_pct   || 0;
                    const totPct  = parseFloat((s.unified_readiness || (pipPct*0.7 + supPct*0.2 + tstPct*0.1)).toFixed(2));
                    const _dash   = v => v > 0 ? v : "—";
                    return `<tr>
                        <td style="text-align:center">${s.system||"—"}</td>
                        <td style="text-align:center">${fmtNum(pipPlan,0)}</td>
                        <td style="text-align:center">${_dash(supTot)}</td>
                        <td style="text-align:center">${_dash(tstTot)}</td>
                        <td style="text-align:center;color:var(--green)">${fmtNum(pipDone,0)}</td>
                        <td style="text-align:center;color:var(--green)">${_dash(supDone)}</td>
                        <td style="text-align:center;color:var(--green)">${_dash(tstDone)}</td>
                        <td style="text-align:center;color:var(--orange)">${fmtNum(pipRem,0)}</td>
                        <td style="text-align:center;color:var(--orange)">${_dash(supRem)}</td>
                        <td style="text-align:center;color:var(--orange)">${_dash(tstRem)}</td>
                        <td style="text-align:center;color:${pctColor(pipPct)}">${pipPct}%</td>
                        <td style="text-align:center;color:${pctColor(supPct)}">${supPct > 0 ? supPct+"%" : "—"}</td>
                        <td style="text-align:center;color:${pctColor(tstPct)}">${tstPct > 0 ? tstPct+"%" : "—"}</td>
                        <td style="text-align:center;font-weight:700;color:${pctColor(totPct)}">${totPct.toFixed(2)}%</td>
                    </tr>`;
                }).join("");
            }
        }

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

        const scurveLabels = wkData.map(w => w.week_label);
        const scurveEl = document.getElementById("scurveChart");
        if (!scurveEl) { console.warn("[BOP] scurveChart canvas not found"); return; }
        charts["scurveChart"] = new Chart(scurveEl.getContext("2d"), {
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
        const weeklyBarEl = document.getElementById("weeklyBar");
        if (!weeklyBarEl) { console.warn("[BOP] weeklyBar canvas not found"); return; }
        charts["weeklyBar"] = new Chart(weeklyBarEl.getContext("2d"), {
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
        // ep_sys 합산을 우선 사용 → 게이지와 테이블 물량 일치
        const d_total_di     = systems?.length ? systems.reduce((s,r) => s + (r.total_di     || 0), 0) : (d.total_di     || 0);
        const d_completed_di = systems?.length ? systems.reduce((s,r) => s + (r.completed_di || 0), 0) : (d.completed_di || 0);
        const pct = d_total_di > 0 ? Math.round((d_completed_di / d_total_di) * 100) : 0;

        // ── EP KPI Row (replaces global kpiRow on EP page) ────────────
        const support_pct  = kpi ? Math.round(kpi.support_pct  || 0) : 0;
        const testpkg_pct  = kpi ? Math.round(kpi.testpkg_pct  || 0) : 0;
        const support_comp = kpi ? (kpi.support_comp  || 0) : 0;
        const support_tot  = kpi ? (kpi.support_total || 0) : 0;
        const test_comp    = kpi ? (kpi.testpkg_comp  || 0) : 0;
        const test_tot     = kpi ? (kpi.testpkg_total || 0) : 0;
        const readiness_pct = Math.round(pct * 0.7 + support_pct * 0.2 + testpkg_pct * 0.1);

        const _setKpi = (id, val) => { const el=document.getElementById(id); if(el) el.textContent=val; };
        const _setCol = (id, col) => { const el=document.getElementById(id); if(el) el.style.color=col; };

        _setKpi("ep-kpi-readiness", `${readiness_pct}%`);
        _setCol("ep-kpi-readiness", pctColor(readiness_pct));
        _setKpi("ep-kpi-readiness-sub", `PIPING ${pct}% · SUP ${support_pct}% · TEST ${testpkg_pct}%`);
        const rBar = document.getElementById("ep-kpi-readiness-bar");
        if(rBar) { rBar.style.width = `${Math.min(readiness_pct,100)}%`; rBar.style.background = pctColor(readiness_pct); }

        _setKpi("ep-kpi-piping", `${pct}%`);
        _setCol("ep-kpi-piping", pctColor(pct));
        _setKpi("ep-kpi-piping-sub", `${fmtNum(d_completed_di,2)} / ${fmtNum(d_total_di,2)} DI · ${(d.completed_joints||0).toLocaleString()} joints`);

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
            _setKpi("ep-kpi-week",     fmtNum(lastEpWk.completed_di, 2));
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
                ["EP PIPING",       `${fmtNum(d_completed_di,2)} / ${fmtNum(d_total_di,2)}`],
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
                    <td style="${td}">${fmtNum(tot,2)}</td>
                    <td style="${td};color:var(--green)">${fmtNum(comp,2)}</td>
                    <td style="${td};color:${rem>0?"var(--orange)":"var(--green)"}">${fmtNum(rem,2)}</td>
                    <td style="${td};color:${c}">${p}%</td>
                </tr>`;
            }).join("");
            if(!showTotal) return rowHtml;
            const totRem = sumT-sumC, totP = sumT>0?Math.round(sumC/sumT*100):0, totC=pctColor(totP);
            return rowHtml + `<tr style="background:rgba(37,99,235,0.07);border-top:2px solid var(--border);font-weight:700">
                <td style="${td};text-align:left;color:var(--accent)">TOTAL</td>
                <td style="${td}">${fmtNum(sumT,2)}</td>
                <td style="${td};color:var(--green)">${fmtNum(sumC,2)}</td>
                <td style="${td};color:${totRem>0?"var(--orange)":"var(--green)"}">${fmtNum(totRem,2)}</td>
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
async function loadDailyTrend() {
    try {
        const res = await apiFetch("/api/daily-actuals");
        const data = res.data || [];
        const weekNo = res.week_no;
        const wkStart = res.week_start, wkEnd = res.week_end;

        const titleEl = document.getElementById("dailyTrendTitle");
        if (titleEl) {
            const label = weekNo ? `W${weekNo} Daily Trend` : "Daily Trend";
            const range = wkStart && wkEnd ? ` (${wkStart.slice(5)} ~ ${wkEnd.slice(5)})` : "";
            titleEl.textContent = label + range;
        }

        destroyChart("dailyTrend");
        if (!data.length) return;

        const labels = data.map(d => d.date.slice(5));
        charts["dailyTrend"] = new Chart(document.getElementById("dailyTrend").getContext("2d"), {
            type: "line",
            data: { labels, datasets: [
                { label: "Actual DI", data: data.map(d => d.completed_di),
                  borderColor: "#2563eb", borderWidth: 2.5, pointRadius: 6,
                  pointBackgroundColor: "#22d3a1", pointBorderColor: "#fff", pointBorderWidth: 2,
                  tension: 0.2,
                  datalabels: { display: true, align: "top", offset: 5, color: "#60a5fa",
                    font: { size: 10, weight: "700", family: "DM Mono, monospace" },
                    formatter: v => v > 0 ? fmtNum(v, 0) : "" }
                }
            ]},
            options: { ...chartOpts("DI"), plugins: { ...chartOpts("DI").plugins, legend: { display: false } } }
        });
    } catch(e) { console.warn("Daily trend failed", e); }
}

async function loadWeekly() {
    loadDailyTrend();
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
                <td style="color:var(--accent)">${fmtNum(comp,0)}</td>
            </tr>`;
        }).join("");
        html+=`<tr style="background:rgba(37,99,235,0.07);border-top:2px solid var(--border)">
            <td style="font-weight:700;color:var(--accent)">Total</td><td></td>
            <td style="font-weight:700">${fmtNum(totalFab,0)}</td>
            <td style="font-weight:700">${fmtNum(totalErect,0)}</td>
            <td style="font-weight:700;color:var(--accent)">${fmtNum(totalComp,0)}</td>
        </tr>`;
        tbody.innerHTML=html;

        // Breakdown panels — 5-min client cache to reduce repeated requests
        try {
            const _now = Date.now();
            if (!loadWeekly._bdCache || (_now - loadWeekly._bdCacheTime > 300000)) {
                const _bdRes = await fetch("/api/weekly-last-breakdown");
                if (!_bdRes.ok) throw new Error(`HTTP ${_bdRes.status}`);
                const _bdJson = await _bdRes.json();
                if (_bdJson.error) throw new Error(_bdJson.error);
                loadWeekly._bdCache = _bdJson;
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
        document.getElementById("jm-count").textContent=`Total ${(res.count||0).toLocaleString()} rows`;
        _renderPageNums("jm-page-nav", jmCurrentPage, res.count||0, JM_PAGE_SIZE, "jmGoto");

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
    if(!dateVal){toast("날짜를 선택하세요","error");return;}
    {const _today=new Date().toISOString().slice(0,10);if(dateVal>_today){toast("Future dates are not allowed (today: "+_today+")","error");return;}}
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

function jmGoto(page){jmCurrentPage=Math.max(0,page);loadJointMaster();}
function jmPage(dir){jmGoto(jmCurrentPage+dir);}

function renderJMTable(rows){
    const tbody=document.getElementById("jmBody");
    tbody.innerHTML=rows.map(r=>{
        const dStr=r.date_completed?r.date_completed.substring(0,10):"";
        const wVal=r.welder||"";
        const phaseVal=r.phase||"";
        const pkgVal=r.package||"";
        return `<tr id="jmrow-${r.id}">
            <td style="display:none">${r.id}</td>
            <td style="padding:2px"><input class="cell-input" id="phase-${r.id}" type="text" value="${phaseVal}" style="width:100%;text-align:center;padding:2px 4px"></td>
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
            <td style="padding:2px;text-align:center"><input class="cell-input${dStr?'':' date-empty'}" id="date-${r.id}" type="date" value="${dStr}" style="width:100%;text-align:center;padding:2px 2px;cursor:pointer" onchange="this.classList.toggle('date-empty',!this.value)"></td>
            <td>
                <select class="cell-input" id="inspection-${r.id}" style="text-align:center;text-align-last:center;padding:2px 2px">
                    <option value="">-</option>
                    <option value="VT" ${r.inspection==='VT'?'selected':''}>VT</option>
                    <option value="MT" ${r.inspection==='MT'?'selected':''}>MT</option>
                    <option value="PT" ${r.inspection==='PT'?'selected':''}>PT</option>
                    <option value="RT" ${r.inspection==='RT'||r.inspection==='VT/RT'?'selected':''}>VT/RT</option>
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
                <button type="button" class="btn-save-row" onclick="saveJointDate(${r.id})">Save</button>
                <button type="button" class="btn-clear-row" onclick="clearJointDate(${r.id})">Clear</button>
                <button type="button" class="btn-del-row" onclick="deleteJoint(${r.id})" title="Delete">DEL</button>
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
const NDE_PAGE_SIZE=30;
let ndeData=[];

async function loadNdePwht() {
    const unit=document.getElementById("nde-unit")?.value||"", system=document.getElementById("nde-system")?.value||"";
    const isoVal=document.getElementById("nde-iso")?.value?.trim()||"";
    const inspVal=document.getElementById("nde-insp")?.value||"";
    const welderVal=document.getElementById("nde-welder")?.value?.trim()||"";
    const offset=ndeCurrentPage*NDE_PAGE_SIZE;
    try {
        const params=new URLSearchParams({limit:NDE_PAGE_SIZE,offset,nde_only:"true"});
        if(unit)params.set("unit",unit); if(system)params.set("system",system);
        if(isoVal)params.set("iso",isoVal);
        if(inspVal)params.set("inspection",inspVal);
        if(welderVal)params.set("welder",welderVal);
        const res=await apiFetch(`/api/joints?${params}`);
        ndeData=res.data;
        document.getElementById("nde-count").textContent=`Total ${(res.count||0).toLocaleString()} rows`;
        _renderPageNums("nde-page-nav", ndeCurrentPage, res.count||0, NDE_PAGE_SIZE, "ndeGoto");

        renderNdeTable(ndeData);
    } catch(e) { console.error("NDE load failed",e); }
}

function ndeGoto(page){ndeCurrentPage=Math.max(0,page);loadNdePwht();}
function ndePage(dir){ndeGoto(ndeCurrentPage+dir);}

function renderNdeTable(rows){
    const tbody=document.getElementById("ndeBody");
    tbody.innerHTML=rows.map(r=>{
        const pt_date = r.pt_date ? r.pt_date.substring(0,10) : "";
        const mt_date = r.mt_date ? r.mt_date.substring(0,10) : "";
        const rt_date = r.rt_date ? r.rt_date.substring(0,10) : "";
        const pwht_date = r.pwht_date ? r.pwht_date.substring(0,10) : "";
        
        return `<tr id="nderow-${r.id}">
            <td style="text-align:center" title="${r.iso_drawing||""}">${r.iso_drawing||""}</td>
            <td style="text-align:center">${r.rev||""}</td>
            <td style="text-align:center">${r.joint_no||""}</td>
            <td style="text-align:center" title="${r.welder||""}">${r.welder||""}</td>
            <td style="text-align:center;font-weight:700;color:var(--accent)">${r.inspection||""}</td>
            
            <td style="text-align:center;border-right:none;padding:3px 2px;"><input type="text" class="cell-input" id="nde-pt-date-${r.id}" value="${pt_date}" placeholder="YY-MM-DD" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px"></td>
            <td style="text-align:center;border-left:none;padding-left:2px;">
                <select class="cell-input" id="nde-pt-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;">
                    <option value="">-</option>
                    <option value="PASS" ${r.pt_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.pt_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            
            <td style="text-align:center;border-right:none;padding:3px 2px;"><input type="text" class="cell-input" id="nde-mt-date-${r.id}" value="${mt_date}" placeholder="YY-MM-DD" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px"></td>
            <td style="text-align:center;border-left:none;padding-left:2px;">
                <select class="cell-input" id="nde-mt-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;">
                    <option value="">-</option>
                    <option value="PASS" ${r.mt_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.mt_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            
            <td style="text-align:center;border-right:none;padding:3px 2px;${r.rt_result==='FAIL'?'background:rgba(239,68,68,0.15);':''}"><input type="text" class="cell-input" id="nde-rt-date-${r.id}" value="${rt_date}" placeholder="YY-MM-DD" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px"></td>
            <td style="text-align:center;border-left:none;padding-left:2px;border-right:none;padding-right:2px;${r.rt_result==='FAIL'?'background:rgba(239,68,68,0.15);':''}"> 
                <select class="cell-input" id="nde-rt-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;${r.rt_result==='FAIL'?'color:#ef4444;font-weight:700;':''}">
                    <option value="">-</option>
                    <option value="PASS" ${r.rt_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.rt_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            <td style="text-align:center;border-left:none;padding-left:2px;border-right:none;padding-right:2px;">
                <select class="cell-input" id="nde-rt-find-${r.id}" style="width:100%;text-align:center;text-align-last:center;">
                    <option value="">-</option>
                    <option value="POR" ${r.rt_finding==='POR'  ?'selected':''}>POR (Porosity)</option>
                    <option value="SLAG" ${r.rt_finding==='SLAG' ?'selected':''}>SLAG (Slag Incl.)</option>
                    <option value="LF" ${r.rt_finding==='LF'   ?'selected':''}>LF (Lack of Fusion)</option>
                    <option value="IP" ${r.rt_finding==='IP'   ?'selected':''}>IP (Incomplete Pen.)</option>
                    <option value="IC" ${r.rt_finding==='IC'   ?'selected':''}>IC (Internal Concavity)</option>
                    <option value="UC" ${r.rt_finding==='UC'   ?'selected':''}>UC (Undercut)</option>
                    <option value="OL" ${r.rt_finding==='OL'   ?'selected':''}>OL (Overlap)</option>
                    <option value="BT" ${r.rt_finding==='BT'   ?'selected':''}>BT (Burn Through)</option>
                    <option value="HB" ${r.rt_finding==='HB'   ?'selected':''}>HB (Hollow Bead)</option>
                    <option value="TI" ${r.rt_finding==='TI'   ?'selected':''}>TI (Tungsten Incl.)</option>
                    <option value="CRACK" ${r.rt_finding==='CRACK'?'selected':''}>CRACK</option>
                    <option value="MULTI" ${r.rt_finding==='MULTI'?'selected':''}>MULTI (Multiple)</option>
                </select>
            </td>
            <td style="text-align:center;border-left:none;padding-left:2px;border-right:none;padding-right:2px;background:rgba(59,130,246,0.07)"><input type="text" class="cell-input" id="nde-rt-2-date-${r.id}" value="${r.rt_2_date?r.rt_2_date.substring(0,10):''}" placeholder="YY-MM-DD" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px"></td>
            <td style="text-align:center;border-left:none;padding-left:2px;background:rgba(59,130,246,0.07)">
                <select class="cell-input" id="nde-rt-2-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;">
                    <option value="">-</option>
                    <option value="PASS" ${r.rt_2_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.rt_2_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>

            <td style="text-align:center;border-right:none;padding:3px 2px;"><input type="text" class="cell-input" id="nde-pwht-date-${r.id}" value="${pwht_date}" placeholder="YY-MM-DD" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px"></td>
            <td style="text-align:center;border-left:none;padding-left:2px;">
                <select class="cell-input" id="nde-pwht-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;">
                    <option value="">-</option>
                    <option value="PASS" ${r.pwht_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.pwht_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            <td style="text-align:center">
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
        rt_finding: document.getElementById(`nde-rt-find-${id}`).value || null,
        rt_2_date: document.getElementById(`nde-rt-2-date-${id}`).value.trim() || null,
        rt_2_result: document.getElementById(`nde-rt-2-res-${id}`).value,
        pwht_date: document.getElementById(`nde-pwht-date-${id}`).value.trim() || null,
        pwht_result: document.getElementById(`nde-pwht-res-${id}`).value
    };

    // Date normalization
    ['pt_date', 'mt_date', 'rt_date', 'rt_2_date', 'pwht_date'].forEach(k => {
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
        fetch("/api/cache/clear").catch(()=>{});
        toast(`✓ Joint ID ${id} deleted`);
        loadJointMaster();
    }catch(e){toast("✗ Failed to delete","error");}
}

async function clearJointDate(id){
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({date_completed:null, welder:null, inspection:null, pwht:null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        // 화면 초기화
        const dateEl=document.getElementById(`date-${id}`);       if(dateEl){dateEl.value='';dateEl.classList.add('date-empty');}
        const weldEl=document.getElementById(`welder-${id}`);     if(weldEl)weldEl.value='';
        const inspEl=document.getElementById(`inspection-${id}`); if(inspEl)inspEl.value='';
        const pwhtEl=document.getElementById(`pwht-${id}`);       if(pwhtEl)pwhtEl.value='';
        toast(`✓ ID ${id} cleared`);
        const joint=jmData.find(j=>j.id===id);
        if(joint){
            if(_dashData?.kpi&&joint.date_completed){
                const di=parseFloat(joint.di||0);
                if(di>0){
                    _dashData.kpi.completed_di=Math.max(0,(_dashData.kpi.completed_di||0)-di);
                    _dashData.kpi.remaining_di=(_dashData.kpi.remaining_di||0)+di;
                    const total=_dashData.kpi.total_plan_di||0;
                    if(total>0)_dashData.kpi.overall_pct=Math.round(_dashData.kpi.completed_di/total*10000)/100;
                    renderKPI(_dashData.kpi,_dashData.weekly);
                }
            }
            joint.date_completed=null; joint.welder=null; joint.inspection=null; joint.pwht=null;
        }
        _refreshAfterSave();  // 서버 캐시 재빌드 + 전체 KPI/차트 갱신
    }catch(e){toast(`✗ Clear failed: ${e.message}`,"error");}
}

async function saveJointDate(id){
    let val=document.getElementById(`date-${id}`)?.value?.trim()||'';
    let welder=document.getElementById(`welder-${id}`)?.value?.trim()||'';
    let phase=document.getElementById(`phase-${id}`)?.value?.trim()||'';
    let pkg=document.getElementById(`pkg-${id}`)?.value?.trim()||'';
    let inspection=document.getElementById(`inspection-${id}`)?.value?.trim()||'';
    let pwht=document.getElementById(`pwht-${id}`)?.value?.trim()||'';
    if(val && !/^\d{4}-\d{2}-\d{2}$/.test(val)){toast("Invalid date format","error");return;}
    if(val){const _today=new Date().toISOString().slice(0,10);if(val>_today){toast("Future dates are not allowed (today: "+_today+")","error");return;}}
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:val||null, welder:welder||null, phase:phase||null, package:pkg||null, inspection:inspection||null, pwht:pwht||null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        toast(`✓ ID ${id} saved!`);
        // jmData 전체 필드 동기화 (re-render 시 stale 방지)
        const joint = jmData.find(j => j.id === id);
        if (joint) {
            const wasCompleted = !!joint.date_completed;
            const nowCompleted  = !!val;
            joint.date_completed = val || null;
            joint.welder     = welder     || null;
            joint.inspection = inspection || null;
            joint.pwht       = pwht       || null;
            joint.phase      = phase      || null;
            joint.package    = pkg        || null;
            // KPI optimistic update (즉각 반영)
            if (_dashData?.kpi) {
                const di = parseFloat(joint.di || 0);
                if (di > 0 && wasCompleted !== nowCompleted) {
                    const sign = nowCompleted ? 1 : -1;
                    _dashData.kpi.completed_di  = Math.max(0, (_dashData.kpi.completed_di  || 0) + sign * di);
                    _dashData.kpi.remaining_di  = Math.max(0, (_dashData.kpi.remaining_di  || 0) - sign * di);
                    const total = _dashData.kpi.total_plan_di || 0;
                    if (total > 0) _dashData.kpi.overall_pct = Math.round(_dashData.kpi.completed_di / total * 10000) / 100;
                    renderKPI(_dashData.kpi, _dashData.weekly);
                }
            }
        }
        _refreshAfterSave();  // 서버 캐시 재빌드 + 전체 KPI/차트 갱신
    }catch(e){toast(`✗ Save failed: ${e.message}`,"error");}
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

// weekly-actuals 병합: DOMContentLoaded 초기 로드 + 저장 후 갱신 시 공통 사용
async function _applyWeeklyActuals() {
    if (!_dashData) return;
    try {
        const wa = await fetch("/api/weekly-actuals", {cache:"no-store"}).then(r => r.json());
        if (!Array.isArray(wa) || !wa.length) return;
        const waMap = {};
        wa.forEach(w => { if (w.week_no) waMap[w.week_no] = w; });
        (_dashData.weekly || []).forEach(w => {
            const m = waMap[w.week_no];
            if (m) {
                w.completed_di = m.completed_di || w.completed_di;
                w.fab_di       = m.fab_di       || w.fab_di;
                w.erect_di     = m.erect_di     || w.erect_di;
            }
        });
        // v17에 없는 주차 추가
        const existing = new Set((_dashData.weekly||[]).map(w=>w.week_no));
        wa.forEach(w => {
            if (!w.week_label) w.week_label = 'W' + w.week_no;
            if (!existing.has(w.week_no)) _dashData.weekly.push(w);
        });
        _dashData.weekly.sort((a,b)=>a.week_no-b.week_no);
        // cumul_actual 재계산
        let _cum = 0;
        _dashData.weekly.forEach(w => {
            _cum += (w.completed_di || 0);
            w.cumul_actual = Math.round(_cum * 100) / 100;
        });
        renderKPI(_dashData.kpi, _dashData.weekly);
        const _visPage = document.querySelector(".page:not(.hidden)")?.id?.replace("page-","");
        if (_visPage === "overview" || !_visPage) renderOverview(_dashData.kpi, _dashData.weekly, _dashData.units, _dashData.systems);
        else if (_visPage === "weekly")      loadWeekly();
        else if (_visPage === "early_power") loadEarlyPower();
    } catch(e) { console.warn("[weekly-actuals]", e); }
}

let _refreshPending = false;

async function _refreshAfterSave() {
    if (_refreshPending) return;
    _refreshPending = true;
    try {
        await fetch("/api/cache/clear").catch(() => {});
        const fresh = await getDashData(true);
        _dashData = fresh;
        renderKPI(fresh.kpi, fresh.weekly);
        const visPage = document.querySelector(".page:not(.hidden)")?.id?.replace("page-", "");
        if (visPage) navigate(visPage);
    } catch(e) { console.warn("[refresh-after-save]", e); }
    finally { _refreshPending = false; }
}

// 하위 호환 alias
function _autoRefreshKpi() { _refreshAfterSave(); }

// ================================================================================
//  CHART HELPERS / PAGINATION
// ================================================================================
function _renderPageNums(containerId, curPage, totalRows, pageSize, gotoFn) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!totalRows || totalRows <= pageSize) { el.innerHTML = ""; return; }
    const totalPages = Math.ceil(totalRows / pageSize);
    const cur1 = curPage + 1;  // 1-based current page

    // Build visible page set: always include 1, last, and cur±2
    const pageSet = new Set([1, totalPages]);
    for (let p = Math.max(1, cur1 - 2); p <= Math.min(totalPages, cur1 + 2); p++) pageSet.add(p);
    const sorted = [...pageSet].sort((a, b) => a - b);

    const btnStyle = (active) => active
        ? "background:var(--accent);color:#fff;font-weight:700;min-width:28px;padding:3px 7px;border-radius:5px;border:none;cursor:pointer;font-size:12px"
        : "background:rgba(255,255,255,0.06);color:var(--text-dim);min-width:28px;padding:3px 7px;border-radius:5px;border:1px solid var(--border);cursor:pointer;font-size:12px";

    let html = `<button style="${btnStyle(false)}" ${cur1===1?'disabled':''} onclick="${gotoFn}(${curPage-1})">&#8249;</button>`;
    let prev = 0;
    for (const p of sorted) {
        if (p - prev > 1) html += `<span style="color:var(--text-dim);padding:0 2px;font-size:12px">…</span>`;
        html += `<button style="${btnStyle(p===cur1)}" onclick="${gotoFn}(${p-1})">${p}</button>`;
        prev = p;
    }
    html += `<button style="${btnStyle(false)}" ${cur1===totalPages?'disabled':''} onclick="${gotoFn}(${curPage+1})">&#8250;</button>`;
    el.innerHTML = html;
}

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
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);return true;
}

async function exportSystemBreakdown() {
    if (!_dashData?.systems?.length) { toast("No system data", "error"); return; }
    const rows = _dashData.systems.map(s => {
        const pipPlan = s.total_di || s.plan_di || 0;
        const pipDone = s.completed_di || 0;
        const supTot  = s.support_total || 0;
        const supDone = s.support_comp  || 0;
        const tstTot  = s.testpkg_total || 0;
        const tstDone = s.testpkg_comp  || 0;
        const totPct  = parseFloat((s.unified_readiness || ((s.progress_pct||0)*0.7 + (s.support_pct||0)*0.2 + (s.testpkg_pct||0)*0.1)).toFixed(2));
        return {
            "System": s.system || "",
            "Plan - Piping": pipPlan, "Plan - Support": supTot, "Plan - Test": tstTot,
            "Done - Piping": pipDone, "Done - Support": supDone, "Done - Test": tstDone,
            "Remaining - Piping": Math.max(0, pipPlan-pipDone), "Remaining - Support": Math.max(0, supTot-supDone), "Remaining - Test": Math.max(0, tstTot-tstDone),
            "Progress - Piping %": s.progress_pct||0, "Progress - Support %": s.support_pct||0, "Progress - Test %": s.testpkg_pct||0,
            "Total Progress %": totPct
        };
    });
    const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SystemBreakdown");
    const ok = await downloadWithPicker(wb, "System_Breakdown_Export.xlsx");
    if (ok) toast("✓ System breakdown exported");
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
    const formData = new FormData();
    formData.append("file", file);
    try {
        const res = await fetch("/api/joints/import", { method: "POST", body: formData });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        const msg = `✓ Imported ${data.inserted} rows${data.skipped > 0 ? ` (${data.skipped} skipped)` : ""}`;
        toast(msg);
        fileInput.value = "";
        _autoRefreshKpi();
        setTimeout(() => loadJointMaster(), 2000);
    } catch(e) {
        toast(`✗ Import failed: ${e.message}`, "error");
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

// Helper: render one half of a welder table (No / Welder ID / Joint / Fab DI / Erect DI / Total DI / Avg DI/Day)
function _welderHalfRows(rows, startIdx, accentColor) {
    if (!rows.length) return "";
    return rows.map((r, i) => `<tr>
        <td style="text-align:center;color:var(--text-dim)">${startIdx + i + 1}</td>
        <td style="color:${accentColor}">${r.welder}</td>
        <td style="text-align:right;font-family:'DM Mono',monospace">${fmtNum(r.joints, 1)}</td>
        <td style="text-align:right;font-family:'DM Mono',monospace;color:#94a3b8">${r.fab_di != null ? fmtNum(r.fab_di, 1) : "—"}</td>
        <td style="text-align:right;font-family:'DM Mono',monospace;color:#94a3b8">${r.erect_di != null ? fmtNum(r.erect_di, 1) : "—"}</td>
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
    const empty = `<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:16px">No data</td></tr>`;
    if (bA) bA.innerHTML = half1.length ? _welderHalfRows(half1, 0, accentColor) : empty;
    if (bB) bB.innerHTML = half2.length ? _welderHalfRows(half2, mid, accentColor) : "";
}

// Helper: build a compact table HTML for last-active-week/month split
function _welderSubTable(rows, startIdx, accentColor) {
    return `<table class="data-table" style="font-size:11px;width:100%">
        <thead><tr>
          <th style="min-width:42px;width:42px">No</th><th>Welder ID</th>
          <th style="text-align:right">Joint</th>
          <th style="text-align:right">Fab DI</th>
          <th style="text-align:right">Erect DI</th>
          <th style="text-align:right">Total DI</th>
          <th style="text-align:right">Avg DI/Day</th>
        </tr></thead>
        <tbody>${_welderHalfRows(rows, startIdx, accentColor)}</tbody>
    </table>`;
}

function renderWelder(data, dashData) {
    const s = data.stats || {};
    const ranking = data.ranking || [];
    const totalFab   = ranking.reduce((sum, r) => sum + (r.fab_di   || 0), 0);
    const totalErect = ranking.reduce((sum, r) => sum + (r.erect_di || 0), 0);
    const _setW = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    _setW("welder-active",   s.active_welders || 0);
    _setW("welder-fab-di",   fmtNum(totalFab,   0));
    _setW("welder-erect-di", fmtNum(totalErect, 0));
    _setW("welder-total-di", fmtNum(s.total_di, 0));
    const avgDiDay = ranking.length
        ? ranking.reduce((sum, r) => sum + (r.avg_di_per_day || 0), 0) / ranking.length
        : 0;
    document.getElementById("welder-avg-di").textContent = fmtNum(avgDiDay, 2);

    // Overall Week Actual: last active week DI from welder weekly data
    const weekDiEl = document.getElementById("welder-week-di");
    if (weekDiEl) {
        const wkData = data.weekly || [];
        const actWks = wkData.filter(w => (w.total_di || 0) > 0);
        const lastWk = actWks[actWks.length - 1];
        weekDiEl.textContent = lastWk ? fmtNum(lastWk.total_di, 0) : "—";
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

    // ── Weekly chart: 마지막 활성 주차 기준 6주 프레임 ──────────────────────────
    destroyChart("welderTrendChart");
    const trendEl = document.getElementById("welderTrendChart");
    const weeklyAll = (data.weekly || []).filter(w => w.week_no > 0 && w.week_no < 1000);
    weeklyAll.sort((a, b) => a.week_no - b.week_no);
    const wkSlice = weeklyAll.slice(-6).map(w => ({
        ...w,
        week_label: /^\d{4}-W/.test(w.week_label) ? ("W" + w.week_no) : (w.week_label || "W" + w.week_no)
    }));
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
                        barPercentage: 0.6,
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
                        barPercentage: 0.6,
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
const SM_PAGE_SIZE = 30;
let _smPhaseSynced = false;

async function loadSupportMaster() {
    // 세션 첫 로드 시 ISO Drawing 기준으로 Phase/Package 자동 매칭 (백그라운드)
    if (!_smPhaseSynced) {
        _smPhaseSynced = true;
        fetch("/api/support-master/sync-phase-package", {method: "POST"})
            .then(r => r.json())
            .then(d => { if (d.ok && d.updated > 0) loadSupportMaster(); })
            .catch(() => {});
    }
    const unit    = document.getElementById("sm-unit")?.value    || "";
    const system  = document.getElementById("sm-system")?.value  || "";
    const subarea = document.getElementById("sm-subarea")?.value || "";
    const status  = document.getElementById("sm-status")?.value  || "";
    const phase   = document.getElementById("sm-phase")?.value   || "";
    const pkg     = document.getElementById("sm-package")?.value?.trim() || "";
    const iso     = document.getElementById("sm-iso")?.value?.trim() || "";
    const offset  = smCurrentPage * SM_PAGE_SIZE;

    try {
        const params = new URLSearchParams({limit: SM_PAGE_SIZE, offset});
        if (unit)    params.set("unit",     unit);
        if (system)  params.set("system",   system);
        if (subarea) params.set("sub_area", subarea);
        if (status)  params.set("status",   status);
        if (phase)   params.set("phase",    phase);
        if (pkg)     params.set("package",  pkg);
        if (iso)     params.set("iso",      iso);
        
        const res = await apiFetch(`/api/support-master?${params}`);
        smData = res.data;
        document.getElementById("sm-count").textContent = `Total ${(res.count||0).toLocaleString()} rows`;
        _renderPageNums("sm-page-nav", smCurrentPage, res.count||0, SM_PAGE_SIZE, "smGoto");

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
    {const _today=new Date().toISOString().slice(0,10);if(dateVal>_today){toast("Future dates are not allowed (today: "+_today+")","error");return;}}

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

function smGoto(page) { smCurrentPage = Math.max(0, page); loadSupportMaster(); }
function smPage(dir) { smGoto(smCurrentPage + dir); }

function renderSMTable(rows) {
    const tbody = document.getElementById("smBody");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;color:var(--text-dim);padding:20px">No data. Add items or import from Excel.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const dc = r.date_completed ? r.date_completed.substring(0,10) : "";
        return `<tr id="smrow-${r.id}">
          <td>${r.id}</td>
          <td style="padding:2px"><input class="cell-input" id="sm-phase-${r.id}" type="text" value="${r.phase||""}" style="width:100%;text-align:center;padding:2px 4px"></td>
          <td><input class="cell-input" id="sm-pkg-${r.id}" type="text" value="${r.package||""}" style="text-align:center"></td>
          <td>${r.unit||""}</td>
          <td>${r.system||""}</td>
          <td>${r.area||""}</td>
          <td>${r.sub_area||""}</td>
          <td>${r.support_drawing||""}</td>
          <td>${r.revision||""}</td>
          <td style="font-size:11px;font-family:'DM Mono',monospace;word-break:break-all" title="${r.iso_drawing||""}">${r.iso_drawing||""}</td>
          <td>${r.line_no||""}</td>
          <td><input class="cell-input" id="sm-welder-${r.id}" type="text" value="${r.welder||""}"></td>
          <td style="padding:2px;text-align:center"><input class="cell-input" id="sm-date-${r.id}" type="text" value="${dc}" placeholder="YY-MM-DD" style="width:100%;text-align:center;padding:2px 4px"></td>
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
    let pkg     = document.getElementById(`sm-pkg-${id}`)?.value?.trim() || "";

    if (dateVal && !/^\d{2,4}-\d{2}-\d{2}$/.test(dateVal)) { toast("Invalid date (YY-MM-DD)", "error"); return; }
    if (dateVal && dateVal.length === 8) dateVal = "20" + dateVal;
    if (dateVal) { const _today=new Date().toISOString().slice(0,10); if(dateVal>_today){toast("Future dates are not allowed (today: "+_today+")","error");return;} }

    try {
        const r = await fetch(`/api/support-master/${id}`, {
            method: "PATCH", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({
                date_completed: dateVal || null,
                completed: !!dateVal,
                welder: welder || null,
                phase: phase || null,
                package: pkg || null
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
        package:         document.getElementById("sm-new-package")?.value?.trim() || null,
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
const TP_PAGE = 30;

async function loadTestPkgMaster() {
    const iso    = document.getElementById("tp-iso")?.value?.trim() || "";
    const pkg    = document.getElementById("tp-package")?.value?.trim() || "";
    const system = document.getElementById("tp-system")?.value  || "";
    const status = document.getElementById("tp-status")?.value  || "";
    const offset = tpCurrentPage * TP_PAGE;
    try {
        const tpSys = document.getElementById("tp-system");
        if (tpSys && tpSys.options.length <= 1) (metaData.systems||[]).forEach(s => tpSys.add(new Option(s,s)));

        const params = new URLSearchParams({limit: TP_PAGE, offset});
        if (iso)    params.set("iso",     iso);
        if (pkg)    params.set("package", pkg);
        if (system) params.set("system",  system);
        if (status) params.set("status",  status);
        const res = await apiFetch(`/api/testpkg-joints?${params}`);
        tpData = res.data;
        document.getElementById("tp-count").textContent = `Total ${(res.count||0).toLocaleString()} rows`;
        _renderPageNums("tp-page-nav", tpCurrentPage, res.count||0, TP_PAGE, "tpGoto");
        renderTPTable(tpData);
    } catch(e) { console.error("Test Pkg Master load failed", e); }
}

function tpGoto(page) { tpCurrentPage = Math.max(0, page); loadTestPkgMaster(); }
function tpPage(dir) { tpGoto(tpCurrentPage + dir); }

async function loadSystemPackages() {
    const system = document.getElementById("tp-system")?.value || "";
    const pkgSel = document.getElementById("tp-package");
    if (!pkgSel) return;
    pkgSel.innerHTML = '<option value="">All Packages</option>';
    if (!system) return;
    try {
        const pkgs = await apiFetch(`/api/packages?system=${encodeURIComponent(system)}`);
        if (Array.isArray(pkgs)) {
            pkgs.forEach(p => pkgSel.add(new Option(p, p)));
        }
    } catch(e) { console.warn("Package list load failed", e); }
}

function _tpResultBadge(result) {
    if (!result) return '<span style="color:var(--text-dim)">-</span>';
    const color = result === "PASS" ? "var(--green)" : "var(--orange)";
    return `<span style="font-weight:700;color:${color}">${result}</span>`;
}

function renderTPTable(rows) {
    const tbody = document.getElementById("tpBody");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="18" style="text-align:center;color:var(--text-dim);padding:20px">No data. Select a Package filter or click the Sync Phase/Pkg button.</td></tr>`;
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
        const insp = r.inspection || "";
        const inspColor = insp === "RT" ? "var(--orange)" : insp === "VT" ? "var(--accent)" : "var(--text-dim)";
        const inspLabel = insp === "RT" ? "VT/RT" : insp || "-";
        return `<tr id="tprow-${r.id}">
          <td style="text-align:center">${r.system||""}</td>
          <td style="font-weight:600;color:var(--indigo)">${r.package||""}</td>
          <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title="${r.iso_drawing||""}">${r.iso_drawing||""}</td>
          <td style="text-align:center">${r.joint_no||""}</td>
          <td style="text-align:center;color:var(--accent)">${weldDate||"-"}</td>
          <td style="text-align:center;font-weight:700;font-size:11px;color:${inspColor}">${inspLabel}</td>
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
          <td style="text-align:center;font-size:11px;${insp==="RT"?"background:rgba(249,115,22,0.07)":""}">${rtDate||"-"}</td>
          <td style="text-align:center;${insp==="RT"?"background:rgba(249,115,22,0.07)":""}">${_tpResultBadge(r.rt_result)}</td>
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
    if (vtDate && !/^\d{2,4}-\d{2}-\d{2}$/.test(vtDate)) { toast("VT Date: enter in YY-MM-DD format", "error"); return; }
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
    if (!confirm("Sync PHASE and PACKAGE from BOP Piping Joint Master.xlsx in the Raw File folder.\nDo you want to continue?")) return;
    toast("Syncing...");
    try {
        const r = await fetch("/api/joints/sync-phase-package", {method:"POST"});
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        toast(`✓ Sync complete: ${d.updated} joints updated (${d.rows_read} rows read)`);
        loadTestPkgMaster();
    } catch(e) { toast(`✗ Sync failed: ${e.message}`, "error"); }
}

async function syncSMPhasePackage() {
    if (!confirm("Support Master의 ISO Drawing으로 Joint Master에서 Phase/Package를 매칭합니다.\n계속하시겠습니까?")) return;
    toast("Syncing...", "info");
    try {
        const r = await fetch("/api/support-master/sync-phase-package", {method:"POST"});
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        toast(`✓ ${d.updated}건 업데이트 완료`);
        loadSupportMaster();
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

async function exportNDEExcel() {
    if (!ndeData || ndeData.length === 0) { toast("No NDE data to export", "error"); return; }
    const rows = ndeData.map(r => ({
        "ISO Drawing": r.iso_drawing || "",
        "Rev":         r.rev         || "",
        "Joint No":    r.joint_no    || "",
        "Welder":      r.welder      || "",
        "Inspection":  r.inspection  || "",
        "PT Date":     r.pt_date   ? r.pt_date.substring(0,10)   : "",
        "PT Result":   r.pt_result  || "",
        "MT Date":     r.mt_date   ? r.mt_date.substring(0,10)   : "",
        "MT Result":   r.mt_result  || "",
        "RT Date":     r.rt_date   ? r.rt_date.substring(0,10)   : "",
        "RT Result":   r.rt_result  || "",
        "RT Finding":  r.rt_finding || "",
        "RT 2nd Date": r.rt_2_date ? r.rt_2_date.substring(0,10) : "",
        "RT 2nd Res":  r.rt_2_result || "",
        "PWHT Date":   r.pwht_date ? r.pwht_date.substring(0,10) : "",
        "PWHT Result": r.pwht_result || ""
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "NDE_PWHT");
    const ok = await downloadWithPicker(wb, "NDE_PWHT_Export.xlsx");
    if (ok) toast("✓ NDE & PWHT exported");
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

// ================================================================================
//  TEST MASTER
// ================================================================================
let tmData = [], tmCurrentPage = 0;
const TM_PAGE = 50;

// 전체 패키지 목록 캐시 (System 필터용)
let _tmAllData = [];

async function loadTestMaster() {
    const system  = document.getElementById("tm-system")?.value  || "";
    const pkg     = document.getElementById("tm-package")?.value || "";
    const status  = document.getElementById("tm-status")?.value  || "";
    const offset  = tmCurrentPage * TM_PAGE;
    try {
        let url = `/api/testpkg-master?limit=${TM_PAGE}&offset=${offset}`;
        if (system) url += `&system=${encodeURIComponent(system)}`;
        if (pkg)    url += `&test_pkg_no=${encodeURIComponent(pkg)}`;
        if (status) url += `&status=${encodeURIComponent(status)}`;
        const res = await apiFetch(url);
        tmData = res.data || [];
        document.getElementById("tm-count").textContent = `Total ${(res.count||0).toLocaleString()} rows`;
        _renderTMPagination(tmCurrentPage, res.count || 0);
        renderTMTable(tmData);
        if (!_tmAllData.length) await _loadTMAllForFilters();
    } catch(e) { toast("Load failed: "+e.message, "error"); }
}

function _renderTMPagination(curPage, totalRows) {
    const el = document.getElementById("tm-page-nav");
    if (!el) return;
    el.innerHTML = "";
    if (!totalRows || totalRows <= TM_PAGE) return;
    const totalPages = Math.ceil(totalRows / TM_PAGE);
    const cur1 = curPage + 1;
    const pageSet = new Set([1, totalPages]);
    for (let p = Math.max(1, cur1 - 2); p <= Math.min(totalPages, cur1 + 2); p++) pageSet.add(p);
    const sorted = [...pageSet].sort((a, b) => a - b);
    const s  = "min-width:28px;padding:3px 7px;border-radius:5px;cursor:pointer;font-size:12px;";
    const sa = s + "background:var(--accent);color:#fff;font-weight:700;border:none;";
    const si = s + "background:rgba(255,255,255,0.06);color:var(--text-dim);border:1px solid var(--border);";
    const mk = (html, page, disabled, active) => {
        const b = document.createElement("button");
        b.innerHTML = html;
        b.style.cssText = active ? sa : si;
        if (disabled) { b.disabled = true; b.style.opacity = "0.3"; }
        else b.addEventListener("click", () => { tmCurrentPage = page; loadTestMaster(); });
        return b;
    };
    el.appendChild(mk("&#8249;", curPage - 1, cur1 === 1, false));
    let prev = 0;
    for (const p of sorted) {
        if (p - prev > 1) {
            const sp = document.createElement("span");
            sp.innerHTML = "…"; sp.style.cssText = "color:var(--text-dim);padding:0 2px;font-size:12px;";
            el.appendChild(sp);
        }
        el.appendChild(mk(String(p), p - 1, false, p === cur1));
        prev = p;
    }
    el.appendChild(mk("&#8250;", curPage + 1, cur1 === totalPages, false));
}

async function _loadTMAllForFilters() {
    try {
        const res = await apiFetch("/api/testpkg-master?limit=2000&offset=0");
        _tmAllData = res.data || [];
        _populateTMSystemFilter();
    } catch(e) {}
}

function tmGoto(p) { tmCurrentPage = p; loadTestMaster(); }
window.tmGoto = tmGoto;

function _populateTMSystemFilter() {
    const sel = document.getElementById("tm-system");
    if (!sel) return;
    const cur = sel.value;
    const systems = [...new Set(_tmAllData.map(r => r.system||"").filter(Boolean))].sort();
    sel.innerHTML = `<option value="">All Systems</option>` +
        systems.map(s => `<option value="${s}"${s===cur?" selected":""}>${s}</option>`).join("");
}

function tmOnSystemChange() {
    const system = document.getElementById("tm-system")?.value || "";
    const pkgSel = document.getElementById("tm-package");
    if (!pkgSel) return;
    const pkgs = [...new Set(
        _tmAllData
            .filter(r => !system || r.system === system)
            .map(r => r.test_pkg_no||"")
            .filter(Boolean)
    )].sort();
    pkgSel.innerHTML = `<option value="">All Packages</option>` +
        pkgs.map(p => `<option value="${p}">${p}</option>`).join("");
    tmCurrentPage = 0;
    loadTestMaster();
}

function renderTMTable(data) {
    const tbody = document.getElementById("tmBody");
    if (!tbody) return;
    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:20px;color:#64748b">데이터가 없습니다. "Sync from Pkg" 버튼으로 Pkg Master의 패키지를 불러오세요.</td></tr>`;
        return;
    }
    const iopt = v => v ? ` selected` : "";
    const cin  = "width:92%;text-align:center;color:#000;background:#fff";
    tbody.innerHTML = data.map((r, i) => {
        const dc  = r.date_completed ? r.date_completed.substring(0,10) : "";
        const res = r.completed ? "PASS" : (dc ? "FAIL" : "");
        const isReady = r.readiness === "Ready";
        const readinessBadge = isReady
            ? `<span style="color:#22d3a1;font-weight:700">Ready</span>`
            : `<span style="color:#f59e0b">Pending</span>`;
        const dateColor = dc ? "#000" : "transparent";
        return `<tr>
            <td style="text-align:center">${tmCurrentPage*TM_PAGE+i+1}</td>
            <td style="text-align:center">${r.system||"—"}</td>
            <td style="text-align:center;font-size:11px">${r.test_pkg_no||"—"}</td>
            <td style="text-align:center">${readinessBadge}</td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-dp-${r.id}" value="${r.design_pressure||""}" style="${cin}"></td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-tp-${r.id}" value="${r.test_pressure||""}" style="${cin}"></td>
            <td style="text-align:center">
                <select class="cell-input" id="tm-method-${r.id}" style="width:98%;text-align:center;color:#000;background:#fff">
                    <option value="" color="#000">-</option>
                    <option value="Pneumatic"  ${r.method==="Pneumatic" ?" selected":""} color="#000">Pneumatic</option>
                    <option value="Hydro"      ${r.method==="Hydro"     ?" selected":""} color="#000">Hydro</option>
                    <option value="In Service" ${r.method==="In Service"?" selected":""} color="#000">In Service</option>
                </select>
            </td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-media-${r.id}" value="${r.media||""}" style="${cin}"></td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-holding-${r.id}" value="${r.holding_time||""}" style="${cin}"></td>
            <td style="text-align:center"><input type="date" class="cell-input" id="tm-date-${r.id}" value="${dc}"
                style="width:100%;text-align:center;color:${dateColor};background:#fff"
                oninput="this.style.color=this.value?'#000':'transparent'"
                onchange="this.style.color=this.value?'#000':'transparent'"></td>
            <td style="text-align:center">
                <select class="cell-input" id="tm-result-${r.id}" style="width:90%;text-align:center;color:#000;background:#fff">
                    <option value=""${iopt(!res)} color="#000">-</option>
                    <option value="PASS"${iopt(res==="PASS")} color="#000">PASS</option>
                    <option value="FAIL"${iopt(res==="FAIL")} color="#000">FAIL</option>
                </select>
            </td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-remark-${r.id}" value="${r.remark||""}" style="${cin}"></td>
            <td style="text-align:center;white-space:nowrap">
                <button class="btn-save-row" onclick="saveTMRow(${r.id})">Save</button>
                <button class="btn-del-row"  onclick="deleteTMRow(${r.id})">Del</button>
            </td>
        </tr>`;
    }).join("");
}

async function saveTMRow(id) {
    const resultVal = document.getElementById(`tm-result-${id}`)?.value || "";
    const dateVal   = document.getElementById(`tm-date-${id}`)?.value   || "";
    const completed = resultVal === "PASS";
    const payload = {
        design_pressure: document.getElementById(`tm-dp-${id}`)?.value?.trim()     || null,
        test_pressure:   document.getElementById(`tm-tp-${id}`)?.value?.trim()     || null,
        method:          document.getElementById(`tm-method-${id}`)?.value          || null,
        media:           document.getElementById(`tm-media-${id}`)?.value?.trim()  || null,
        holding_time:    document.getElementById(`tm-holding-${id}`)?.value?.trim()|| null,
        date_completed:  dateVal || null,
        completed:       completed,
        remark:          document.getElementById(`tm-remark-${id}`)?.value?.trim() || null
    };
    try {
        const res = await fetch(`/api/testpkg-master/${id}`, {
            method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Save failed");
        toast("저장 완료");
        loadTestMaster();
    } catch(e) { toast(e.message, "error"); }
}

async function deleteTMRow(id) {
    if (!confirm("이 Test Package를 삭제하시겠습니까?")) return;
    try {
        const res = await fetch(`/api/testpkg-master/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Delete failed");
        toast("삭제 완료");
        loadTestMaster();
    } catch(e) { toast(e.message, "error"); }
}

async function syncTestMaster() {
    if (!confirm("Pkg Master의 패키지 목록을 Test Master에 자동 등록합니다.\n이미 등록된 패키지는 건너뜁니다. 계속하시겠습니까?")) return;
    try {
        const res  = await fetch("/api/testpkg-master/sync", { method: "POST" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Sync failed");
        toast(`Sync 완료: ${data.inserted}건 신규 등록 (전체 ${data.total}건)`);
        loadTestMaster();
    } catch(e) { toast(e.message, "error"); }
}

async function exportTMExcel() {
    if (!tmData?.length) { toast("No data", "error"); return; }
    const rows = tmData.map((r,i) => ({
        "No":               i+1,
        "System":           r.system           || "",
        "PACKAGE":          r.test_pkg_no      || "",
        "Design Pressure":  r.design_pressure  || "",
        "Test Pressure":    r.test_pressure    || "",
        "Method":           r.method           || "",
        "Media":            r.media            || "",
        "Holding Time":     r.holding_time     || "",
        "Date":             r.date_completed ? r.date_completed.substring(0,10) : "",
        "Result":           r.completed ? "PASS" : (r.date_completed ? "FAIL" : ""),
        "Remark":           r.remark           || ""
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "TestMaster");
    const ok = await downloadWithPicker(wb, "Test_Master_Export.xlsx");
    if (ok) toast("✓ Exported");
}
