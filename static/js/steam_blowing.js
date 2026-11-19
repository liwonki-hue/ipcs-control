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

function renderSteamBlowing(d) {
    const k = d.kpi || {};
    const total = k.total_di || 0, done = k.completed_di || 0, rem = Math.max(0, total - done);
    const pct = total > 0 ? parseFloat((done / total * 100).toFixed(2)) : 0;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    set("sb-kpi-pct", `${pct.toFixed(2)}%`);
    const pctEl = document.getElementById("sb-kpi-pct"); if (pctEl) pctEl.style.color = pctColor(pct);
    const bar = document.getElementById("sb-kpi-bar");
    if (bar) { bar.style.width = `${Math.min(pct, 100)}%`; bar.style.background = pctColor(pct); }
    set("sb-kpi-pct-sub", `${(k.completed_joints || 0).toLocaleString()} / ${(k.joints || 0).toLocaleString()} joints`);
    set("sb-kpi-total", fmtNum(total, 0));
    set("sb-kpi-total-sub", `${(k.joints || 0).toLocaleString()} joints · ${(k.isos || 0).toLocaleString()} ISO`);
    set("sb-kpi-done", fmtNum(done, 0));
    set("sb-kpi-done-sub", total > 0 ? `${pct.toFixed(2)}% of total DI` : "—");
    set("sb-kpi-rem", fmtNum(rem, 0));
    set("sb-kpi-rem-sub", total > 0 ? `${(100 - pct).toFixed(2)}% of total DI` : "—");

    // 게이지 — EP 탭과 같은 모양
    const circ = Math.PI * 84, gc = pct >= 80 ? "#22d3a1" : pct >= 50 ? "#f5c542" : "#ff8c42";
    const gp = document.getElementById("sbGaugePath");
    if (gp) { gp.style.stroke = gc; gp.style.strokeDashoffset = circ * (1 - Math.min(pct / 100, 1)); }
    const gt = document.getElementById("sbGaugeText");
    if (gt) { gt.textContent = `${pct.toFixed(2)}%`; gt.style.fill = gc; }
    const stats = document.getElementById("sbStats");
    if (stats) {
        stats.innerHTML = [
            ["SB Piping (D/I)", `${fmtNum(done, 0)} / ${fmtNum(total, 0)}`],
            ["Joints", `${(k.completed_joints || 0).toLocaleString()} / ${(k.joints || 0).toLocaleString()}`],
            ["ISO Drawings", (k.isos || 0).toLocaleString()]
        ].map(([l, v]) => `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`).join("");
    }

    _sbDrawTable("sbServiceBody", d.service || []);
    _sbDrawTable("sbUnitBody", d.unit || []);
    _sbDrawWeekly(d.weekly || []);
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
        `<tr style="background:rgba(37,99,235,0.07);border-bottom:2px solid var(--border);font-weight:700"><td style="${td};text-align:left;color:var(--accent)">TOTAL</td>${cells(sum)}</tr>` +
        rows.map(r => `<tr><td style="${td};text-align:left">${esc(r.name || "")}</td>${cells(r)}</tr>`).join("");
}

// 주별 완료 DI(막대) + 누적(선). 완료된 조인트가 아직 없으면 안내 문구만 보여준다
function _sbDrawWeekly(weekly) {
    const canvas = document.getElementById("sbWeeklyChart"), empty = document.getElementById("sbWeeklyEmpty");
    if (!canvas) return;
    if (charts["sbWeeklyChart"]) { charts["sbWeeklyChart"].destroy(); delete charts["sbWeeklyChart"]; }
    const has = weekly.length > 0;
    canvas.style.display = has ? "" : "none";
    if (empty) empty.style.display = has ? "none" : "flex";
    if (!has) return;
    let cum = 0;
    const cumData = weekly.map(w => (cum += w.completed_di));
    charts["sbWeeklyChart"] = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: { labels: weekly.map(w => w.week_start.slice(5)), datasets: [
            { label: "Cumulative", type: "line", yAxisID: "yL", data: cumData, borderColor: "#22d3a1", borderWidth: 2, fill: false, pointRadius: 3 },
            { label: "Weekly DI", type: "bar", yAxisID: "yR", data: weekly.map(w => w.completed_di), backgroundColor: "rgba(37,99,235,0.55)", datalabels: { display: false } }
        ]},
        options: { ...chartOpts(""),
            scales: {
                x: { ...chartOpts("").scales.x },
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
