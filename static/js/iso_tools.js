// ISO Status · Data Quality · Pace & Forecast 화면 (ISO Drawing 단위 현황, 데이터 점검, System별 완료 예측)
// dashboard.js 다음에 로드된다. apiFetch · esc · fmtNum · toast · navigate · printPage · downloadWithPicker · ensureXlsx를 쓴다.

const ISO_PAGE_SIZE = 100;
const _ISO_STATUS_LABEL = { NOT_STARTED: "Not started", WELDING: "Welding", WELDED: "Welded · inspection pending", ACCEPTED: "Accepted" };
const _ISO_STATUS_COLOR = { NOT_STARTED: "#94a3b8", WELDING: "#2563eb", WELDED: "#f59e0b", ACCEPTED: "#059669" };
const _ISO_QUICK = {
    "": () => true,
    NOT_STARTED: r => r.status === "NOT_STARTED",
    WELDING: r => r.status === "WELDING",
    WELDED: r => r.status === "WELDED",
    ACCEPTED: r => r.status === "ACCEPTED",
    FAB_ERECT: r => r.fab_done_erect_open,
    SUPPORT_OPEN: r => r.sup_n > r.sup_done,
};
const _iso = { rows: [], page: 0, sort: { key: "iso", dir: 1 }, filtered: [], meta: null };

function _isoUpdatedText(meta) {
    if (!meta) return "";
    return `Updated ${meta.built_at} (ALMT)` + (meta.fresh === false ? " · refreshing in background" : "");
}

function _isoLoadError(e, hostId) {
    const el = document.getElementById(hostId);
    if (!el) return;
    const needLogin = /401/.test(String(e && e.message));
    el.innerHTML = needLogin
        ? `<div style="padding:18px;color:var(--text-dim)">Sign in to use this page. <button class="btn-primary" style="margin-left:8px;padding:4px 12px" onclick="openSignInModal()">Sign in</button></div>`
        : `<div style="padding:18px;color:var(--red)">Failed to load: ${esc(e && e.message)}</div>`;
}

// ── ISO Status ────────────────────────────────────────────────────────
async function loadIsoStatus() {
    const note = document.getElementById("iso-updated");
    if (!_iso.rows.length && note) note.textContent = "Loading… (the first load can take about 30 seconds)";
    try {
        const d = await apiFetch("/api/iso-status", { noCache: true });
        _iso.rows = d.isos || [];
        _iso.meta = d;
        if (note) note.textContent = _isoUpdatedText(d);
        _isoFillSelect("iso-system", "System", r => r.system);
        _isoFillSelect("iso-subarea", "Sub Area", r => r.sub_area);
        _isoRenderSummary();
        isoRender(true);
    } catch (e) {
        if (note) note.textContent = "";
        _isoLoadError(e, "iso-body-msg");
        document.getElementById("iso-body").innerHTML = "";
    }
}

function _isoFillSelect(id, label, pick) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    const vals = [...new Set(_iso.rows.map(pick).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">${esc(label)}</option>` + vals.map(v => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`).join("");
}

function _isoRenderSummary() {
    const count = key => _iso.rows.filter(_ISO_QUICK[key]).length;
    const chips = [
        ["", "All", _iso.rows.length, "#475569"],
        ["NOT_STARTED", "Not started", count("NOT_STARTED"), _ISO_STATUS_COLOR.NOT_STARTED],
        ["WELDING", "Welding", count("WELDING"), _ISO_STATUS_COLOR.WELDING],
        ["WELDED", "Welded · inspection pending", count("WELDED"), _ISO_STATUS_COLOR.WELDED],
        ["ACCEPTED", "Accepted", count("ACCEPTED"), _ISO_STATUS_COLOR.ACCEPTED],
        ["FAB_ERECT", "Fab done · Erect open", count("FAB_ERECT"), "#7c3aed"],
        ["SUPPORT_OPEN", "Support open", count("SUPPORT_OPEN"), "#0891b2"],
    ];
    const cur = document.getElementById("iso-quick")?.value || "";
    document.getElementById("iso-summary").innerHTML = chips.map(([key, label, n, color]) =>
        `<button onclick="isoQuick('${key}')" style="cursor:pointer;border:1px solid ${color};border-radius:16px;padding:4px 12px;font-size:12px;font-weight:600;` +
        `background:${cur === key ? color : "transparent"};color:${cur === key ? "#fff" : color}">${esc(label)} <span style="font-family:'DM Mono',monospace">${n.toLocaleString()}</span></button>`).join("");
}

function isoQuick(key) {
    document.getElementById("iso-quick").value = key;
    _isoRenderSummary();
    isoRender(true);
}

function isoSort(key) {
    _iso.sort = { key, dir: _iso.sort.key === key ? -_iso.sort.dir : 1 };
    isoRender(true);
}

function isoPage(delta) {
    const pages = Math.max(1, Math.ceil(_iso.filtered.length / ISO_PAGE_SIZE));
    _iso.page = Math.min(pages - 1, Math.max(0, _iso.page + delta));
    isoRender(false);
}

function isoRender(resetPage) {
    if (resetPage) _iso.page = 0;
    const q = (document.getElementById("iso-search")?.value || "").trim().toLowerCase();
    const sys = document.getElementById("iso-system")?.value || "";
    const sub = document.getElementById("iso-subarea")?.value || "";
    const quick = _ISO_QUICK[document.getElementById("iso-quick")?.value || ""] || _ISO_QUICK[""];
    const { key, dir } = _iso.sort;
    _iso.filtered = _iso.rows.filter(r => quick(r) && (!sys || r.system === sys) && (!sub || r.sub_area === sub) &&
        (!q || r.iso.toLowerCase().includes(q) || (r.package || "").toLowerCase().includes(q)))
        .sort((a, b) => {
            const av = key === "pct" ? (a.di ? a.welded_di / a.di : 0) : a[key], bv = key === "pct" ? (b.di ? b.welded_di / b.di : 0) : b[key];
            return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""))) * dir || a.iso.localeCompare(b.iso);
        });
    const total = _iso.filtered.length, pages = Math.max(1, Math.ceil(total / ISO_PAGE_SIZE));
    const start = _iso.page * ISO_PAGE_SIZE;
    document.getElementById("iso-count").textContent = `${total.toLocaleString()} ISO` + (total ? ` · page ${_iso.page + 1} / ${pages}` : "");
    document.getElementById("iso-body-msg").innerHTML = total ? "" : `<div style="padding:18px;color:var(--text-dim)">No ISO matches the filters.</div>`;
    document.getElementById("iso-body").innerHTML = _iso.filtered.slice(start, start + ISO_PAGE_SIZE).map(_isoRowHtml).join("");
    document.querySelectorAll("#isoTable th[data-sort]").forEach(th => {
        th.dataset.arrow = th.dataset.sort === key ? (dir > 0 ? " ▲" : " ▼") : "";
        th.textContent = th.dataset.label + th.dataset.arrow;
    });
}

function _isoRowHtml(r) {
    const pct = r.di ? Math.round(r.welded_di / r.di * 100) : 0;
    const color = _ISO_STATUS_COLOR[r.status] || "#94a3b8";
    const cell = (done, n) => n ? `${done}/${n}` : "—";
    return `<tr data-iso="${esc(r.iso)}" onclick="isoOpenInJM(this.dataset.iso)" style="cursor:pointer" title="Open in Joint Master">
        <td style="font-size:11px;word-break:break-all">${esc(r.iso)}</td>
        <td style="text-align:center">${esc(r.rev)}</td>
        <td style="text-align:center">${esc(r.system)}</td>
        <td>${esc(r.sub_area)}</td>
        <td style="font-size:11px">${esc(r.package || "—")}</td>
        <td style="text-align:center">${r.n}</td>
        <td style="text-align:right">${fmtNum(r.di, 1)}</td>
        <td><div style="display:flex;align-items:center;gap:6px"><div class="bar-track" style="flex:1;height:6px"><div style="width:${pct}%;height:100%;background:${color}"></div></div><span style="font-size:11px;width:34px;text-align:right">${pct}%</span></div></td>
        <td style="text-align:center">${cell(r.fab_w, r.fab_n)}</td>
        <td style="text-align:center">${cell(r.erect_w, r.erect_n)}</td>
        <td style="text-align:center">${r.accepted}</td>
        <td style="text-align:center;${r.pending ? "color:#f59e0b;font-weight:700" : ""}">${r.pending}</td>
        <td style="text-align:center">${cell(r.sup_done, r.sup_n)}</td>
        <td style="text-align:center;font-size:11px">${esc(r.last_weld || "—")}</td>
        <td style="text-align:center"><span style="color:${color};font-weight:700;font-size:11px">${esc(_ISO_STATUS_LABEL[r.status] || r.status)}</span>${r.fab_done_erect_open ? ' <span title="Fab done · Erect open" style="color:#7c3aed">●</span>' : ""}</td>
    </tr>`;
}

// 행을 누르면 그 ISO만 Joint Master에서 연다
function isoOpenInJM(iso) {
    const input = document.getElementById("jm-iso");
    if (input) input.value = iso;
    navigate("joint_master");
}

async function exportIsoStatus() {
    if (!_iso.filtered.length) { toast("No data to export", "error"); return; }
    await ensureXlsx();
    const rows = _iso.filtered.map(r => ({
        "ISO No": r.iso, "Rev": r.rev, "System": r.system, "Sub Area": r.sub_area, "Package": r.package, "Joints": r.n, "DI": r.di,
        "Welded Joints": r.welded, "Welded DI": r.welded_di, "Fab Welded": r.fab_w, "Fab Total": r.fab_n, "Erect Welded": r.erect_w, "Erect Total": r.erect_n,
        "Accepted": r.accepted, "Inspection Pending": r.pending, "Support Done": r.sup_done, "Support Total": r.sup_n,
        "Last Weld": r.last_weld, "Status": _ISO_STATUS_LABEL[r.status] || r.status, "Fab done, Erect open": r.fab_done_erect_open ? "Y" : "",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "ISO Status");
    if (await downloadWithPicker(wb, "ISO_Status_Export.xlsx")) toast("✓ ISO status exported");
}

// ── Data Quality ──────────────────────────────────────────────────────
const _DQ_SEV = { error: ["#ef4444", "Error"], warn: ["#f59e0b", "Warning"], info: ["#94a3b8", "Info"] };
let _dq = { checks: [], open: null };

async function loadDataQuality() {
    const host = document.getElementById("dq-cards");
    if (!_dq.checks.length) host.innerHTML = `<div style="padding:18px;color:var(--text-dim)">Loading… (the first load can take about 30 seconds)</div>`;
    try {
        const d = await apiFetch("/api/data-quality", { noCache: true });
        _dq = { checks: d.checks || [], open: _dq.open, meta: d };
        document.getElementById("dq-updated").textContent = _isoUpdatedText(d);
        renderDataQuality();
    } catch (e) {
        document.getElementById("dq-updated").textContent = "";
        document.getElementById("dq-summary").innerHTML = "";
        document.getElementById("dq-detail").innerHTML = "";
        _isoLoadError(e, "dq-cards");
    }
}

function renderDataQuality() {
    const d = _dq.meta, failing = _dq.checks.filter(c => c.count > 0), passing = _dq.checks.filter(c => !c.count);
    const errs = failing.filter(c => c.severity === "error").length, warns = failing.filter(c => c.severity === "warn").length;
    const drawing = d.drawing_available ? "Drawing DB connected" : `Drawing DB checks skipped (${esc(d.drawing_error || "unavailable")})`;
    document.getElementById("dq-summary").innerHTML =
        `<b>${(d.joints || 0).toLocaleString()}</b> joints · <b>${(d.isos || 0).toLocaleString()}</b> ISO · ` +
        `<span style="color:${errs ? "#ef4444" : "#059669"};font-weight:700">${errs} error check${errs === 1 ? "" : "s"} failing</span> · ` +
        `<span style="color:${warns ? "#f59e0b" : "#059669"};font-weight:700">${warns} warning${warns === 1 ? "" : "s"}</span> · ${drawing}`;
    document.getElementById("dq-cards").innerHTML =
        (failing.length ? failing.map(c => {
            const [color, label] = _DQ_SEV[c.severity];
            return `<button onclick="dqShow('${esc(c.key)}')" style="text-align:left;cursor:pointer;background:var(--panel);border:1px solid var(--border);border-left:4px solid ${color};border-radius:8px;padding:10px 12px;${_dq.open === c.key ? "outline:2px solid " + color : ""}">
                <div style="display:flex;justify-content:space-between;gap:8px"><span style="font-weight:700;font-size:13px">${esc(c.title)}</span><span style="font-family:'DM Mono',monospace;font-weight:700;color:${color}">${c.count.toLocaleString()}</span></div>
                <div style="font-size:11px;color:var(--text-dim);margin-top:2px">${esc(label)} · ${esc(c.hint)}</div></button>`;
        }).join("") : `<div style="padding:12px;color:#059669;font-weight:700">✓ No problems found.</div>`) +
        (passing.length ? `<div style="grid-column:1/-1;font-size:11px;color:var(--text-dim);margin-top:4px">✓ Passed (${passing.length}): ${passing.map(c => esc(c.title)).join(" · ")}</div>` : "");
    if (_dq.open) dqShow(_dq.open, true);
}

function dqShow(key, keepScroll) {
    const c = _dq.checks.find(x => x.key === key);
    _dq.open = key;
    if (!c) return;
    if (!keepScroll) renderDataQuality();
    const rows = c.samples.map(s => `<tr data-iso="${esc(s.iso)}" ${s.iso ? 'onclick="isoOpenInJM(this.dataset.iso)" style="cursor:pointer"' : ""}>
        <td style="font-size:11px;word-break:break-all">${esc(s.iso || "—")}</td><td style="text-align:center">${esc(s.joint_no ?? "")}</td><td style="font-size:12px">${esc(s.detail)}</td></tr>`).join("");
    document.getElementById("dq-detail").innerHTML = `<div class="panel-title">${esc(c.title)} <span style="font-size:11px;font-weight:400;opacity:.6">— ${c.count.toLocaleString()} found${c.samples.length < c.count ? `, showing the first ${c.samples.length}` : ""}</span>
        <button class="btn-de btn-de-export" onclick="exportDataQuality('${esc(c.key)}')" style="float:right;padding:3px 10px;font-size:11px">⬇ Export</button></div>
        <div class="table-wrap" style="max-height:340px;overflow:auto"><table class="data-table" style="width:100%;table-layout:fixed"><colgroup><col style="width:42%"><col style="width:10%"><col style="width:48%"></colgroup>
        <thead><tr><th>ISO No</th><th>Joint</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function exportDataQuality(key) {
    const c = _dq.checks.find(x => x.key === key);
    if (!c || !c.samples.length) { toast("No data to export", "error"); return; }
    await ensureXlsx();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(c.samples.map(s => ({ "ISO No": s.iso, "Joint": s.joint_no, "Row ID": s.id, "Detail": s.detail }))), c.key.substring(0, 31));
    if (await downloadWithPicker(wb, `Data_Quality_${c.key}.xlsx`)) toast("✓ Exported");
}

// ── Pace & Forecast (Overview) ────────────────────────────────────────
let _pace = null;
const _PACE_TARGET_KEY = "ipcs.paceTarget";

async function loadPace() {
    const body = document.getElementById("paceBody");
    if (!body) return;
    try {
        const t = localStorage.getItem(_PACE_TARGET_KEY);
        if (t && !document.getElementById("pace-target").value) document.getElementById("pace-target").value = t;
    } catch (e) { /* 저장된 목표일은 편의 기능이라 없어도 된다 */ }
    if (!_pace) body.innerHTML = `<tr><td colspan="10" style="padding:14px;color:var(--text-dim)">Loading…</td></tr>`;
    try {
        _pace = await apiFetch("/api/pace-forecast", { noCache: true });
        renderPace();
    } catch (e) {
        body.innerHTML = `<tr><td colspan="10" style="padding:14px;color:var(--red)">Failed to load: ${esc(e.message)}</td></tr>`;
    }
}

function _paceEta(r, target) {
    if (r.remaining_di === 0) return ["Done", "#059669"];
    if (r.eta_weeks === null) return ["No progress", "#f59e0b"];
    if (r.eta_weeks > 104) return ["> 2 years", "#ef4444"];
    return [r.eta_date, target ? (r.eta_date <= target ? "#059669" : "#ef4444") : "inherit"];
}

function renderPace() {
    if (!_pace) return;
    const dim = document.getElementById("pace-dim").value, target = document.getElementById("pace-target").value;
    try { localStorage.setItem(_PACE_TARGET_KEY, target); } catch (e) { /* 위와 같다 */ }
    const weeksToTarget = target ? Math.max((new Date(target) - new Date(_pace.today)) / 6048e5, 0) : null;
    document.getElementById("pace-req-head").style.display = target ? "" : "none";
    document.getElementById("pace-gap-head").style.display = target ? "" : "none";
    const rowHtml = (r, bold) => {
        const [eta, color] = _paceEta(r, target);
        const req = weeksToTarget === null ? null : (weeksToTarget > 0 ? r.remaining_di / weeksToTarget : null);
        const gap = req === null ? null : r.per_week - req;
        return `<tr style="${bold ? "font-weight:700;background:rgba(37,99,235,0.07)" : ""}">
            <td>${esc(r.name)}</td><td style="text-align:right">${fmtNum(r.total_di, 0)}</td><td style="text-align:right">${r.pct.toFixed(1)}%</td>
            <td style="text-align:right">${fmtNum(r.remaining_di, 0)}</td><td style="text-align:right">${fmtNum(r.recent_di, 0)}</td><td style="text-align:right">${fmtNum(r.per_week, 0)}</td>
            <td style="text-align:right">${r.eta_weeks === null ? "—" : r.eta_weeks > 104 ? "> 104" : fmtNum(r.eta_weeks, 1)}</td><td style="text-align:center;color:${color};font-weight:700">${esc(eta)}</td>
            ${target ? `<td style="text-align:right">${req === null ? "—" : fmtNum(req, 0)}</td><td style="text-align:right;color:${gap === null ? "inherit" : gap >= 0 ? "#059669" : "#ef4444"};font-weight:700">${gap === null ? "—" : (gap >= 0 ? "+" : "") + fmtNum(gap, 0)}</td>` : ""}
        </tr>`;
    };
    const rows = (dim === "sub_area" ? _pace.by_sub_area : _pace.by_system).filter(r => r.total_di > 0);
    document.getElementById("paceBody").innerHTML = rowHtml(_pace.overall, true) + rows.map(r => rowHtml(r, false)).join("");
    document.getElementById("pace-note").textContent = `Pace = D/I welded in the last ${_pace.window_days} days ÷ 4 weeks · ${_isoUpdatedText(_pace)}`;
}
