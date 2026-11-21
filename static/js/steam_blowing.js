// Steam Blowing(임시 배관) 탭 — SB 조인트 물량만 보여준다 (Permanent 배관과 분리)
let _sbData = null;

async function loadSteamBlowing() {
    const host = document.getElementById("sbStatus");
    try {
        if (!_sbData) host.textContent = "Loading…";
        _sbData = await apiFetchRetry("/api/sb-summary");
        host.textContent = "";
        renderSteamBlowing(_sbData);
    } catch (e) {
        host.textContent = "Failed to load Steam Blowing data";
        console.error("sb-summary failed", e);
    }
}

// Steam Blowing은 Hydro Test가 없어 Piping 80% · Support 20%로 관리한다 (Test Package 가중치 없음)
const SB_WEIGHT = { piping: 0.8, support: 0.2 };

function _sbGauge(pathId, textId, pct, color) {
    const gp = document.getElementById(pathId);
    if (gp) { gp.style.stroke = color; gp.style.strokeDashoffset = Math.PI * 84 * (1 - Math.min(pct / 100, 1)); }
    const gt = document.getElementById(textId);
    if (gt) { gt.textContent = `${pct.toFixed(2)}%`; gt.style.fill = color; }
}

function renderSteamBlowing(d) {
    const k = d.kpi || {}, sup = d.support || { total: 0, completed: 0 };
    const total = k.total_di || 0, done = k.completed_di || 0, rem = Math.max(0, total - done);
    const pct = total > 0 ? parseFloat((done / total * 100).toFixed(2)) : 0;
    const supPct = sup.total > 0 ? parseFloat((sup.completed / sup.total * 100).toFixed(2)) : 0;
    const overall = parseFloat((pct * SB_WEIGHT.piping + supPct * SB_WEIGHT.support).toFixed(2));
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const color = p => p >= 80 ? "#22d3a1" : p >= 50 ? "#f5c542" : "#ff8c42";
    const sch = d.schedule || {};
    const planPct = _sbPlanPct(sch);

    const supRem = Math.max(0, sup.total - sup.completed);
    const wP = Math.round(SB_WEIGHT.piping * 100), wS = Math.round(SB_WEIGHT.support * 100);

    // KPI 행 — SB Progress = Piping 80% + Support 20%
    set("sb-kpi-pct", `${overall.toFixed(2)}%`);
    const pctEl = document.getElementById("sb-kpi-pct"); if (pctEl) pctEl.style.color = pctColor(overall);
    const bar = document.getElementById("sb-kpi-bar");
    if (bar) { bar.style.width = `${Math.min(overall, 100)}%`; bar.style.background = pctColor(overall); }
    set("sb-kpi-pct-sub", `PIPING ${wP}% · SUPPORT ${wS}%`);
    set("sbSchedule", sch.start ? `Schedule ${sch.start} ~ ${sch.end}` : "");
    set("sb-kpi-total", `${pct.toFixed(2)}%`);
    const tEl = document.getElementById("sb-kpi-total"); if (tEl) tEl.style.color = pctColor(pct);
    set("sb-kpi-total-sub", `${fmtNum(done, 0)} / ${fmtNum(total, 0)} DI`);
    set("sb-kpi-rem", fmtNum(rem, 0));
    set("sb-kpi-rem-sub", total > 0 ? `${(100 - pct).toFixed(2)}% of piping DI` : "—");
    set("sb-kpi-sup", `${supPct.toFixed(2)}%`);
    const sEl = document.getElementById("sb-kpi-sup"); if (sEl) sEl.style.color = pctColor(supPct);
    set("sb-kpi-sup-sub", `${fmtNum(sup.completed, 0)} / ${fmtNum(sup.total, 0)} EA`);
    set("sb-kpi-suptotal", fmtNum(sup.total, 0));
    set("sb-kpi-suptotal-sub", "EA");
    set("sb-kpi-supdone", fmtNum(sup.completed, 0));
    set("sb-kpi-supdone-sub", sup.total > 0 ? `${supPct.toFixed(2)}% of total` : "—");
    set("sb-kpi-suprem", fmtNum(supRem, 0));
    set("sb-kpi-suprem-sub", sup.total > 0 ? `${(100 - supPct).toFixed(2)}% of total` : "—");

    // 게이지 — EP 탭과 같은 모양 (Piping, Support). 두 게이지 아래 목록은 4줄로 맞춘다
    _sbGauge("sbGaugePath", "sbGaugeText", pct, color(pct));
    _sbGauge("sbSupportGaugePath", "sbSupportGaugeText", supPct, color(supPct));
    const rows = (el, list) => { const e = document.getElementById(el); if (e) e.innerHTML = list.map(([l, v]) => `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`).join(""); };
    rows("sbStats", [
        ["Total DI", fmtNum(total, 0)],
        ["Completed DI", fmtNum(done, 0)],
        ["Remaining DI", fmtNum(rem, 0)],
        ["Plan (today) / Diff", planPct == null ? "—" : `${planPct.toFixed(2)}% / ${(pct - planPct >= 0 ? "+" : "")}${(pct - planPct).toFixed(2)}%`]
    ]);
    rows("sbSupportStats", [
        ["Total Support (EA)", fmtNum(sup.total, 0)],
        ["Completed (EA)", fmtNum(sup.completed, 0)],
        ["Remaining (EA)", fmtNum(supRem, 0)],
        ["Weight", `Piping ${wP}% · Support ${wS}%`]
    ]);

    _sbDrawTable("sbServiceBody", d.service || []);
    _sbDrawTable("sbUnitBody", d.unit || []);
    _sbDrawWeekly(d.weekly || [], sch, total);
}

// TOTAL 행을 맨 위에 두고 이름순 행을 아래에 둔다 (EP 표와 같은 방식)
function _sbDrawTable(bodyId, rows) {
    const el = document.getElementById(bodyId);
    if (!el) return;
    const td = "padding:3px 5px;font-size:11px";
    const cells = r => {
        const tot = r.total_di || 0, comp = r.completed_di || 0, rem = Math.max(0, tot - comp), p = tot > 0 ? comp / tot * 100 : null;
        return `<td style="${td}">${fmtNum(tot, 0)}</td><td style="${td};color:var(--green)">${fmtNum(comp, 0)}</td>` +
            `<td style="${td};color:${rem > 0 ? "var(--orange)" : "var(--green)"}">${fmtNum(rem, 0)}</td>` +
            `<td style="${td};color:${p == null ? "var(--text-dim)" : pctColor(p)}">${p == null ? "—" : p.toFixed(2) + "%"}</td>` +
            `<td style="${td}">${(r.joints || 0).toLocaleString()}</td>`;
    };
    const sum = rows.reduce((s, r) => ({ total_di: s.total_di + (r.total_di || 0), completed_di: s.completed_di + (r.completed_di || 0), joints: s.joints + (r.joints || 0) }),
        { total_di: 0, completed_di: 0, joints: 0 });
    el.innerHTML =
        `<tr style="background:rgba(37,99,235,0.07);border-bottom:2px solid var(--border);font-weight:700"><td style="${td};color:var(--accent)">TOTAL</td>${cells(sum)}</tr>` +
        rows.map(r => `<tr><td style="${td}">${esc(r.name || "")}</td>${cells(r)}</tr>`).join("");
}

// 일정 기간 안에서 오늘까지 계획 공정률(%) — 총 물량을 일정 기간에 균등 배분한다고 본다
const _SB_DAY = 86400000;
const _sbDate = s => new Date(s + "T00:00:00Z");
const _sbIso = t => new Date(t).toISOString().slice(0, 10);
function _sbPlanPct(sch, asOf) {
    if (!sch || !sch.start) return null;
    const s = _sbDate(sch.start).getTime(), e = _sbDate(sch.end).getTime();
    const today = asOf ? _sbDate(asOf).getTime() : _sbDate(new Date().toISOString().slice(0, 10)).getTime();
    return Math.max(0, Math.min(1, ((today - s) / _SB_DAY + 1) / ((e - s) / _SB_DAY + 1))) * 100;
}

// 주별 완료 DI(막대) + 누적 실적(선) + 계획(점선). x축은 일정 기간의 주(월요일 시작)이고, 일정 밖의 실적 주도 포함한다
function _sbDrawWeekly(weekly, sch, totalDi) {
    const canvas = document.getElementById("sbWeeklyChart"), empty = document.getElementById("sbWeeklyEmpty");
    if (!canvas) return;
    if (charts["sbWeeklyChart"]) { charts["sbWeeklyChart"].destroy(); delete charts["sbWeeklyChart"]; }
    const hasSch = !!(sch && sch.start);
    if (!hasSch && !weekly.length) { canvas.style.display = "none"; if (empty) empty.style.display = "flex"; return; }
    canvas.style.display = ""; if (empty) empty.style.display = "none";
    const mondayOf = t => { const dt = new Date(t); return dt.getTime() - ((dt.getUTCDay() + 6) % 7) * _SB_DAY; };
    const first = Math.min(...[hasSch ? mondayOf(_sbDate(sch.start)) : Infinity, ...weekly.map(w => _sbDate(w.week_start).getTime())]);
    const last = Math.max(...[hasSch ? mondayOf(_sbDate(sch.end)) : -Infinity, ...weekly.map(w => _sbDate(w.week_start).getTime())]);
    const weeks = []; for (let t = first; t <= last; t += 7 * _SB_DAY) weeks.push(_sbIso(t));
    const act = Object.fromEntries(weekly.map(w => [w.week_start, w.completed_di]));
    const todayTs = _sbDate(new Date().toISOString().slice(0, 10)).getTime();
    let cum = 0;
    const cumData = weeks.map(w => { cum += act[w] || 0; return _sbDate(w).getTime() <= todayTs || act[w] ? cum : null; });   // 아직 오지 않은 주는 선을 끊는다
    const planData = hasSch ? weeks.map(w => { const wEnd = _sbDate(w).getTime() + 6 * _SB_DAY; return Math.round(totalDi * (_sbPlanPct(sch, _sbIso(wEnd)) / 100)); }) : [];
    charts["sbWeeklyChart"] = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: { labels: weeks.map(w => w.slice(5)), datasets: [
            ...(hasSch ? [{ label: "Plan (cumulative)", type: "line", yAxisID: "yL", data: planData, borderColor: "rgba(255,82,82,0.6)", borderDash: [4, 4], borderWidth: 1.5, fill: false, pointRadius: 0 }] : []),
            { label: "Actual (cumulative)", type: "line", yAxisID: "yL", data: cumData, borderColor: "#22d3a1", borderWidth: 2, fill: false, pointRadius: 3, spanGaps: false },
            { label: "Weekly DI", type: "bar", yAxisID: "yR", data: weeks.map(w => act[w] || null), backgroundColor: "rgba(37,99,235,0.55)", datalabels: { display: false } }
        ]},
        options: { ...chartOpts(""),
            scales: {
                x: { ...chartOpts("").scales.x, ticks: { ...chartOpts("").scales.x.ticks, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
                yL: { type: "linear", position: "left", beginAtZero: true, ticks: { color: "#4a6080", font: { size: 9 } }, title: { display: true, text: "Cumulative DI", color: "#4a6080", font: { size: 9 } } },
                yR: { type: "linear", position: "right", beginAtZero: true, grid: { display: false }, ticks: { color: "#5b8def", font: { size: 9 } }, title: { display: true, text: "Weekly DI", color: "#5b8def", font: { size: 9 } } }
            },
            plugins: { ...chartOpts("").plugins, legend: { display: true, position: "top", labels: { color: "#7a95b8", boxWidth: 10, padding: 8, font: { size: 10 } } } },
            animation: { duration: 400 } }
    });
}

async function exportSteamBlowingExcel() {
    await exportTablesExcel([["sbServiceBody", "By Service"], ["sbUnitBody", "By Unit"]], "Steam_Blowing_Export.xlsx");
}
