// dashboard.js Full frontend logic  v7.29

// Chart.js 초기화 — defer 로드 순서 보장 (chart.js → datalabels → this)
if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
    Chart.register(ChartDataLabels);
    Chart.defaults.set('plugins.datalabels', { display: false });
}

// 인증 역할: null | 'editor' | 'admin'
window.authRole = null;

function applyAuthUI(role) {
  window.authRole = role;
  const isWrite = role === 'admin' || role === 'editor';
  const isAdmin = role === 'admin';
  document.querySelectorAll('.auth-write').forEach(el => {
    el.style.display = isWrite ? '' : 'none';
  });
  document.querySelectorAll('.auth-admin').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  const signInBtn = document.getElementById('signInBtn');
  const authBadge = document.getElementById('authUserBadge');
  const authLabel = document.getElementById('authUserLabel');
  if (signInBtn) signInBtn.style.display = role ? 'none' : '';
  if (authBadge) authBadge.style.display = role ? 'flex' : 'none';
  if (authLabel) authLabel.textContent = role ? ('👤 ' + role) : '';
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    applyAuthUI(data.role || null);
  } catch(e) {
    applyAuthUI(null);
  }
}

function openSignInModal() {
  document.getElementById('authUsername').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authError').style.display = 'none';
  const modal = document.getElementById('signInModal');
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('authUsername').focus(), 50);
}

function closeSignInModal() {
  document.getElementById('signInModal').style.display = 'none';
}

async function doLogin() {
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authError');
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username, password})
    });
    const data = await res.json();
    if (res.ok) {
      closeSignInModal();
      applyAuthUI(data.role);
    } else {
      errEl.textContent = 'Invalid credentials';
      errEl.style.display = 'block';
    }
  } catch(e) {
    errEl.textContent = 'Network error';
    errEl.style.display = 'block';
  }
}

async function doLogout() {
  await fetch('/api/auth/logout', {method: 'POST'});
  applyAuthUI(null);
}

const API = "";
let charts = {};

// ── 날짜 헬퍼 ──────────────────────────────────────────────────────────────────
// type=text 날짜 입력에 달력 팝업 연결. 선택 시 YY-MM-DD 표시, data-full-date에 YYYY-MM-DD 보관.
function _pickDate(el) {
    const rect = el.getBoundingClientRect();
    const p = document.createElement("input");
    p.type = "date";
    // opacity:0.01 — 거의 투명하지만 브라우저가 실체 요소로 인식해 달력 위치 계산 가능
    p.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;opacity:0.01;border:none;padding:0;margin:0;z-index:9999;cursor:pointer;`;
    if (el.dataset.fullDate) p.value = el.dataset.fullDate;
    document.body.appendChild(p);
    p.addEventListener("change", () => {
        if (p.value) {
            el.value = p.value.slice(2);
            el.dataset.fullDate = p.value;
            el.classList.remove("date-empty");
        }
        if (document.body.contains(p)) document.body.removeChild(p);
        el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    p.addEventListener("blur", () => {
        setTimeout(() => { if (document.body.contains(p)) document.body.removeChild(p); }, 300);
    });
    p.focus();
    try { p.showPicker(); } catch(e) { p.click(); }
}

// data-full-date(YYYY-MM-DD) 우선, 없으면 "20"+value(YY-MM-DD) 반환
function _fullDateVal(id) {
    const el = document.getElementById(id);
    if (!el || !el.value) return "";
    return el.dataset.fullDate || ("20" + el.value);
}
// ──────────────────────────────────────────────────────────────────────────────
let jmData = [];
let jmCurrentPage = 0;
const JM_PAGE_SIZE = 30;

let metaData = { units: [], systems: [] };

// ================================================================================
//  INIT
// ================================================================================
let _dashData = null;
let _epSupportData = null;
let _epSupportDataTime = 0;
let _drBreakdowns = {};
let _drSelectedDate = "";

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
                const estMin = elapsed < 60 ? "1-2 min" : elapsed < 150 ? "2-3 min" : "a bit longer";
                _updateLoader(`Server starting... ${elapsed}s · Estimated wait: ${estMin} (${i+1}/${MAX_ATTEMPTS})`);
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
    await checkAuthStatus();
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
          <div style="color:#7a95b8;font-size:11px;margin-top:6px;font-family:DM Mono,monospace">Cold start: takes about 3-4 min · please wait...</div>
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
          <div style="color:#4a6080;font-size:11px;margin-top:10px">Press F5 or use the button above to retry</div>
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
        const dataInputPages = ["joint_master", "support_master", "nde_pwht", "testpkg_master", "test_master", "welder", "rt_quality", "daily_report"];
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
        case "joint_master":
            if ((document.getElementById("jm-mat")?.options?.length||0) <= 1) {
                _loadJMFilterSel("jm-mat",  "mat",       "Material");
                _loadJMFilterSel("jm-size", "size_inch", "Size");
                _loadJMFilterSel("jm-pwht", "pwht",      "PWHT");
            }
            loadJointMaster(); break;
        case "welder":      loadWelder();       break;
        case "rt_quality":  loadRtQuality();    break;
        case "support_master": loadSupportMaster(); break;
        case "nde_pwht":    loadNdePwht();      break;
        case "testpkg_master": loadTestPkgMaster(); break;
        case "test_master":    loadTestMaster();    break;
        case "daily_report":   loadDailyReport();   break;

    }
}



// ================================================================================
//  API HELPERS
// ================================================================================
const _apiCache = new Map();   // url → {data, exp}
const _CACHE_TTL = 120_000;    // 2분 — 읽기전용 API 재사용 TTL
const _NO_CACHE_PATTERNS = ["/api/joints", "/api/support-master", "/api/testpkg-master", "/api/testpkg-joints", "/api/rt-quality"];

async function apiFetch(url, { noCache = false } = {}) {
    const useCache = !noCache && !_NO_CACHE_PATTERNS.some(p => url.startsWith(p));
    if (useCache) {
        const hit = _apiCache.get(url);
        if (hit && hit.exp > Date.now()) return hit.data;
    }
    const ts = new Date().getTime();
    const separator = url.includes("?") ? "&" : "?";
    const res = await fetch(API + url + separator + "_t=" + ts, { cache: "no-store" });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    if (useCache) _apiCache.set(url, { data, exp: Date.now() + _CACHE_TTL });
    return data;
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
async function _loadJMFilterSel(elId, col, placeholder) {
    const sel = document.getElementById(elId);
    if (!sel) return;
    try {
        const r = await apiFetch(`/api/joints/filter-values?col=${col}`);
        sel.innerHTML = `<option value="">${placeholder}</option>`;
        (r.values || []).forEach(v => {
            const lbl = col === "size_inch"
                ? (Number.isInteger(parseFloat(v)) ? parseInt(v) : parseFloat(v).toFixed(1))
                : v;
            sel.add(new Option(lbl, v));
        });
    } catch {}
}

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
        // MAT / SIZE 드롭다운 비동기 populate

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
    document.getElementById("kpi-overall").textContent     = `${weightedPct.toFixed(2)}%`;
    document.getElementById("kpi-bar").style.width = `${Math.min(weightedPct, 100)}%`;
    const weightSubEl = document.getElementById("kpi-overall-weight-sub");
    if (weightSubEl) weightSubEl.textContent = `PIPING 70% · SUPPORT 20% · TEST 10%`;

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
            gt.textContent = `${typeof p === 'number' ? p.toFixed(2) : p}%`;
            gt.style.fill  = p > 0 ? "#f97316" : "#6b7280";
        };

        // Piping Progress gauge
        _fillGauge("gaugePath", "gaugeText", d.overall_pct || 0);

        // Piping Progress stats
        const stats = document.getElementById("overviewStats");
        const _remDI = Math.max(0, (d.total_plan_di||0) - (d.completed_di||0));
        if (stats) stats.innerHTML = _mkStats([
            ["D/I Completion", `${(d.overall_pct||0).toFixed(2)}%`],
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
                ["Support Completion", `${sPct.toFixed(2)}%`],
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
                ["Test Pkg Completion", `${tPct.toFixed(2)}%`],
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
                        <td style="text-align:center;color:${pctColor(pipPct)}">${pipPct.toFixed(2)}%</td>
                        <td style="text-align:center;color:${pctColor(supPct)}">${supPct > 0 ? supPct.toFixed(2)+"%" : "—"}</td>
                        <td style="text-align:center;color:${pctColor(tstPct)}">${tstPct > 0 ? tstPct.toFixed(2)+"%" : "—"}</td>
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

        const dateBar = document.getElementById("scurveDateBar");
        if (dateBar && wkData.length > 0) {
            const fmt = d => d ? d.replace(/-/g, ".") : "—";
            const startDate = fmt(wkData[0].week_start);
            const midWk = wkData[Math.floor((wkData.length - 1) / 2)];
            const midDate = fmt(midWk.week_start);
            const lastWk = wkData[wkData.length - 1];
            const lastWithDate = [...wkData].reverse().find(w => w.week_end || w.week_start);
            const endDate = fmt(lastWk.week_end || lastWk.week_start || (lastWithDate && (lastWithDate.week_end || lastWithDate.week_start)));
            const item = (icon, label, date, align) =>
                `<span style="display:flex;flex-direction:column;align-items:${align};gap:1px;min-width:0">` +
                `<span style="font-size:9px;opacity:0.7;white-space:nowrap">${icon} ${label}</span>` +
                `<span style="font-size:10px;color:#2563eb;white-space:nowrap">${date}</span>` +
                `</span>`;
            dateBar.innerHTML =
                item("▶", "Start", startDate, "flex-start") +
                item("◆", "Mid",   midDate,   "center")     +
                item("◀", "End",   endDate,   "flex-end");
        }

        const scurveEl = document.getElementById("scurveChart");
        if (!scurveEl) { console.warn("[BOP] scurveChart canvas not found"); return; }
        charts["scurveChart"] = new Chart(scurveEl.getContext("2d"), {
            type: "bar",
            data: { labels: scurveLabels, datasets: [
                { label:"Weekly DI",   type:"bar",  yAxisID:"yBar", data:wkData.map(w=>w.completed_di||null), backgroundColor:"rgba(37,99,235,0.5)", borderColor:"#2563eb", borderWidth:1, borderRadius:2, barPercentage:0.8, order:3, datalabels:{display:false} },
                { label:"Plan S-Curve",type:"line", yAxisID:"yCum", data:planSCurve, borderColor:"rgba(255,82,82,0.55)", borderWidth:1.5, borderDash:[4,4], fill:false, pointRadius:0, pointHoverRadius:4, tension:0, order:2, datalabels:{display:false} },
                { label:"Actual Cum.", type:"line", yAxisID:"yCum", data:cumulLine,  borderColor:"#22d3a1", borderWidth:2, fill:false, pointRadius:0, pointHoverRadius:4, tension:0.3, order:1, spanGaps:false, datalabels:{display:false} }
            ]},
            options: { ...chartOpts("Weekly DI Progress"),
                scales: {
                    x:{ ...chartOpts("").scales.x, ticks:{...chartOpts("").scales.x.ticks,maxRotation:0,autoSkip:false,callback:function(val,index){if(index===0||index%5===4)return this.getLabelForValue(val);return "";}} },
                    yBar:{ type:"linear", position:"left",  beginAtZero:true, grid:{color:"rgba(255,255,255,0.05)"}, ticks:{color:"#4a6080",font:{size:9}}, title:{display:false} },
                    yCum:{ type:"linear", position:"right", beginAtZero:true, grid:{display:false}, ticks:{color:"#22d3a1",font:{size:9}}, title:{display:false} }
                },
                plugins:{...chartOpts("").plugins,legend:{display:true,position:'top',labels:{color:'#7a95b8',boxWidth:12,font:{size:10}}}}, animation:{duration:600} }
        });

        // 마지막 작업주 기준 Plan/Actual/Diff 공정률 표시
        const scurveKpiEl = document.getElementById("scurveKpi");
        if (scurveKpiEl) {
            if (lastActIdx >= 0 && totalPlanDI > 0) {
                const planPct  = planSCurve[lastActIdx] / totalPlanDI * 100;
                const actPct   = (cumulLine[lastActIdx] || 0) / totalPlanDI * 100;
                const diffPct  = actPct - planPct;
                const diffClr  = diffPct >= 0 ? "#60a5fa" : "#ef4444";
                const diffSign = diffPct >= 0 ? "+" : "";
                const wkLabel  = wkData[lastActIdx]?.week_label || `W${lastActIdx + 1}`;
                scurveKpiEl.innerHTML =
                    `<span style="opacity:0.55;font-size:9px">PIPING D/I &middot; AS OF ${wkLabel}</span>` +
                    `<span>PLAN <b style="color:#60a5fa">${planPct.toFixed(2)}%</b></span>` +
                    `<span>ACTUAL <b style="color:#22d3a1">${actPct.toFixed(2)}%</b></span>` +
                    `<span>DIFF <b style="color:${diffClr}">${diffSign}${diffPct.toFixed(2)}%</b></span>`;
            } else {
                scurveKpiEl.innerHTML = "";
            }
        }

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
            return `<div style="margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid var(--border)"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px"><div><div style="font-size:11px;font-weight:400">Unit ${u.unit}</div><div style="font-size:10px;color:var(--text-dim)">Plan: ${fmtNum(u.total_di,0)} DI</div></div><div style="font-size:13px;font-weight:400;color:${c};font-family:'DM Mono',monospace">${p.toFixed(2)}%</div></div><div style="height:3px;background:var(--border);border-radius:2px"><div style="height:100%;width:${Math.min(p,100)}%;background:${c};border-radius:2px"></div></div><div style="font-size:10px;color:var(--text-dim);margin-top:2px;font-family:'DM Mono',monospace">${fmtNum(u.completed_di,0)} / ${fmtNum(u.total_di,0)} DI</div></div>`;
        }).join("");
    } catch(e) { console.error("Overview failed", e); }
}

// ================================================================================
//  EARLY POWER OVERVIEW
// ================================================================================
async function loadEarlyPower() {
    const data = await getDashData();
    renderEarlyPower(data.ep_kpi ? data.ep_kpi[0] : null, data.ep_unit, data.ep_sys, data.ep_area, data.ep_weekly, data.kpi, data.weekly);
}

async function renderEarlyPower(d, _units, systems, areas, weekly, kpi, mainWeekly) {
    if(!d) return;
    try {
        // ep_sys 합산을 우선 사용 → 게이지와 테이블 물량 일치
        const d_total_di     = systems?.length ? systems.reduce((s,r) => s + (r.total_di     || 0), 0) : (d.total_di     || 0);
        const d_completed_di = systems?.length ? systems.reduce((s,r) => s + (r.completed_di || 0), 0) : (d.completed_di || 0);
        const pct = d_total_di > 0 ? parseFloat((d_completed_di / d_total_di * 100).toFixed(2)) : 0;

        // ── EP Support 수량: phase=EP 기준 집계 (전체 kpi와 분리) ────────
        let support_comp = 0, support_tot = 0, subareaMap = {};
        let sup = null;
        try {
            const now = Date.now();
            if (!_epSupportData || now - _epSupportDataTime > 1200_000) {
                _epSupportData = await apiFetch("/api/ep-support-summary");
                _epSupportDataTime = now;
            }
            sup = _epSupportData;
            subareaMap = sup.subarea_map || {};
            support_tot  = (sup.sys || []).reduce((s,r) => s + (r.total_di     || 0), 0);
            support_comp = (sup.sys || []).reduce((s,r) => s + (r.completed_di || 0), 0);
        } catch(e) { console.error("EP support summary failed", e); }
        const support_pct  = support_tot > 0 ? parseFloat((support_comp / support_tot * 100).toFixed(2)) : 0;

        // ── EP KPI Row (replaces global kpiRow on EP page) ────────────
        const testpkg_pct  = kpi ? parseFloat((kpi.testpkg_pct  || 0).toFixed(2)) : 0;
        const test_comp    = kpi ? (kpi.testpkg_comp  || 0) : 0;
        const test_tot     = kpi ? (kpi.testpkg_total || 0) : 0;
        const readiness_pct = parseFloat((pct * 0.7 + support_pct * 0.2 + testpkg_pct * 0.1).toFixed(2));

        const _setKpi = (id, val) => { const el=document.getElementById(id); if(el) el.textContent=val; };
        const _setCol = (id, col) => { const el=document.getElementById(id); if(el) el.style.color=col; };

        _setKpi("ep-kpi-readiness", `${readiness_pct.toFixed(2)}%`);
        _setCol("ep-kpi-readiness", pctColor(readiness_pct));
        _setKpi("ep-kpi-readiness-sub", `PIPING ${pct.toFixed(2)}% · SUP ${support_pct.toFixed(2)}% · TEST ${testpkg_pct.toFixed(2)}%`);
        const rBar = document.getElementById("ep-kpi-readiness-bar");
        if(rBar) { rBar.style.width = `${Math.min(readiness_pct,100)}%`; rBar.style.background = pctColor(readiness_pct); }

        _setKpi("ep-kpi-piping", `${pct.toFixed(2)}%`);
        _setCol("ep-kpi-piping", pctColor(pct));
        _setKpi("ep-kpi-piping-sub", `${fmtNum(d_completed_di,0)} / ${fmtNum(d_total_di,0)} DI · ${(d.completed_joints||0).toLocaleString()} joints`);

        _setKpi("ep-kpi-support", `${support_pct.toFixed(2)}%`);
        _setCol("ep-kpi-support", pctColor(support_pct));
        _setKpi("ep-kpi-support-sub", support_tot > 0 ? `${fmtNum(support_comp,0)} / ${fmtNum(support_tot,0)}` : "—");

        _setKpi("ep-kpi-testpkg", `${testpkg_pct.toFixed(2)}%`);
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
        if(gt) { gt.textContent = `${pct.toFixed(2)}%`; gt.style.fill = gc; }

        // ── EP Support Gauge ────────────────────────────────────────────
        const supOffset = circ * (1 - Math.min(support_pct/100,1));
        const supGc = support_pct>=80?"#22d3a1":support_pct>=50?"#f5c542":"#ff8c42";
        const supGp = document.getElementById("epSupportGaugePath");
        if(supGp) { supGp.style.stroke = supGc; supGp.style.strokeDashoffset = supOffset; }
        const supGt = document.getElementById("epSupportGaugeText");
        if(supGt) { supGt.textContent = `${support_pct.toFixed(2)}%`; supGt.style.fill = supGc; }
        const supStats = document.getElementById("epSupportGaugeStats");
        if(supStats) {
            const supRem = Math.max(0, support_tot - support_comp);
            supStats.innerHTML = [
                ["Support Completion",       `${support_pct.toFixed(2)}%`],
                ["Total Support (EA)",       fmtNum(support_tot,0)],
                ["Completed / Remaining (EA)", `${fmtNum(support_comp,0)} / ${fmtNum(supRem,0)}`]
            ].map(([l,v]) => `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`).join("");
        }

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
                const p=tot>0?parseFloat((comp/tot*100).toFixed(2)):0, c=pctColor(p);
                return `<tr>
                    <td style="${td};text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0">${row[nameKey]||""}</td>
                    <td style="${td}">${fmtNum(tot,0)}</td>
                    <td style="${td};color:var(--green)">${fmtNum(comp,0)}</td>
                    <td style="${td};color:${rem>0?"var(--orange)":"var(--green)"}">${fmtNum(rem,0)}</td>
                    <td style="${td};color:${c}">${p.toFixed(2)}%</td>
                </tr>`;
            }).join("");
            if(!showTotal) return rowHtml;
            const totRem = sumT-sumC, totP = sumT>0?parseFloat((sumC/sumT*100).toFixed(2)):0, totC=pctColor(totP);
            return rowHtml + `<tr style="background:rgba(37,99,235,0.07);border-top:2px solid var(--border);font-weight:700">
                <td style="${td};text-align:left;color:var(--accent)">TOTAL</td>
                <td style="${td}">${fmtNum(sumT,0)}</td>
                <td style="${td};color:var(--green)">${fmtNum(sumC,0)}</td>
                <td style="${td};color:${totRem>0?"var(--orange)":"var(--green)"}">${fmtNum(totRem,0)}</td>
                <td style="${td};color:${totC}">${totP.toFixed(2)}%</td>
            </tr>`;
        }

        const AREA_ORDER = ["YD BLDG", "YARD", "MB #1", "MB #2"];
        const _areaRank = (areaName) => { const i = AREA_ORDER.indexOf(areaName); return i < 0 ? 99 : i; };
        const _progressDesc = (a, b) => {
            const pa = a.total_di > 0 ? a.completed_di / a.total_di : 0;
            const pb = b.total_di > 0 ? b.completed_di / b.total_di : 0;
            return pb - pa;
        };
        const _prNum = (name) => { const m = name.match(/PR\s*#\s*(\d+)/i); return m ? parseInt(m[1]) : 0; };
        const _mbRank = (name) => {
            if (name === "MB STR") return 0;
            if (/^HRSG/i.test(name)) return 1;
            if (/^GT/i.test(name))   return 2;
            return 3;
        };
        const _byAreaThenProgress = (subareaMap) => (a, b) => {
            const ra = _areaRank(subareaMap[a.sub_area] || "");
            const rb = _areaRank(subareaMap[b.sub_area] || "");
            if (ra !== rb) return ra - rb;

            const area = subareaMap[a.sub_area] || "";
            const isPR = (n) => /^PR\s*#/i.test(n);

            if (area === "YARD") {
                const aP = isPR(a.sub_area), bP = isPR(b.sub_area);
                if (aP !== bP) return aP ? 1 : -1;       // non-PR before PR
                if (aP)        return _prNum(a.sub_area) - _prNum(b.sub_area); // PR: 오름차순
                return _progressDesc(a, b);               // non-PR: progress 내림차순
            }
            if (area === "MB #1" || area === "MB #2") {
                const ma = _mbRank(a.sub_area), mb2 = _mbRank(b.sub_area);
                if (ma !== mb2) return ma - mb2;          // MB STR → HRSG → GT
                // HRSG/GT 내부: 번호 오름차순 (#11 → #12)
                const numOf = (n) => { const m = n.match(/#\s*(\d+)/); return m ? parseInt(m[1]) : 0; };
                const na = numOf(a.sub_area), nb = numOf(b.sub_area);
                if (na !== nb) return na - nb;
                return _progressDesc(a, b);
            }
            return _progressDesc(a, b);
        };

        const pipingSysSorted = [...(systems || [])].sort(_progressDesc);
        const sysTb = document.getElementById("epSysTableBody");
        if(sysTb && systems) sysTb.innerHTML = _epTableRows(pipingSysSorted, "system", true);

        // Support tables (sup already fetched above for KPI)
        if(sup) {
            const supSysTb = document.getElementById("epSupSysTableBody");
            if(supSysTb && sup.sys) {
                const pipingOrder = pipingSysSorted.map(s => s.system);
                const supSysSorted = [...sup.sys].sort((a, b) => {
                    const ia = pipingOrder.indexOf(a.system), ib = pipingOrder.indexOf(b.system);
                    if (ia === -1 && ib === -1) return 0;
                    if (ia === -1) return 1;
                    if (ib === -1) return -1;
                    return ia - ib;
                });
                supSysTb.innerHTML = _epTableRows(supSysSorted, "system", true);
            }
            if(sup.area && sup.area.length) {
                const supSorted = [...sup.area].sort(_byAreaThenProgress(subareaMap));
                const supMid = Math.ceil(supSorted.length / 2);
                const supAreaTb  = document.getElementById("epSupAreaTableBody");
                const supAreaTb2 = document.getElementById("epSupAreaTableBody2");
                if(supAreaTb)  supAreaTb.innerHTML  = _epTableRows(supSorted.slice(0, supMid), "sub_area", false);
                if(supAreaTb2) supAreaTb2.innerHTML = _epTableRows(supSorted.slice(supMid),    "sub_area", true, sup.area);
            }
        }

        // Split sub areas evenly; TOTAL in col 2 uses ALL areas for correct aggregate
        if(areas && areas.length) {
            const sorted = [...areas].sort(_byAreaThenProgress(subareaMap));
            const mid = Math.ceil(sorted.length / 2);
            const areaTb  = document.getElementById("epAreaTableBody");
            const areaTb2 = document.getElementById("epAreaTableBody2");
            if(areaTb)  areaTb.innerHTML  = _epTableRows(sorted.slice(0, mid), "sub_area", false);
            if(areaTb2) areaTb2.innerHTML = _epTableRows(sorted.slice(mid),    "sub_area", true, areas);
        }

        if(weekly && weekly.length > 0) {
            // EP Target = week 40 (2026-12-30). Show all weeks 1-40 on x-axis.
            const EP_TARGET_WK = 40;
            const wkView = weekly.slice(0, EP_TARGET_WK); // weeks 1..40

            const epDateBar = document.getElementById("epScurveDateBar");
            if (epDateBar && wkView.length > 0) {
                const fmt = d => d ? d.replace(/-/g, ".") : null;
                // mainWeekly에서 week_no → 날짜 매핑
                const wkDateMap = {};
                (mainWeekly || []).forEach(w => { if (w.week_no) wkDateMap[w.week_no] = w; });
                const getDate = wk => {
                    const m = wkDateMap[wk.week_no];
                    return m ? fmt(m.week_end || m.week_start) : null;
                };
                // 날짜가 있는 마지막 주 탐색
                let lastDateWk = null;
                for (let i = wkView.length - 1; i >= 0; i--) {
                    if (getDate(wkView[i])) { lastDateWk = wkView[i]; break; }
                }
                const startDate = getDate(wkView[0]);
                const midDate   = getDate(wkView[Math.floor((wkView.length - 1) / 2)]);
                const endDate   = getDate(wkView[wkView.length - 1]) || (lastDateWk ? getDate(lastDateWk) : null);
                const epItem = (icon, label, date, align) =>
                    `<span style="display:flex;flex-direction:column;align-items:${align};gap:1px;min-width:0">` +
                    `<span style="font-size:9px;opacity:0.7;white-space:nowrap">${icon} ${label}</span>` +
                    `<span style="font-size:10px;color:#2563eb;white-space:nowrap">${date || "—"}</span>` +
                    `</span>`;
                epDateBar.innerHTML =
                    epItem("▶", "Start", startDate, "flex-start") +
                    epItem("◆", "Mid",   midDate,   "center")     +
                    epItem("◀", "End",   endDate,   "flex-end");
            }
            const lastEpActIdx = wkView.reduce((last, w, i) => w.completed_di > 0 ? i : last, -1);
            // Cumulative actual: show up to last active week, null after
            const cumulData = wkView.map((w, i) => i <= lastEpActIdx ? w.cumul_actual : null);
            // EP Target S-Curve: cubic smoothstep over 40 weeks (same logic as Overview)
            const epPlanSCurve = wkView.map((_, i) => {
                if (d_total_di <= 0) return null;
                const t = i / (wkView.length - 1);
                return Math.round(d_total_di * (3*t*t - 2*t*t*t));
            });
            destroyChart("epScurveChart");
            const ctx = document.getElementById("epScurveChart")?.getContext("2d");
            if(ctx) {
                charts["epScurveChart"] = new Chart(ctx, {
                    type: "bar",
                    data: { labels: wkView.map(w=>`W${w.week_no}`), datasets: [
                        { label:"EP Target DI",    type:"line", yAxisID:"yL", data:epPlanSCurve, borderColor:"rgba(255,82,82,0.55)", borderDash:[4,4], borderWidth:1.5, fill:false, pointRadius:0, tension:0, order:1, datalabels:{display:false} },
                        { label:"Cumulative Actual",type:"line", yAxisID:"yL", data:cumulData, borderColor:"#22d3a1", borderWidth:2, fill:false, pointRadius:3, pointBackgroundColor:"#22d3a1", pointHoverRadius:5, tension:0.1, order:2, spanGaps:false, datalabels:{display:false} },
                        { label:"Weekly DI",       type:"bar",  yAxisID:"yR", data:wkView.map(w=>w.completed_di>0?w.completed_di:null), backgroundColor:"rgba(37,99,235,0.5)", borderColor:"rgba(37,99,235,0.8)", borderWidth:1, borderRadius:2, barPercentage:0.8, categoryPercentage:0.9, order:3,
                          datalabels:{display:false} }
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

                // 마지막 작업주 기준 EP Plan/Actual/Diff 공정률 표시
                const epKpiEl = document.getElementById("epScurveKpi");
                if (epKpiEl) {
                    if (lastEpActIdx >= 0 && d_total_di > 0) {
                        const planPct  = epPlanSCurve[lastEpActIdx] / d_total_di * 100;
                        const actPct   = (cumulData[lastEpActIdx] || 0) / d_total_di * 100;
                        const diffPct  = actPct - planPct;
                        const diffClr  = diffPct >= 0 ? "#60a5fa" : "#ef4444";
                        const diffSign = diffPct >= 0 ? "+" : "";
                        const wkLabel  = wkView[lastEpActIdx] ? `W${wkView[lastEpActIdx].week_no}` : `W${lastEpActIdx + 1}`;
                        epKpiEl.innerHTML =
                            `<span style="opacity:0.55;font-size:9px">AS OF ${wkLabel}</span>` +
                            `<span>PLAN <b style="color:#60a5fa">${planPct.toFixed(2)}%</b></span>` +
                            `<span>ACTUAL <b style="color:#22d3a1">${actPct.toFixed(2)}%</b></span>` +
                            `<span>DIFF <b style="color:${diffClr}">${diffSign}${diffPct.toFixed(2)}%</b></span>`;
                    } else {
                        epKpiEl.innerHTML = "";
                    }
                }
            }
        }

    } catch(e) { console.error("EP Overview failed", e); }
}

// ================================================================================
//  SYSTEMS
// ================================================================================
const SYSTEM_FULL_NAMES = {
    "RW": "Raw Water System", "FO": "Fuel Oil Supply System", "HW": "Hot Water Supply System",
    "CCW": "Closed Cooling Water System", "AS": "Aux. Steam System", "FG": "Fuel Gas Supply System",
    "SW": "Service Water System", "GT MISC": "GT Miscellaneous System", "DW": "Demi. Water System",
    "CD": "Condensate System", "LO": "Lube Oil System", "IA": "Instrument Air System",
    "SA": "Service Air System", "ATM": "Atmosphere Flash Tank System", "FGH": "Fuel Gas Performance Heater System",
    "HP": "High Pressure Steam System", "LP": "Low Pressure Steam System", "N2": "N2 Gas System",
    "PW": "Potable Water System", "SS": "Sampling System", "ST MISC": "ST Miscellaneous System",
    "WWT": "Waste Water Transfer System", "FW": "Feed Water System"
};

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
                    <span class="prog-name" style="font-weight:700; color:#1e293b">${s.system}${SYSTEM_FULL_NAMES[s.system] ? ` (${SYSTEM_FULL_NAMES[s.system]})` : ""} ${warn}</span>
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
const SUBAREA_FULL_NAMES = {
    "BSDG": "Black Start Diesel Generator", "CCWPH #1": "CCW Pump House #1", "CCWPH #2": "CCW Pump House #2",
    "CEPH": "Condensate Extraction Pump House", "DOPS": "Diesel Oil Pump Station", "DOTK": "Diesel Oil Tank Area",
    "DWTK": "Demi. Water Tank Area", "FFC #1": "Fin Fan Cooler #1", "FFC #2": "Fin Fan Cooler #2",
    "FGSS": "Fuel Gas Supply Station", "GT #11": "GT #11 Area", "GT #12": "GT #12 Area",
    "GT #21": "GT #21 Area", "GT #22": "GT #22 Area",
    "HRSG #11 PR": "HRSG #11 Pipe Rack Area", "HRSG #12 PR": "HRSG #12 Pipe Rack Area",
    "HRSG #21 PR": "HRSG #21 Pipe Rack Area", "HRSG #22 PR": "HRSG #22 Pipe Rack Area",
    "HWPS": "Hot Water Pump Station", "LOPS": "Lube Oil Pump Station", "MB STR": "Main Building Structure",
    "PR #1": "Pipe Rack #1 Area", "PR #2": "Pipe Rack #2 Area", "PR #3": "Pipe Rack #3 Area",
    "PR #4": "Pipe Rack #4 Area", "PR #5": "Pipe Rack #5 Area", "PR #6": "Pipe Rack #6 Area", "PR #7": "Pipe Rack #7 Area",
    "PWPS": "Potable Water Pump Station", "PWTK": "Potable Water Tank Area", "RWTK": "Raw & Fire Water Tank Area",
    "RWPS": "Raw Water Pump Station",
    "STG #1": "STG #1 Area", "STG #2": "STG #2 Area", "WDPS": "Water Distribution Pump Station",
    "WORKSHOP": "Workshop Building", "SWTK": "Service Water Tank Area"
};

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
                    <span class="prog-name" style="font-weight:700; color:#1e293b">${s.sub_area}${SUBAREA_FULL_NAMES[s.sub_area] ? ` (${SUBAREA_FULL_NAMES[s.sub_area]})` : ""} ${warn}</span>
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
        const dateStart = res.date_start, dateEnd = res.date_end;

        const titleEl = document.getElementById("dailyTrendTitle");
        if (titleEl) {
            const range = dateStart && dateEnd ? ` (${dateStart.slice(5)} ~ ${dateEnd.slice(5)})` : "";
            titleEl.textContent = "Daily Welding Trend" + range;
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

        // Monthly Trend: 실제 완료일(date_completed) 기준 월별 집계 우선 사용
        // — 주(week) 단위 집계는 월 경계에 걸친 주차(예: 6/29~7/5)가 시작월로만 잡혀 최근월이 누락되는 문제가 있음
        let monthlyData;
        if (dash.monthly && dash.monthly.length) {
            monthlyData = dash.monthly
                .map(m => [m.month, {fab:m.fab_di||0, erect:m.erect_di||0, completed:m.completed_di||0}])
                .sort(([a],[b])=>a.localeCompare(b)).slice(-4);
        } else {
            const monthMap={};
            actWks.forEach(w=>{
                const mo=(w.week_start||"").slice(0,7);
                if(!mo) return;
                if(!monthMap[mo]) monthMap[mo]={fab:0,erect:0,completed:0};
                monthMap[mo].fab       += w.fab_di       || 0;
                monthMap[mo].erect     += w.erect_di     || 0;
                monthMap[mo].completed += w.completed_di || 0;
            });
            monthlyData = Object.entries(monthMap).sort(([a],[b])=>a.localeCompare(b)).slice(-4);
        }
        destroyChart("monthlyTrend");
        const moEl=document.getElementById("monthlyTrend");
        if(moEl && monthlyData.length){
            charts["monthlyTrend"]=new Chart(moEl.getContext("2d"),{
                type:"line",
                data:{labels:monthlyData.map(([mo])=>mo.slice(5)),datasets:[
                    {label:"Monthly DI",data:monthlyData.map(([,v])=>Math.round(v.completed)),borderColor:"#2563eb",borderWidth:2.5,pointRadius:6,pointBackgroundColor:"#22d3a1",pointBorderColor:"#fff",pointBorderWidth:2,tension:0.2,datalabels:{display:true,align:"top",offset:5,color:"#60a5fa",font:{size:10,weight:"700",family:"DM Mono, monospace"},formatter:v=>v>0?fmtNum(v,0):""}}
                ]},
                options:{...chartOpts("DI"),plugins:{...chartOpts("DI").plugins,legend:{display:false}}}
            });
        }

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
                <td style="color:var(--accent)">${r.system||r.mat||r.name||""}</td>
                <td style="font-size:11px;color:var(--text-dim)">${dateRange}</td>
                <td>${fmtNum(r.fab_di||0,1)}</td>
                <td>${fmtNum(r.erect_di||0,1)}</td>
                <td style="color:var(--accent)">${fmtNum(r.completed_di||0,1)}</td>
            </tr>`).join("") + mkTotalRow(arr);
            const mkSubRows = (arr, showTotal=false, totalArr=null) => arr.map(r=>`<tr>
                <td style="color:var(--accent)">${r.sub_area||r.name||""}</td>
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
            return `<div class="unit-card"><div class="unit-card-name">Unit ${u.unit}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(u.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(u.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p.toFixed(2)}% complete</div><div class="unit-card-di">${(u.total_joints||0).toLocaleString()} joints</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
        }).join("");

        const _areaDisplayOrder = { "YD BLDG": 1, "YARD": 2, "MB #1": 3, "MB #2": 4 };
        const allAreasKpi = [...(dash.areas || [])].sort((a, b) => (_areaDisplayOrder[a.area]||99) - (_areaDisplayOrder[b.area]||99));
        document.getElementById("areaCards").innerHTML = allAreasKpi.map(a => {
            const p=a.progress_pct, c=pctColor(p);
            return `<div class="unit-card" style="flex:1;"><div class="unit-card-name">Area: ${a.area}</div><div class="unit-card-pct" style="color:${c}">${fmtNum(a.completed_di,0)} <span style="font-size:13px;color:var(--text-dim)">/ ${fmtNum(a.total_di,0)} DI</span></div><div class="unit-card-sub" style="color:${c}">${p.toFixed(2)}% complete</div><div class="unit-card-bar"><div class="unit-card-fill" style="width:${Math.min(p,100)}%;background:${c}"></div></div></div>`;
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
async function loadJMPackages() {
    const system = document.getElementById("jm-system")?.value || "";
    const sel = document.getElementById("jm-package");
    if (!sel) return;
    sel.innerHTML = '<option value="">All PKG</option>';
    sel.value = "";
    jmCurrentPage = 0;
    loadJointMaster();
    if (!system) return;
    try {
        const pkgs = await apiFetch(`/api/joints/packages?system=${encodeURIComponent(system)}`);
        (pkgs || []).forEach(p => sel.add(new Option(p, p)));
    } catch(e) { console.error("PKG load failed", e); }
}

async function loadJointMaster() {
    const unit=document.getElementById("jm-unit")?.value||"", system=document.getElementById("jm-system")?.value||"",
          status=document.getElementById("jm-status")?.value||"", isoVal=document.getElementById("jm-iso")?.value?.trim()||"",
          subarea=document.getElementById("jm-subarea")?.value||"", phase=document.getElementById("jm-phase")?.value||"",
          pkg=document.getElementById("jm-package")?.value||"",
          insp=document.getElementById("jm-inspection")?.value||"",
          pwht=document.getElementById("jm-pwht")?.value||"",
          mat=document.getElementById("jm-mat")?.value||"",
          size=document.getElementById("jm-size")?.value||"",
          offset=jmCurrentPage*JM_PAGE_SIZE;
    _tableLoading("jmBody", 15);
    try {
        const params=new URLSearchParams({limit:JM_PAGE_SIZE,offset});
        if(unit)params.set("unit",unit); if(system)params.set("system",system); if(status)params.set("status",status);
        if(isoVal)params.set("iso",isoVal); if(subarea)params.set("sub_area",subarea); if(phase)params.set("phase",phase);
        if(pkg)params.set("package",pkg);
        if(insp)params.set("inspection",insp);
        if(pwht)params.set("pwht",pwht);
        if(mat)params.set("mat",mat);
        if(size)params.set("size",size);
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
    const dateVal=_fullDateVal("jm-bulk-date");
    if(!isoVal){toast("Please enter ISO Drawing No. first","error");return;}
    if(!dateVal){toast("Please select a date","error");return;}
    {const _today=new Date().toISOString().slice(0,10);if(dateVal>_today){toast("Future dates are not allowed (today: "+_today+")","error");return;}}
    const targets=jmData.filter(r=>r.iso_drawing===isoVal);
    if(targets.length===0){toast("No joints found for this ISO","error");return;}
    const btn=document.getElementById("jm-bulk-apply-btn");
    if(btn){btn.disabled=true;btn.textContent="Saving...";}
    try{
        let saved=0;
        for(const r of targets){
            await fetch(`${API}/api/joints/${r.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({date_completed:dateVal})});
            const el=document.getElementById(`date-${r.id}`);
            if(el){el.value=dateVal.slice(2);el.dataset.fullDate=dateVal;el.classList.remove("date-empty");}
            saved++;
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
            const el=document.getElementById(`date-${r.id}`);if(el){el.value="";delete el.dataset.fullDate;el.classList.add("date-empty");}
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
            <td style="padding:2px;text-align:center"><input class="cell-input${dStr?'':' date-empty'}" id="date-${r.id}" type="text" value="${dStr?dStr.slice(2):''}" data-full-date="${dStr}" style="width:100%;text-align:center;padding:2px 2px;cursor:pointer" onclick="_pickDate(this)" readonly></td>
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
                <button type="button" class="btn-save-row auth-write" onclick="saveJointDate(${r.id})">Save</button>
                <button type="button" class="btn-clear-row auth-write" onclick="clearJointDate(${r.id})">Clear</button>
            </td>
        </tr>`;
    }).join("");
    applyAuthUI(window.authRole);
}



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
    _tableLoading("ndeBody", 12);
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
            
            <td style="text-align:center;border-right:none;padding:3px 2px;"><input type="text" class="cell-input${pt_date?'':' date-empty'}" id="nde-pt-date-${r.id}" value="${pt_date?pt_date.slice(2):''}" data-full-date="${pt_date}" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px;cursor:pointer" onclick="_pickDate(this)" readonly></td>
            <td style="text-align:center;border-left:none;padding:1px 0;">
                <select class="cell-input" id="nde-pt-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;-webkit-appearance:none;appearance:none;padding:2px 0;">
                    <option value="">-</option>
                    <option value="PASS" ${r.pt_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.pt_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>

            <td style="text-align:center;border-right:none;padding:3px 2px;"><input type="text" class="cell-input${mt_date?'':' date-empty'}" id="nde-mt-date-${r.id}" value="${mt_date?mt_date.slice(2):''}" data-full-date="${mt_date}" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px;cursor:pointer" onclick="_pickDate(this)" readonly></td>
            <td style="text-align:center;border-left:none;padding:1px 0;">
                <select class="cell-input" id="nde-mt-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;-webkit-appearance:none;appearance:none;padding:2px 0;">
                    <option value="">-</option>
                    <option value="PASS" ${r.mt_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.mt_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>

            <td style="text-align:center;border-right:none;padding:3px 2px;${r.rt_result==='FAIL'?'background:rgba(239,68,68,0.15);':''}"><input type="text" class="cell-input${rt_date?'':' date-empty'}" id="nde-rt-date-${r.id}" value="${rt_date?rt_date.slice(2):''}" data-full-date="${rt_date}" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px;cursor:pointer" onclick="_pickDate(this)" readonly></td>
            <td style="text-align:center;border-left:none;padding:1px 0;border-right:none;${r.rt_result==='FAIL'?'background:rgba(239,68,68,0.15);':''}">
                <select class="cell-input" id="nde-rt-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;-webkit-appearance:none;appearance:none;padding:2px 0;${r.rt_result==='FAIL'?'color:#ef4444;font-weight:700;':''}">
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
            <td style="text-align:center;border-left:none;padding-left:2px;border-right:none;padding-right:2px;background:rgba(59,130,246,0.07)"><input type="text" class="cell-input${r.rt_2_date?'':' date-empty'}" id="nde-rt-2-date-${r.id}" value="${r.rt_2_date?r.rt_2_date.slice(2,10):''}" data-full-date="${r.rt_2_date?r.rt_2_date.substring(0,10):''}" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px;cursor:pointer" onclick="_pickDate(this)" readonly></td>
            <td style="text-align:center;border-left:none;padding:1px 0;background:rgba(59,130,246,0.07)">
                <select class="cell-input" id="nde-rt-2-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;-webkit-appearance:none;appearance:none;padding:2px 0;">
                    <option value="">-</option>
                    <option value="PASS" ${r.rt_2_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.rt_2_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>

            <td style="text-align:center;border-right:none;padding:3px 2px;"><input type="text" class="cell-input${pwht_date?'':' date-empty'}" id="nde-pwht-date-${r.id}" value="${pwht_date?pwht_date.slice(2):''}" data-full-date="${pwht_date}" style="width:100%;box-sizing:border-box;text-align:center;padding:3px 4px;cursor:pointer" onclick="_pickDate(this)" readonly></td>
            <td style="text-align:center;border-left:none;padding:1px 0;">
                <select class="cell-input" id="nde-pwht-res-${r.id}" style="width:100%;text-align:center;text-align-last:center;-webkit-appearance:none;appearance:none;padding:2px 0;">
                    <option value="">-</option>
                    <option value="PASS" ${r.pwht_result==='PASS'?'selected':''}>PASS</option>
                    <option value="FAIL" ${r.pwht_result==='FAIL'?'selected':''}>FAIL</option>
                </select>
            </td>
            <td style="text-align:center">
                <button class="btn-save-row auth-write" onclick="saveNdeRow(${r.id})">Save</button>
            </td>
        </tr>`;
    }).join("");
    applyAuthUI(window.authRole);
}

async function saveNdeRow(id){
    const data = {
        pt_date: _fullDateVal(`nde-pt-date-${id}`) || null,
        pt_result: document.getElementById(`nde-pt-res-${id}`).value,
        mt_date: _fullDateVal(`nde-mt-date-${id}`) || null,
        mt_result: document.getElementById(`nde-mt-res-${id}`).value,
        rt_date: _fullDateVal(`nde-rt-date-${id}`) || null,
        rt_result: document.getElementById(`nde-rt-res-${id}`).value,
        rt_finding: document.getElementById(`nde-rt-find-${id}`).value || null,
        rt_2_date: _fullDateVal(`nde-rt-2-date-${id}`) || null,
        rt_2_result: document.getElementById(`nde-rt-2-res-${id}`).value,
        pwht_date: _fullDateVal(`nde-pwht-date-${id}`) || null,
        pwht_result: document.getElementById(`nde-pwht-res-${id}`).value
    };

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

async function clearJointDate(id){
    try{
        const r=await fetch(`${API}/api/joints/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({date_completed:null, welder:null, inspection:null, pwht:null})});
        if(!r.ok)throw new Error('HTTP '+r.status);
        // 화면 초기화
        const dateEl=document.getElementById(`date-${id}`);       if(dateEl){dateEl.value='';delete dateEl.dataset.fullDate;dateEl.classList.add('date-empty');}
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
    let val=_fullDateVal(`date-${id}`);
    let welder=document.getElementById(`welder-${id}`)?.value?.trim()||'';
    let phase=document.getElementById(`phase-${id}`)?.value?.trim()||'';
    let pkg=document.getElementById(`pkg-${id}`)?.value?.trim()||'';
    let inspection=document.getElementById(`inspection-${id}`)?.value?.trim()||'';
    let pwht=document.getElementById(`pwht-${id}`)?.value?.trim()||'';
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
        await fetch("/api/cache/clear");_dashData=null;_epSupportData=null;
        const data=await getDashData(true);renderKPI(data.kpi,data.weekly);
        const visPage=document.querySelector(".page:not(.hidden)")?.id?.replace("page-","");
        if(visPage)navigate(visPage);
        toast("↺ Data refreshed!");
    }catch(e){toast("Refresh failed: "+e.message,"error");}
}

let _refreshPending = false;

async function _refreshAfterSave() {
    if (_refreshPending) return;
    _refreshPending = true;
    try {
        await fetch("/api/cache/clear").catch(() => {});
        _epSupportData = null;
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

// SheetJS 지연 로딩 — 첫 Export 클릭 시 동적 로드 (초기 페이지에서 900KB 파싱 제거)
let _xlsxPromise = null;
function ensureXlsx() {
    if (window.XLSX) return Promise.resolve();
    if (!_xlsxPromise) {
        _xlsxPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js';
            s.onload = () => resolve();
            s.onerror = () => { _xlsxPromise = null; reject(new Error('SheetJS load failed')); };
            document.head.appendChild(s);
        });
    }
    return _xlsxPromise;
}

async function downloadWithPicker(wb,name){
    const wbout=XLSX.write(wb,{bookType:'xlsx',type:'array'}),blob=new Blob([wbout],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    if('showSaveFilePicker'in window){try{const handle=await window.showSaveFilePicker({suggestedName:name,types:[{description:'Excel File',accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}]});const writable=await handle.createWritable();await writable.write(blob);await writable.close();return true;}catch(e){if(e.name==='AbortError')return false;console.warn("Picker failed, falling back",e);}}
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);return true;
}

async function exportSystemBreakdown() {
    await ensureXlsx();
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
    await ensureXlsx();
    if(!_dashData){toast("Data not loaded yet","error");return;}
    let exportData=[],fileName="";
    if(type==='system'){exportData=(_dashData.systems||[]).map(s=>{const tot=s.total_di||s.plan_di||0,done=s.completed_di||0;return {"System":s.system,"Total DI":tot,"Completed DI":done,"Remaining DI":s.remaining_di!=null?s.remaining_di:Math.max(0,tot-done),"Progress %":s.progress_pct};});fileName="System_Progress_Export.xlsx";}
    else{exportData=(_dashData.subareas||_dashData.areas||[]).map(s=>({"Name":s.sub_area||s.area||"","Total DI":s.total_di,"Completed DI":s.completed_di,"Remaining DI":s.remaining_di||(s.total_di-s.completed_di),"Progress %":s.progress_pct}));fileName="SubArea_Progress_Export.xlsx";}
    if(exportData.length===0){toast("No data available to export","error");return;}
    const ws=XLSX.utils.json_to_sheet(exportData),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Progress");
    const success=await downloadWithPicker(wb,fileName);if(success)toast(`${type==='system'?'System':'Sub Area'} export complete`);
}

// 테이블 tbody에 로딩 행 표시
function _tableLoading(tbodyId, colspan) {
    const el = document.getElementById(tbodyId);
    if (el) el.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;padding:24px;color:#7a95b8;font-size:12px;letter-spacing:0.05em">Loading...</td></tr>`;
}

// 필터 파라미터 읽기 헬퍼 [[elementId, paramKey], ...]
function _readFilters(fields) {
    const p = new URLSearchParams();
    for (const [id, key] of fields) {
        const val = document.getElementById(id)?.value?.trim() || "";
        if (val) p.set(key, val);
    }
    return p;
}

// 현재 필터 조건으로 전체 데이터 조회 (limit=10000)
async function _fetchAllFiltered(endpoint, params) {
    params.set("limit", 10000);
    params.set("offset", 0);
    const res = await apiFetch(`${endpoint}?${params}`);
    return res.data || [];
}

async function exportJMExcel(){
    await ensureXlsx();
    toast("Loading data...", "info");
    const params = _readFilters([
        ["jm-unit","unit"],["jm-system","system"],["jm-status","status"],
        ["jm-iso","iso"],["jm-subarea","sub_area"],["jm-phase","phase"],["jm-inspection","inspection"]
    ]);
    const data = await _fetchAllFiltered("/api/joints", params);
    if(!data.length){toast("No data to export","error");return;}
    const exportData=data.map(r=>({
        "ID":r.id, "UNIT":r.unit||"", "SYSTEM":r.system||"", "AREA":r.area||"",
        "SUB AREA":r.sub_area||"", "LINE NO":r.line_no||"", "ISO DRAWING":r.iso_drawing||"",
        "REV":r.rev||"", "SPOOL NO":r.spool_no||"", "MAT":r.mat||"",
        "SIZE":r.size_inch||"", "S/F":r.sf||"", "JOINT NO":r.joint_no||"",
        "DI":r.di||"", "WELDER":r.welder||"", "PHASE":r.phase||"",
        "COMPLETED DATE":r.date_completed?r.date_completed.substring(0,10):"",
        "REMARK":r.remark||""
    }));
    const ws=XLSX.utils.json_to_sheet(exportData),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"JointMaster");
    const success=await downloadWithPicker(wb,"Joint_Master_Export.xlsx");if(success)toast(`✓ ${data.length.toLocaleString()} rows exported`);
}

async function printPage(pageId){
    const _PRINT_TABS = {
        "joint_master": {
            endpoint: "/api/joints",
            params: () => _readFilters([["jm-unit","unit"],["jm-system","system"],["jm-status","status"],["jm-iso","iso"],["jm-subarea","sub_area"],["jm-phase","phase"],["jm-inspection","inspection"]]),
            render: d => renderJMTable(d), restore: () => renderJMTable(jmData)
        },
        "support_master": {
            endpoint: "/api/support-master",
            params: () => _readFilters([["sm-search","search"],["sm-phase","phase"],["sm-package","package"],["sm-unit","unit"],["sm-subarea","sub_area"],["sm-system","system"],["sm-type","type"]]),
            render: d => renderSMTable(d), restore: () => renderSMTable(smData)
        },
        "nde_pwht": {
            endpoint: "/api/joints",
            params: () => { const p = _readFilters([["nde-unit","unit"],["nde-system","system"],["nde-iso","iso"],["nde-insp","inspection"],["nde-welder","welder"]]); p.set("nde_only","true"); return p; },
            render: d => renderNdeTable(d), restore: () => renderNdeTable(ndeData)
        },
        "testpkg_master": {
            endpoint: "/api/testpkg-joints",
            params: () => _readFilters([["tp-iso","iso"],["tp-welder","welder"],["tp-package","package"],["tp-system","system"],["tp-status","status"]]),
            render: d => renderTPTable(d), restore: () => renderTPTable(tpData)
        },
        "test_master": {
            endpoint: "/api/testpkg-master",
            params: () => _readFilters([["tm-system","system"],["tm-package","test_pkg_no"],["tm-status","status"],["tm-search","q"]]),
            render: d => renderTMTable(d), restore: () => renderTMTable(tmData)
        }
    };
    const cfg = _PRINT_TABS[pageId];
    if (cfg) {
        toast("Loading print data...", "info");
        const allData = await _fetchAllFiltered(cfg.endpoint, cfg.params());
        cfg.render(allData);
    }
    const pages=document.querySelectorAll('.page');pages.forEach(p=>p.classList.remove('page-print-active'));
    const target=document.getElementById("page-"+pageId);if(target)target.classList.add('page-print-active');
    window.print();
    pages.forEach(p=>p.classList.remove('page-print-active'));
    if (cfg) cfg.restore();
}

// 렌더된 DOM 테이블들을 시트로 묶어 내보내는 공용 헬퍼 (specs: [elementId, sheetName][])
async function exportTablesExcel(specs, fileName){
    await ensureXlsx();
    const wb = XLSX.utils.book_new();
    for (const [id, name] of specs) {
        const el = document.getElementById(id);
        if (!el) continue;
        const tbl = el.tagName === 'TABLE' ? el : el.closest('table');
        if (!tbl || !tbl.tBodies[0] || !tbl.tBodies[0].rows.length) continue;
        XLSX.utils.book_append_sheet(wb, XLSX.utils.table_to_sheet(tbl), name.substring(0, 31));
    }
    if (!wb.SheetNames.length) { toast("No data to export", "error"); return; }
    const ok = await downloadWithPicker(wb, fileName);
    if (ok) toast("✓ Exported");
}

async function exportEPExcel(){
    await exportTablesExcel([
        ["epSysTableBody", "Piping by EP System"],
        ["epAreaTableBody", "Piping by EP SubArea 1"],
        ["epAreaTableBody2", "Piping by EP SubArea 2"],
        ["epSupSysTableBody", "Support by EP System"],
        ["epSupAreaTableBody", "Support by EP SubArea 1"],
        ["epSupAreaTableBody2", "Support by EP SubArea 2"]
    ], "Early_Power_Export.xlsx");
}

async function exportWeeklyExcel(){
    await exportTablesExcel([
        ["weeklyTable", "Productivity Log"],
        ["weeklyMaterialTable", "By Material"],
        ["weeklySystemTable", "By System"],
        ["weeklySubareaTable", "By SubArea 1"],
        ["weeklySubareaTable2", "By SubArea 2"]
    ], "Weekly_Productivity_Export.xlsx");
}

async function exportRTExcel(){
    await exportTablesExcel([
        ["rtSystemBody", "Repair Rate by System"],
        ["rtWelderBody", "Welder Repair Rate"],
        ["rtRepairBody", "Repair Joint List"]
    ], "RT_Quality_Export.xlsx");
}

async function exportUnitAreaExcel(){
    await ensureXlsx();
    const dash = await getDashData();
    const units = (dash?.units || []).map(u => ({
        "Unit": u.unit, "Total DI": u.total_di, "Completed DI": u.completed_di,
        "Remaining DI": (u.total_di || 0) - (u.completed_di || 0),
        "Progress %": u.progress_pct, "Joints": u.total_joints || 0
    }));
    const areas = (dash?.areas || []).map(a => ({
        "Area": a.area, "Total DI": a.total_di, "Completed DI": a.completed_di,
        "Remaining DI": (a.total_di || 0) - (a.completed_di || 0),
        "Progress %": a.progress_pct
    }));
    if (!units.length && !areas.length) { toast("No data to export", "error"); return; }
    const wb = XLSX.utils.book_new();
    if (units.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(units), "Units");
    if (areas.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(areas), "Areas");
    const ok = await downloadWithPicker(wb, "Unit_Area_Export.xlsx");
    if (ok) toast("✓ Exported");
}

// ================================================================================
//  WELDER PERFORMANCE  (Enhanced v2)
// ================================================================================
let _welderData = null;
let _selectedWelder = null;

async function loadWelder() {
    _selectedWelder = null;
    try {
        const [res, dailyData, dashData] = await Promise.all([
            fetch("/api/welder-summary"),
            apiFetch("/api/welder-daily").catch(() => []),
            getDashData()
        ]);
        if (!res.ok) throw new Error("API error " + res.status);
        _welderData = await res.json();
        renderWelder(_welderData);
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
    return rows.map((r, i) => `<tr onclick="drillWelder('${r.welder}')" style="cursor:pointer">
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

function renderWelder(data) {
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
                        backgroundColor: "rgba(37,99,235,0.25)",
                        borderColor: "#2563eb",
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
                            color: "#fb923c",
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
                         ticks: { color: "#60a5fa", font: { size: 10 } },
                         grid: { display: false },
                         title: { display: true, text: "Total DI", color: "#4a6080", font: { size: 10 } } },
                    y2: { type: "linear", position: "right", beginAtZero: true,
                          ticks: { color: "#60a5fa", font: { size: 10 } },
                          grid: { display: false },
                          title: { display: true, text: "AVG DI/DAY PER WELDER", color: "#4a6080", font: { size: 10 } } }
                },
                plugins: {
                    legend: { position: "top", align: "start", labels: { color: "#475569", font: { size: 10 }, boxWidth: 10, padding: 10 } },
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
                        backgroundColor: "rgba(99,102,241,0.22)",
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
                            color: "#fb923c",
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
                         ticks: { color: "#60a5fa", font: { size: 10 } },
                         grid: { display: false },
                         title: { display: true, text: "Total DI", color: "#4a6080", font: { size: 10 } } },
                    y2: { type: "linear", position: "right", beginAtZero: true,
                          ticks: { color: "#60a5fa", font: { size: 10 } },
                          grid: { display: false },
                          title: { display: true, text: "AVG DI/DAY PER WELDER", color: "#4a6080", font: { size: 10 } } }
                },
                plugins: {
                    legend: { position: "top", align: "end", labels: { color: "#475569", font: { size: 10 }, boxWidth: 10, padding: 10 } },
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
    await ensureXlsx();
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

async function loadSupportMaster() {
    const unit    = document.getElementById("sm-unit")?.value    || "";
    const system  = document.getElementById("sm-system")?.value  || "";
    const subarea = document.getElementById("sm-subarea")?.value || "";
    const smtype  = document.getElementById("sm-type")?.value    || "";
    const phase   = document.getElementById("sm-phase")?.value   || "";
    const pkg     = document.getElementById("sm-package")?.value?.trim() || "";
    const search        = document.getElementById("sm-search")?.value?.trim() || "";
    const pipingStatus  = document.getElementById("sm-piping-status")?.value || "";
    const offset  = smCurrentPage * SM_PAGE_SIZE;
    _tableLoading("smBody", 12);
    try {
        const params = new URLSearchParams({limit: SM_PAGE_SIZE, offset});
        if (unit)         params.set("unit",          unit);
        if (system)       params.set("system",         system);
        if (subarea)      params.set("sub_area",       subarea);
        if (smtype)       params.set("type",           smtype);
        if (phase)        params.set("phase",          phase);
        if (pkg)          params.set("package",        pkg);
        if (search)       params.set("search",         search);
        if (pipingStatus) params.set("piping_status",  pipingStatus);

        const res = await apiFetch(`/api/support-master?${params}`);
        smData = res.data;
        document.getElementById("sm-count").textContent = `Total ${(res.count||0).toLocaleString()} rows`;
        _renderPageNums("sm-page-nav", smCurrentPage, res.count||0, SM_PAGE_SIZE, "smGoto");

        renderSMTable(smData);
        updateSmIsoBulkPanel(search, smData);
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
    const isoVal = document.getElementById("sm-search")?.value?.trim();
    const dateVal = _fullDateVal("sm-bulk-date");
    if (!isoVal) { toast("Please enter Search Drawing first", "error"); return; }
    if (!dateVal) { toast("Please select a date", "error"); return; }
    {const _today=new Date().toISOString().slice(0,10);if(dateVal>_today){toast("Future dates are not allowed (today: "+_today+")","error");return;}}

    const targets = smData.filter(r =>
        (r.support_drawing && r.support_drawing.toLowerCase().includes(isoVal.toLowerCase())) || 
        (r.iso_drawing && r.iso_drawing.toLowerCase().includes(isoVal.toLowerCase()))
    );
    
    if (targets.length === 0) { toast("No items found for this search", "error"); return; }
    const btn = document.getElementById("sm-bulk-apply-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving..."; }
    
    try {
        await Promise.all(targets.map(r =>
            fetch(`${API}/api/support-master/${r.id}`, {
                method: "PATCH",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({date_completed: dateVal, completed: true})
            }).then(() => {
                const el = document.getElementById(`sm-date-${r.id}`);
                if (el) { el.value = dateVal.slice(2); el.dataset.fullDate = dateVal; el.classList.remove("date-empty"); }
            })
        ));
        toast(`✓ ${targets.length} items saved — KPI updating...`);
        fetch("/api/cache/clear");
        updateSmIsoBulkPanel(isoVal, smData);
    } catch(e) { toast(`✗ Bulk save failed: ${e.message}`, "error"); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "Apply to All"; } }
}

async function clearSmBulkDate() {
    const isoVal = document.getElementById("sm-search")?.value?.trim();
    if (!isoVal) { toast("Please enter Search Drawing first", "error"); return; }
    
    const targets = smData.filter(r => 
        (r.support_drawing && r.support_drawing.toLowerCase().includes(isoVal.toLowerCase())) || 
        (r.iso_drawing && r.iso_drawing.toLowerCase().includes(isoVal.toLowerCase()))
    );
    
    if (targets.length === 0) { toast("No items found for this search", "error"); return; }
    if (!confirm(`Delete dates for all ${targets.length} items?`)) return;
    
    try {
        await Promise.all(targets.map(r =>
            fetch(`${API}/api/support-master/${r.id}`, {
                method: "PATCH",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({date_completed: null, completed: false})
            }).then(() => {
                const el = document.getElementById(`sm-date-${r.id}`);
                if (el) { el.value = ""; delete el.dataset.fullDate; el.classList.add("date-empty"); }
            })
        ));
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
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--text-dim);padding:20px">No data.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const dc = r.date_completed ? r.date_completed.substring(0,10) : "";
        return `<tr id="smrow-${r.id}">
          <td style="padding:2px"><input class="cell-input" id="sm-phase-${r.id}" type="text" value="${r.phase||""}" style="width:100%;text-align:center;padding:2px 4px"></td>
          <td><input class="cell-input" id="sm-pkg-${r.id}" type="text" value="${r.package||""}" style="text-align:center"></td>
          <td>${r.unit||""}</td>
          <td>${r.system||""}</td>
          <td>${r.area||""}</td>
          <td>${r.sub_area||""}</td>
          <td>${r.support_drawing||""}</td>
          <td style="text-align:center">${r.type||""}</td>
          <td>${r.revision||""}</td>
          <td style="font-size:11px;font-family:'DM Mono',monospace;word-break:break-all" title="${r.iso_drawing||""}">${r.iso_drawing||""}</td>
          <td>${r.line_no||""}</td>
          <td style="padding:2px;text-align:center"><input class="cell-input${dc?'':' date-empty'}" id="sm-date-${r.id}" type="text" value="${dc?dc.slice(2):''}" data-full-date="${dc}" style="width:100%;text-align:center;padding:2px 2px;cursor:pointer" onclick="_pickDate(this)" readonly></td>
          <td style="white-space:nowrap">
            <button class="btn-save-row auth-write" onclick="saveSMRow(${r.id})">Save</button>
            <button class="btn-clear-row auth-admin" onclick="deleteSMItem(${r.id})">Del</button>
          </td>
        </tr>`;
    }).join("");
    applyAuthUI(window.authRole);
}

async function saveSMRow(id) {
    let dateVal = _fullDateVal(`sm-date-${id}`);
    let phase   = document.getElementById(`sm-phase-${id}`)?.value?.trim() || "";
    let pkg     = document.getElementById(`sm-pkg-${id}`)?.value?.trim() || "";

    if (dateVal) { const _today=new Date().toISOString().slice(0,10); if(dateVal>_today){toast("Future dates are not allowed (today: "+_today+")","error");return;} }

    try {
        const r = await fetch(`/api/support-master/${id}`, {
            method: "PATCH", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({
                date_completed: dateVal || null,
                completed: !!dateVal,
                phase: phase || null,
                package: pkg || null
            })
        });
        if (!r.ok) throw new Error("HTTP "+r.status);
        toast(`✓ Support #${id} saved`);
        _epSupportData = null;
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


async function exportSMExcel() {
    await ensureXlsx();
    toast("Loading data...", "info");
    const params = _readFilters([["sm-search","search"],["sm-phase","phase"],["sm-package","package"],["sm-unit","unit"],["sm-subarea","sub_area"],["sm-system","system"],["sm-type","type"]]);
    const data = await _fetchAllFiltered("/api/support-master", params);
    if (!data.length) { toast("No data", "error"); return; }
    const rows = data.map(r => ({
        "NO.": r.id,
        "PHASE": r.phase || "",
        "UNIT": r.unit || "",
        "SYSTEM": r.system || "",
        "AREA": r.area || "",
        "SUB AREA": r.sub_area || "",
        "SUPPORT DRAWING": r.support_drawing || "",
        "TYPE": r.type || "",
        "REVISION": r.revision || "",
        "ISO DRAWING": r.iso_drawing || "",
        "LINE NO": r.line_no || "",
        "ACTUAL DATE": r.date_completed ? r.date_completed.substring(0,10) : "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SupportMaster");
    const ok = await downloadWithPicker(wb, "Support_Master_Export.xlsx");
    if (ok) toast(`✓ ${data.length.toLocaleString()} rows exported`);
}

// ================================================================================
//  TEST PACKAGE MASTER
// ================================================================================
let tpData = [], tpCurrentPage = 0;
const TP_PAGE = 30;

async function loadTestPkgMaster() {
    const iso    = document.getElementById("tp-iso")?.value?.trim() || "";
    const welder = document.getElementById("tp-welder")?.value?.trim() || "";
    const pkg    = document.getElementById("tp-package")?.value?.trim() || "";
    const system = document.getElementById("tp-system")?.value  || "";
    const status = document.getElementById("tp-status")?.value  || "";
    const offset = tpCurrentPage * TP_PAGE;
    _tableLoading("tpBody", 18);
    try {
        const tpSys = document.getElementById("tp-system");
        if (tpSys && tpSys.options.length <= 1) (metaData.systems||[]).forEach(s => tpSys.add(new Option(s,s)));

        const params = new URLSearchParams({limit: TP_PAGE, offset});
        if (iso)    params.set("iso",     iso);
        if (welder) params.set("welder",  welder);
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
        const pkgs = await apiFetch(`/api/joints/packages?system=${encodeURIComponent(system)}`);
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
        const vtLocked = !r.date_completed || !r.inspection;
        const vtLockAttrs = vtLocked ? `disabled title="Enter Weld Date and Inspection first"` : "";
        return `<tr id="tprow-${r.id}">
          <td style="text-align:center">${r.system||""}</td>
          <td style="font-weight:600;color:var(--indigo)">${r.package||""}</td>
          <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title="${r.iso_drawing||""}">${r.iso_drawing||""}</td>
          <td style="text-align:center">${r.joint_no||""}</td>
          <td style="text-align:center;color:var(--accent)">${weldDate?weldDate.slice(2):"-"}</td>
          <td style="text-align:center;font-weight:700;font-size:11px;color:${inspColor}">${inspLabel}</td>
          <td style="padding:2px;text-align:center"><input type="text" class="cell-input${vtDate?'':' date-empty'}" id="tp-vt-date-${r.id}" value="${vtDate?vtDate.slice(2):''}" data-full-date="${vtDate}" style="padding:3px 2px;text-align:center;cursor:${vtLocked?'not-allowed':'pointer'}" ${vtLocked?'':'onclick="_pickDate(this)"'} readonly ${vtLockAttrs}></td>
          <td style="padding:2px;text-align:center">
            <select class="cell-input" id="tp-vt-res-${r.id}" style="padding:3px 4px;text-align:center;text-align-last:center;cursor:${vtLocked?'not-allowed':'pointer'}" ${vtLockAttrs}>
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
          <td style="text-align:center"><button class="btn-save-row auth-write" style="padding:3px 8px;font-size:10px" onclick="saveTPVT(${r.id})">Save</button></td>
        </tr>`;
    }).join("");
    applyAuthUI(window.authRole);
}

async function saveTPVT(id) {
    let vtDate = _fullDateVal(`tp-vt-date-${id}`);
    const vtRes  = document.getElementById(`tp-vt-res-${id}`)?.value || "";
    const row = tpData.find(r => r.id === id);
    if ((vtDate || vtRes) && (!row?.date_completed || !row?.inspection)) {
        toast("Weld Date and Inspection must be entered first in Joint Master.", "error");
        return;
    }
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


async function syncSMPhasePackage() {
    if (!confirm("Match Phase/Package from Joint Master using Support Master's ISO Drawing.\nContinue?")) return;
    toast("Syncing...", "info");
    try {
        const r = await fetch("/api/support-master/sync-phase-package", {method:"POST"});
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        toast(`✓ ${d.updated} row(s) updated`);
        loadSupportMaster();
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
}

async function syncSMFromDrawing() {
    if (!confirm("Update Support Master based on Drawing DB.\n• Existing: update Type/Revision\n• New: add items matched from JM\n\nContinue?")) return;
    const btn = document.querySelector('[onclick="syncSMFromDrawing()"]');
    if (btn) { btn.disabled = true; btn.textContent = "Syncing..."; }
    toast("Syncing with Drawing DB... (up to 30s)", "info");
    try {
        const r = await fetch("/api/support-master/sync-drawing", {method:"POST"});
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        toast(`✓ ${d.updated} updated / ${d.inserted} added`);
        loadSupportMaster();
        fetch("/api/cache/clear");
    } catch(e) { toast(`✗ ${e.message}`, "error"); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "⟳ Sync from Drawing"; } }
}

async function exportNDEExcel() {
    await ensureXlsx();
    toast("Loading data...", "info");
    const params = _readFilters([["nde-unit","unit"],["nde-system","system"],["nde-iso","iso"],["nde-insp","inspection"],["nde-welder","welder"]]);
    params.set("nde_only", "true");
    const data = await _fetchAllFiltered("/api/joints", params);
    if (!data.length) { toast("No NDE data to export", "error"); return; }
    const rows = data.map(r => ({
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
    if (ok) toast(`✓ ${data.length.toLocaleString()} rows exported`);
}

async function exportTPExcel() {
    await ensureXlsx();
    toast("Loading data...", "info");
    const params = _readFilters([["tp-iso","iso"],["tp-welder","welder"],["tp-package","package"],["tp-system","system"],["tp-status","status"]]);
    const data = await _fetchAllFiltered("/api/testpkg-joints", params);
    if (!data.length) { toast("No data", "error"); return; }
    const rows = data.map(r => ({
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
    const ok = await downloadWithPicker(wb, "TestPkg_Master_Export.xlsx");
    if (ok) toast(`✓ ${data.length.toLocaleString()} rows exported`);
}

// ================================================================================
//  TEST MASTER
// ================================================================================
let tmData = [], tmCurrentPage = 0;
const TM_PAGE = 20;

// 전체 패키지 목록 캐시 (System 필터용)
let _tmAllData = [];

async function loadTestMaster() {
    const system  = document.getElementById("tm-system")?.value  || "";
    const pkg     = document.getElementById("tm-package")?.value || "";
    const status  = document.getElementById("tm-status")?.value  || "";
    const search  = document.getElementById("tm-search")?.value.trim() || "";
    const offset  = tmCurrentPage * TM_PAGE;
    _tableLoading("tmBody", 13);
    try {
        let url = `/api/testpkg-master?limit=${TM_PAGE}&offset=${offset}`;
        if (system) url += `&system=${encodeURIComponent(system)}`;
        if (pkg)    url += `&test_pkg_no=${encodeURIComponent(pkg)}`;
        if (status) url += `&status=${encodeURIComponent(status)}`;
        if (search) url += `&q=${encodeURIComponent(search)}`;
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
        const res = await apiFetch("/api/testpkg-master?limit=2000&offset=0&skip_readiness=1");
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
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:20px;color:#64748b">No data. Use the "Sync from Pkg" button to load packages from Pkg Master.</td></tr>`;
        return;
    }
    const iopt = v => v ? ` selected` : "";
    const fnt  = "font-family:'DM Mono',monospace;font-size:11px;font-weight:400";
    const cin  = `width:92%;text-align:center;color:#000;background:#fff;${fnt}`;
    const ssel = `width:98%;text-align:center;color:#000;background:#fff;${fnt}`;
    tbody.innerHTML = data.map((r, i) => {
        const dc  = r.date_completed ? r.date_completed.substring(0,10) : "";
        const res = r.completed ? "PASS" : (dc ? "FAIL" : "");
        const pt = r.piping_total     || 0;
        const pc = r.piping_completed || 0;
        const st = r.support_total    || 0;
        const si = r.support_installed|| 0;
        const pp = pt > 0 ? (pc / pt) * 100 : 0;
        const sp = st > 0 ? (si / st) * 100 : 0;
        const op = pp * 0.7 + sp * 0.3;
        const mU = (r.method||"").toUpperCase();
        const mdU = (r.media||"").toUpperCase();
        const readinessCell = `<div style="padding:3px 8px">
            <div style="font-size:11px;font-weight:400;color:#3b82f6;text-align:center;margin-bottom:4px;font-family:'DM Mono',monospace">${op.toFixed(1)}%</div>
            <div style="display:flex;gap:2px;margin:0 2px">
                <div style="flex:7;height:3px;background:#e2e8f0;border-radius:2px;overflow:hidden" title="Piping ${pp.toFixed(1)}%">
                    <div style="width:${Math.min(pp,100).toFixed(1)}%;height:100%;background:#3b82f6;border-radius:2px"></div>
                </div>
                <div style="flex:3;height:3px;background:#e2e8f0;border-radius:2px;overflow:hidden" title="Support ${sp.toFixed(1)}%">
                    <div style="width:${Math.min(sp,100).toFixed(1)}%;height:100%;background:#a78bfa;border-radius:2px"></div>
                </div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:2px;padding:0 2px">
                <span style="font-size:9px;color:#94a3b8;font-family:'DM Mono',monospace">P:${pp.toFixed(1)}%</span>
                <span style="font-size:9px;color:#94a3b8;font-family:'DM Mono',monospace">S:${sp.toFixed(1)}%</span>
            </div>
        </div>`;
        return `<tr>
            <td style="text-align:center">${tmCurrentPage*TM_PAGE+i+1}</td>
            <td style="text-align:center">${r.system||"—"}</td>
            <td style="text-align:center;font-size:11px">${r.test_pkg_no||"—"}</td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-desc-${r.id}" value="${r.description||""}" style="width:92%;text-align:center;color:#000;background:#fff;font-family:'DM Mono',monospace;font-size:10px;font-weight:400"></td>
            <td style="padding:0">${readinessCell}</td>
            <td style="text-align:center">
                <select class="cell-input" id="tm-method-${r.id}" style="${ssel}">
                    <option value="" style="color:#000">-</option>
                    <option value="VISUAL"      ${mU==="VISUAL"     ?" selected":""} style="color:#000">VISUAL</option>
                    <option value="PNEUMATIC"   ${mU==="PNEUMATIC"  ?" selected":""} style="color:#000">PNEUMATIC</option>
                    <option value="HYDRO"       ${mU==="HYDRO"      ?" selected":""} style="color:#000">HYDRO</option>
                    <option value="IN SERVICE"  ${mU==="IN SERVICE" ?" selected":""} style="color:#000">IN SERVICE</option>
                </select>
            </td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-dp-${r.id}" value="${r.design_pressure||""}" style="${cin}"></td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-tp-${r.id}" value="${r.test_pressure||""}" style="${cin}"></td>
            <td style="text-align:center">
                <select class="cell-input" id="tm-media-${r.id}" style="${ssel}">
                    <option value="" style="color:#000">-</option>
                    <option value="IA (N2 GAS)"   ${mdU==="IA (N2 GAS)"  ?" selected":""} style="color:#000">IA (N2 GAS)</option>
                    <option value="WATER"         ${mdU==="WATER"        ?" selected":""} style="color:#000">WATER</option>
                    <option value="DEMI. WATER"   ${mdU==="DEMI. WATER"  ?" selected":""} style="color:#000">DEMI. WATER</option>
                </select>
            </td>
            <td style="text-align:center"><input type="text" class="cell-input" id="tm-holding-${r.id}" value="${r.holding_time||""}" style="${cin}"></td>
            <td style="text-align:center"><input type="text" class="cell-input${dc?'':' date-empty'}" id="tm-date-${r.id}" value="${dc?dc.slice(2):''}" data-full-date="${dc}"
                style="width:100%;text-align:center;background:#fff;cursor:pointer;color:#000"
                onclick="_pickDate(this)" readonly></td>
            <td style="text-align:center">
                <select class="cell-input" id="tm-result-${r.id}" style="width:90%;text-align:center;color:#000;background:#fff;${fnt}">
                    <option value=""${iopt(!res)} style="color:#000">-</option>
                    <option value="PASS"${iopt(res==="PASS")} style="color:#000">PASS</option>
                    <option value="FAIL"${iopt(res==="FAIL")} style="color:#000">FAIL</option>
                </select>
            </td>
            <td style="text-align:center;white-space:nowrap">
                <button class="btn-save-row auth-write" onclick="saveTMRow(${r.id})">Save</button>
                <button class="btn-del-row auth-admin"  onclick="deleteTMRow(${r.id})">Del</button>
            </td>
        </tr>`;
    }).join("");
    applyAuthUI(window.authRole);
}

async function saveTMRow(id) {
    const resultVal = document.getElementById(`tm-result-${id}`)?.value || "";
    const dateVal   = _fullDateVal(`tm-date-${id}`);
    const completed = resultVal === "PASS";
    const payload = {
        design_pressure: document.getElementById(`tm-dp-${id}`)?.value?.trim()     || null,
        test_pressure:   document.getElementById(`tm-tp-${id}`)?.value?.trim()     || null,
        method:          document.getElementById(`tm-method-${id}`)?.value          || null,
        media:           document.getElementById(`tm-media-${id}`)?.value          || null,
        holding_time:    document.getElementById(`tm-holding-${id}`)?.value?.trim()|| null,
        date_completed:  dateVal || null,
        completed:       completed,
        description:     document.getElementById(`tm-desc-${id}`)?.value?.trim() || null
    };
    try {
        const res = await fetch(`/api/testpkg-master/${id}`, {
            method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Save failed");
        toast("Saved");
        loadTestMaster();
    } catch(e) { toast(e.message, "error"); }
}

async function deleteTMRow(id) {
    if (!confirm("Delete this Test Package?")) return;
    try {
        const res = await fetch(`/api/testpkg-master/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Delete failed");
        toast("Deleted");
        loadTestMaster();
    } catch(e) { toast(e.message, "error"); }
}

async function syncTestMaster() {
    if (!confirm("Auto-register the package list from Pkg Master into Test Master.\nAlready-registered packages will be skipped. Continue?")) return;
    try {
        const res  = await fetch("/api/testpkg-master/sync", { method: "POST" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Sync failed");
        toast(`Sync complete: ${data.inserted} newly registered (${data.total} total)`);
        loadTestMaster();
    } catch(e) { toast(e.message, "error"); }
}

// ================================================================================
//  RT QUALITY PERFORMANCE
// ================================================================================
let _rtData = null;

// rt_finding 텍스트 → 약어 변환
function _rtFindingAbbr(f) {
    if (!f || f === "Unknown") return "Unknown";
    const map = [
        [/crack/i,                   "CRACK"],
        [/porosity|poros/i,          "POROS"],
        [/lack of fusion|lof/i,      "LOF"],
        [/incomplete fusion/i,       "INC.FUS"],
        [/incomplete penetration|ip\b/i, "INC.PEN"],
        [/undercut/i,                "UC"],
        [/root concavity/i,          "ROOT-C"],
        [/concavity/i,               "CONC"],
        [/burn.?through/i,           "B/T"],
        [/slag/i,                    "SLAG"],
        [/tungsten/i,                "TI"],
        [/void/i,                    "VOID"],
        [/overlap/i,                 "OVLP"],
        [/misalignment/i,            "MIS"],
    ];
    for (const [re, abbr] of map) {
        if (re.test(f)) return abbr;
    }
    return f.length > 9 ? f.slice(0, 8) + "." : f;
}

async function loadRtQuality() {
    try {
        const res = await fetch("/api/rt-quality");
        if (!res.ok) throw new Error("API error " + res.status);
        _rtData = await res.json();
        _renderRtKpi(_rtData.kpi);
        _renderRtFindingChart(_rtData.by_finding);
        _renderRtMonthlyChart(_rtData.by_month);
        _renderRtSystemTable(_rtData.by_system);
        _renderRtWelderTable(_rtData.by_welder);
        _renderRtRepairList(_rtData.repair_list);
    } catch(e) {
        console.error("RT Quality load failed", e);
    }
}

function _renderRtKpi(kpi) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("rt-repair-rate", kpi.repair_rate != null ? kpi.repair_rate.toFixed(1) + "%" : "—");
    set("rt-total",       kpi.total_rt     ?? "—");
    set("rt-first-pass",  kpi.first_pass   ?? "—");
    set("rt-repair",      kpi.repair       ?? "—");
    set("rt-second-pass", kpi.second_pass  ?? "—");
    set("rt-second-fail", kpi.second_fail  ?? "—");
    set("rt-welders",     kpi.welder_count ?? "—");
}

function _renderRtFindingChart(byFinding) {
    destroyChart("rtFindingChart");
    const el = document.getElementById("rtFindingChart");
    if (!el) return;
    if (!byFinding || !byFinding.length) {
        el.parentElement.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--green);font-size:13px">No defects recorded</div>`;
        return;
    }
    const labels = byFinding.map(d => _rtFindingAbbr(d.finding));
    const counts = byFinding.map(d => d.count);
    charts["rtFindingChart"] = new Chart(el.getContext("2d"), {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Count",
                data: counts,
                backgroundColor: "rgba(37,99,235,0.5)",
                borderColor: "#2563eb",
                borderWidth: 1,
                barPercentage: 0.35,
                categoryPercentage: 0.6,
                datalabels: {
                    display: true,
                    color: "#2563eb",
                    font: { size: 14, weight: "bold" },
                    anchor: "end",
                    align: "top",
                    offset: 4,
                    formatter: v => v
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            layout: { padding: { top: 32 } },
            scales: {
                x: { ticks: { color: "#94a3b8", font: { size: 11 } }, grid: { display: false } },
                y: {
                    beginAtZero: true,
                    suggestedMax: Math.max(...counts) * 1.5,
                    ticks: { color: "#7a95b8", font: { size: 10 }, stepSize: 1 },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

// Monthly RT Trend — 범례 오른쪽, 막대 라벨 막대 위에 표시, % 라벨 아래 배치로 겹침 방지
function _renderRtMonthlyChart(byMonth) {
    destroyChart("rtMonthlyChart");
    const el = document.getElementById("rtMonthlyChart");
    if (!el || !byMonth.length) return;

    const maxTotal = Math.max(...byMonth.map(m => m.total));

    charts["rtMonthlyChart"] = new Chart(el.getContext("2d"), {
        type: "bar",
        data: {
            labels: byMonth.map(m => m.month),
            datasets: [
                {
                    type: "bar",
                    label: "Total RT",
                    data: byMonth.map(m => m.total),
                    backgroundColor: "rgba(37,99,235,0.5)",
                    borderColor: "#2563eb",
                    borderWidth: 1,
                    barPercentage: 0.46,
                    categoryPercentage: 0.65,
                    yAxisID: "y",
                    datalabels: {
                        display: ctx => ctx.dataset.data[ctx.dataIndex] > 0,
                        color: "#2563eb",
                        font: { size: 12, weight: "bold" },
                        anchor: "end",
                        align: "top",
                        offset: 4,
                        formatter: v => v
                    }
                },
                {
                    type: "bar",
                    label: "Repair",
                    data: byMonth.map(m => m.repair),
                    backgroundColor: "rgba(34,211,161,0.4)",
                    borderColor: "#22d3a1",
                    borderWidth: 1,
                    barPercentage: 0.46,
                    categoryPercentage: 0.65,
                    yAxisID: "y",
                    datalabels: {
                        display: ctx => ctx.dataset.data[ctx.dataIndex] > 0,
                        color: "#2563eb",
                        font: { size: 12, weight: "bold" },
                        anchor: "end",
                        align: "top",
                        offset: 4,
                        formatter: v => v
                    }
                },
                {
                    type: "line",
                    label: "Repair Rate (%)",
                    data: byMonth.map(m => m.repair_rate),
                    borderColor: "#2563eb",
                    backgroundColor: "rgba(37,99,235,0.08)",
                    borderWidth: 2,
                    pointRadius: 5,
                    pointBackgroundColor: "#2563eb",
                    tension: 0.3,
                    yAxisID: "y2",
                    datalabels: {
                        display: true,
                        color: "#2563eb",
                        font: { size: 12, weight: "bold" },
                        anchor: "end",
                        align: "top",
                        offset: 4,
                        formatter: v => v.toFixed(1) + "%"
                    }
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            layout: { padding: { top: 36, bottom: 4 } },
            interaction: { mode: "index", intersect: false },
            scales: {
                x: { ticks: { color: "#7a95b8", font: { size: 10 } }, grid: { display: false } },
                y: {
                    type: "linear", position: "left", beginAtZero: true,
                    suggestedMax: maxTotal * 1.5,
                    ticks: { color: "#2563eb", font: { size: 10 }, stepSize: 1 },
                    grid: { color: "rgba(0,0,0,0.05)" }
                },
                y2: {
                    type: "linear", position: "right", beginAtZero: true,
                    ticks: { color: "#2563eb", font: { size: 10 }, callback: v => v + "%" },
                    grid: { display: false }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                    align: "end",
                    labels: { color: "#475569", font: { size: 10 }, boxWidth: 12, padding: 10 }
                }
            }
        }
    });
}

// Repair Rate 색상 헬퍼
function _rtRateColor(rate) {
    if (rate >= 20) return "#ef4444";
    if (rate >= 10) return "var(--orange)";
    if (rate > 0)   return "var(--yellow)";
    return "var(--green)";
}

const _RT_MONO = "font-family:'DM Mono',monospace";

// 공통 테이블 행 렌더 헬퍼 — 수치 단색(--text-dim), Repair Rate만 색상, 2nd PASS 열 없음
function _rtTableRow(nameCell, r) {
    const rateColor = _rtRateColor(r.repair_rate);
    const dim = "text-align:center;color:var(--text-dim);" + _RT_MONO;
    return `<tr>
        ${nameCell}
        <td style="${dim}">${r.total || 0}</td>
        <td style="${dim}">${r.pass || 0}</td>
        <td style="${dim}">${r.repair || 0}</td>
        <td style="${dim}">${r.remaining || 0}</td>
        <td style="text-align:center;${_RT_MONO};color:${rateColor};font-weight:700">${(r.repair_rate || 0).toFixed(1)}%</td>
    </tr>`;
}

function _renderRtSystemTable(bySystem) {
    const tbody = document.getElementById("rtSystemBody");
    if (!tbody) return;
    if (!bySystem.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No data</td></tr>`;
        return;
    }
    tbody.innerHTML = bySystem.map(r =>
        _rtTableRow(`<td style="text-align:center;color:var(--text-dim)">${r.system}</td>`, r)
    ).join("");
}

function _renderRtWelderTable(byWelder) {
    const tbody = document.getElementById("rtWelderBody");
    if (!tbody) return;
    if (!byWelder.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No data</td></tr>`;
        return;
    }
    tbody.innerHTML = byWelder.map(r =>
        _rtTableRow(`<td style="text-align:center;color:var(--text-dim)">${r.welder}</td>`, r)
    ).join("");
}

function _renderRtRepairList(repairList) {
    const tbody   = document.getElementById("rtRepairBody");
    const countEl = document.getElementById("rtRepairCount");
    if (!tbody) return;
    if (countEl) countEl.textContent = `(${repairList.length} joints)`;
    if (!repairList.length) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--green)">No repairs — 100% 1st pass!</td></tr>`;
        return;
    }
    tbody.innerHTML = repairList.map(r => {
        const res2Color = r.rt_2_result === "PASS" ? "var(--green)" : r.rt_2_result === "FAIL" ? "#ef4444" : "var(--text-dim)";
        return `<tr>
            <td style="color:var(--text-dim)">${r.system || "—"}</td>
            <td style="text-align:center">${r.sf || "—"}</td>
            <td style="font-size:10px">${r.iso_drawing || "—"}</td>
            <td style="text-align:center">${r.joint_no || "—"}</td>
            <td style="color:var(--accent)">${r.welder || "—"}</td>
            <td style="font-family:'DM Mono',monospace;font-size:10px">${r.rt_date ? r.rt_date.slice(0,10) : "—"}</td>
            <td style="text-align:center;color:#ef4444;font-weight:700">${r.rt_result || "—"}</td>
            <td style="font-size:9px">${r.rt_finding || "—"}</td>
            <td style="font-family:'DM Mono',monospace;font-size:10px">${r.rt_2_date ? r.rt_2_date.slice(0,10) : "—"}</td>
            <td style="text-align:center;color:${res2Color};font-weight:700">${r.rt_2_result || "—"}</td>
        </tr>`;
    }).join("");
}

async function exportTMExcel() {
    await ensureXlsx();
    toast("Loading data...", "info");
    const params = _readFilters([["tm-system","system"],["tm-package","test_pkg_no"],["tm-status","status"],["tm-search","q"]]);
    params.set("skip_readiness", "1");
    const data = await _fetchAllFiltered("/api/testpkg-master", params);
    if (!data.length) { toast("No data", "error"); return; }
    const rows = data.map((r,i) => ({
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
        "Description":      r.description      || ""
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "TestMaster");
    const ok = await downloadWithPicker(wb, "Test_Master_Export.xlsx");
    if (ok) toast(`✓ ${data.length.toLocaleString()} rows exported`);
}

// ================================================================================
//  DAILY REPORT
// ================================================================================
async function loadDailyReport() {
    try {
        const res = await apiFetch("/api/daily-report");
        const { daily = [], last_date = "", breakdowns = {} } = res;

        _drBreakdowns = breakdowns;
        _drSelectedDate = last_date;

        // ── Daily Summary Table (PIPING GROUP + SUPPORT GROUP) ──
        const summaryBody = document.getElementById("drSummaryBody");
        if (summaryBody) {
            let tFab = 0, tErect = 0, tComp = 0, tWeld = 0, tSuppSpecial = 0, tSuppTypical = 0, tSuppComp = 0;
            let html = daily.map(r => {
                tFab        += r.fab_di        || 0;
                tErect      += r.erect_di      || 0;
                tComp       += r.completed_di  || 0;
                tWeld       += r.welder_count  || 0;
                tSuppSpecial += r.supp_special || 0;
                tSuppTypical += r.supp_typical || 0;
                tSuppComp   += r.supp_completed|| 0;
                const isSelected = r.date === last_date;
                return `<tr id="drRow_${r.date}" onclick="selectDailyDate('${r.date}')" style="cursor:pointer${isSelected ? ";background:rgba(37,99,235,0.18)" : ""}">
                    <td style="color:var(--accent);font-weight:${isSelected?"700":"400"}">${r.date}</td>
                    <td>${r.welder_count || 0}</td>
                    <td>${fmtNum(r.fab_di, 1)}</td>
                    <td>${fmtNum(r.erect_di, 1)}</td>
                    <td style="color:var(--accent)">${fmtNum(r.completed_di, 1)}</td>
                    <td style="color:#22d3a1">${r.supp_special || 0}</td>
                    <td style="color:#22d3a1">${r.supp_typical || 0}</td>
                    <td style="color:#22d3a1">${r.supp_completed || 0}</td>
                </tr>`;
            }).join("");
            html += `<tr style="background:rgba(37,99,235,0.07);border-top:2px solid var(--border)">
                <td style="font-weight:700;color:var(--accent)">Total</td>
                <td style="font-weight:700">${tWeld}</td>
                <td style="font-weight:700">${fmtNum(tFab, 1)}</td>
                <td style="font-weight:700">${fmtNum(tErect, 1)}</td>
                <td style="font-weight:700;color:var(--accent)">${fmtNum(tComp, 1)}</td>
                <td style="font-weight:700;color:#22d3a1">${tSuppSpecial}</td>
                <td style="font-weight:700;color:#22d3a1">${tSuppTypical}</td>
                <td style="font-weight:700;color:#22d3a1">${tSuppComp}</td>
            </tr>`;
            summaryBody.innerHTML = html;
        }

        renderDrBreakdown(last_date);

    } catch(e) { console.error("Daily Report failed", e); }
}

function renderDrBreakdown(date) {
    const bd = _drBreakdowns[date];
    if (!bd) return;
    const { systems = [], subareas = [], materials = [] } = bd;

    const label = date ? `[${date}]` : "";
    const drEl = id => document.getElementById(id);
    if (drEl("drMaterialTitle")) drEl("drMaterialTitle").textContent = `${label} Breakdown — By Material`;
    if (drEl("drSystemTitle"))   drEl("drSystemTitle").textContent   = `${label} Breakdown — By System`;
    if (drEl("drSubareaTitle"))  drEl("drSubareaTitle").textContent  = `${label} Breakdown — By Sub Area (1)`;
    if (drEl("drSubareaTitle2")) drEl("drSubareaTitle2").textContent = `${label} Breakdown — By Sub Area (2)`;

    const mkDataRows = (arr, nameKey) => arr.map(r => `<tr>
        <td style="color:var(--accent)">${r[nameKey] || ""}</td>
        <td>${fmtNum(r.fab_di || 0, 1)}</td>
        <td>${fmtNum(r.erect_di || 0, 1)}</td>
        <td style="color:var(--accent)">${fmtNum(r.completed_di || 0, 1)}</td>
    </tr>`).join("");

    const mkTotalRow = arr => {
        const tF = arr.reduce((s, r) => s + (r.fab_di || 0), 0);
        const tE = arr.reduce((s, r) => s + (r.erect_di || 0), 0);
        const tC = arr.reduce((s, r) => s + (r.completed_di || 0), 0);
        return `<tr style="background:rgba(37,99,235,0.07);border-top:2px solid var(--border)">
            <td style="font-weight:700;color:var(--accent)">Total</td>
            <td style="font-weight:700">${fmtNum(tF, 1)}</td>
            <td style="font-weight:700">${fmtNum(tE, 1)}</td>
            <td style="font-weight:700;color:var(--accent)">${fmtNum(tC, 1)}</td>
        </tr>`;
    };

    const sysBody = document.querySelector("#drSystemTable tbody");
    if (sysBody) sysBody.innerHTML = mkDataRows(systems, "system") + mkTotalRow(systems);

    const matBody = document.querySelector("#drMaterialTable tbody");
    if (matBody) matBody.innerHTML = mkDataRows(materials, "mat") + mkTotalRow(materials);

    const mid = Math.ceil(subareas.length / 2);
    const subBody1 = document.querySelector("#drSubareaTable tbody");
    const subBody2 = document.querySelector("#drSubareaTable2 tbody");
    if (subBody1) subBody1.innerHTML = mkDataRows(subareas.slice(0, mid), "sub_area");
    if (subBody2) subBody2.innerHTML = mkDataRows(subareas.slice(mid), "sub_area") + mkTotalRow(subareas);
}

function selectDailyDate(date) {
    if (_drSelectedDate) {
        const prev = document.getElementById(`drRow_${_drSelectedDate}`);
        if (prev) {
            prev.style.background = "";
            prev.querySelector("td").style.fontWeight = "400";
        }
    }
    _drSelectedDate = date;
    const row = document.getElementById(`drRow_${date}`);
    if (row) {
        row.style.background = "rgba(37,99,235,0.18)";
        row.querySelector("td").style.fontWeight = "700";
    }
    renderDrBreakdown(date);
}

async function exportDailyReportExcel() {
    await ensureXlsx();
    const res = await apiFetch("/api/daily-report");
    const { daily = [] } = res;
    if (!daily.length) { toast("No data"); return; }
    const rows = daily.map(r => ({
        "Date":        r.date,
        "Welders":     r.welder_count,
        "Fabrication": r.fab_di,
        "Erection":    r.erect_di,
        "Completed":   r.completed_di,
        "Supp Special":   r.supp_special,
        "Supp Typical":   r.supp_typical,
        "Supp Completed": r.supp_completed,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "DailyReport");
    const ok = await downloadWithPicker(wb, "Daily_Report_Export.xlsx");
    if (ok) toast(`✓ ${daily.length.toLocaleString()} rows exported`);
}
