// ISO Status · Data Quality 화면 (ISO Drawing 단위 현황, 데이터 점검)
// dashboard.js 다음에 로드된다. apiFetch · esc · fmtNum · toast · navigate · printPage · downloadWithPicker · ensureXlsx를 쓴다.

const _ISO_STATUS_LABEL = { NOT_STARTED: "Not started", WELDING: "Welding", WELDED: "Welded · inspection pending", ACCEPTED: "Accepted" };
// 표의 상태 열에 쓰는 이름(위쪽 칩·필터는 _ISO_STATUS_LABEL 그대로). 한 줄에 들어가야 행 높이가 일정하다
const _ISO_STATUS_TABLE = { NOT_STARTED: "Not started", WELDING: "Welding", WELDED: "Inspection Pending", ACCEPTED: "Accepted" };
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
const _iso = { rows: [], page: 0, all: false, size: 10, fitting: false, sort: { key: "iso", dir: 1 }, filtered: [], meta: null };

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
        _isoFillPackages();
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

// Test Package 필터: 한 ISO가 여러 Package에 걸칠 수 있어 ISO별 전체 목록(r.packages)에서 고른다. "No Package"는 Package가 없는 ISO
const _ISO_NO_PACKAGE = "__none__";
function _isoFillPackages() {
    const sel = document.getElementById("iso-package");
    if (!sel) return;
    const cur = sel.value;
    const vals = [...new Set(_iso.rows.flatMap(r => r.packages || []))].sort();
    sel.innerHTML = `<option value="">Test Package</option><option value="${_ISO_NO_PACKAGE}"${cur === _ISO_NO_PACKAGE ? " selected" : ""}>No Package</option>` +
        vals.map(v => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`).join("");
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

function isoGoto(page) {
    _iso.page = Math.max(0, page);
    isoRender(false);
}

// 인쇄할 때만 필터된 전체 행을 펼친다(화면은 페이지 단위)
async function isoPrint() {
    _iso.all = true;
    isoRender(false);
    try { await printPage("iso_status"); } finally { _iso.all = false; isoRender(false); }
}

// 필터·정렬을 바꿀 때(resetPage=true)는 1페이지로 돌아가 화면 높이에 행 수를 다시 맞추고, 페이지만 넘길 때는 다시 그리기만 한다
function isoRender(resetPage) {
    if (resetPage) _iso.page = 0;
    const q = (document.getElementById("iso-search")?.value || "").trim().toLowerCase();
    const sys = document.getElementById("iso-system")?.value || "";
    const sub = document.getElementById("iso-subarea")?.value || "";
    const pkg = document.getElementById("iso-package")?.value || "";
    const quick = _ISO_QUICK[document.getElementById("iso-quick")?.value || ""] || _ISO_QUICK[""];
    const { key, dir } = _iso.sort;
    _iso.filtered = _iso.rows.filter(r => quick(r) && (!sys || r.system === sys) && (!sub || r.sub_area === sub) &&
        (!pkg || (pkg === _ISO_NO_PACKAGE ? !(r.packages || []).length : (r.packages || []).includes(pkg))) &&
        (!q || r.iso.toLowerCase().includes(q) || (r.package || "").toLowerCase().includes(q)))
        .sort((a, b) => {
            const av = key === "pct" ? (a.di ? a.welded_di / a.di : 0) : a[key], bv = key === "pct" ? (b.di ? b.welded_di / b.di : 0) : b[key];
            return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""))) * dir || a.iso.localeCompare(b.iso);
        });
    _isoDraw();
    if (resetPage || _iso.size <= 10) isoFit();
}

function _isoDraw() {
    const { key, dir } = _iso.sort;
    const total = _iso.filtered.length, pages = Math.max(1, Math.ceil(total / _iso.size));
    _iso.page = Math.min(_iso.page, pages - 1);
    const start = _iso.all ? 0 : _iso.page * _iso.size, end = _iso.all ? total : start + _iso.size;
    document.getElementById("iso-count").textContent = `Total ${total.toLocaleString()} ISO`;
    _renderPageNums("iso-page-nav", _iso.page, _iso.all ? 0 : total, _iso.size, "isoGoto");
    document.getElementById("iso-body-msg").innerHTML = total ? "" : `<div style="padding:18px;color:var(--text-dim)">No ISO matches the filters.</div>`;
    document.getElementById("iso-body").innerHTML = _iso.filtered.slice(start, end).map(_isoRowHtml).join("");
    document.querySelectorAll("#isoTable th[data-sort]").forEach(th => {
        th.dataset.arrow = th.dataset.sort === key ? (dir > 0 ? " ▲" : " ▼") : "";
        th.textContent = th.dataset.label + th.dataset.arrow;
    });
}

// 요소 아래쪽으로 바깥 박스들이 더하는 여백(자신의 margin-bottom + 조상들의 padding-bottom·border-bottom·margin-bottom)
function _isoBelow(el) {
    let gap = 0;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        gap += parseFloat(cs.marginBottom) || 0;
        if (n !== el) gap += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    }
    return gap;
}

// 네비게이터가 스크롤 없이 화면 안에 보이도록 한 페이지 행 수를 정한다.
// 실제로 그려진 표를 재서 맞춘다: 아래 여유(또는 넘친 만큼)를 행 높이로 나눠 행 수를 늘리거나 줄이고, 2~3번 안에 수렴한다.
function isoFit() {
    const page = document.getElementById("page-iso_status");
    if (_iso.fitting || _iso.all || !page || page.classList.contains("hidden") || !_iso.filtered.length) return;
    _iso.fitting = true;
    try {
        const scroller = document.querySelector(".page-body");
        if (scroller) scroller.scrollTop = 0;
        window.scrollTo(0, 0);
        const pager = page.querySelector(".de-pagination");
        const table = document.getElementById("isoTable");
        table.style.setProperty("--iso-pad", "0px");                     // 행 높이를 기본값으로 재기 위해 먼저 걷어 둔다
        const limit = () => window.innerHeight - _isoBelow(pager);        // 네비게이터 아래에 실제로 깔리는 여백만 남긴다(문서 스크롤이 생기지 않게)
        for (let i = 0; i < 4; i++) {
            const body = document.getElementById("iso-body"), shown = body.rows.length;
            if (!shown) break;
            const rowH = body.getBoundingClientRect().height / shown;
            const free = limit() - pager.getBoundingClientRect().bottom;
            if (free < 0) {                                              // 넘침: 넘친 만큼 행을 줄인다
                _iso.size = Math.max(5, _iso.size + Math.floor(free / rowH));
                _isoDraw();
                continue;
            }
            const grow = Math.floor(free / rowH);
            if (grow <= 0 || shown < _iso.size) break;                   // 여유가 한 행도 안 되거나, 보여 줄 행이 더 없다
            const prev = _iso.size;
            _iso.size = Math.min(200, prev + grow);
            _isoDraw();
            while (_iso.size > prev && pager.getBoundingClientRect().bottom > limit()) {   // 행 높이가 조금씩 달라 넘치면 들어갈 때까지 한 행씩 줄인다
                _iso.size--;
                _isoDraw();
            }
            break;
        }
        // 한 행 미만으로 남은 높이는 행의 위아래 여백으로 나눠 표가 아래까지 채워지게 한다(페이지가 꽉 찼을 때만)
        const rows = document.getElementById("iso-body").rows.length;
        if (rows && rows >= _iso.size) {
            let pad = Math.min(6, Math.floor((limit() - pager.getBoundingClientRect().bottom) / rows / 2));
            for (; pad > 0; pad--) {
                table.style.setProperty("--iso-pad", pad + "px");
                if (pager.getBoundingClientRect().bottom <= limit()) break;
            }
            if (pad <= 0) table.style.setProperty("--iso-pad", "0px");
        }
    } finally { _iso.fitting = false; }
}

// 창 크기가 바뀌면 다시 맞춘다
let _isoResizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(_isoResizeTimer);
    _isoResizeTimer = setTimeout(isoFit, 150);
});

function _isoRowHtml(r) {
    const pct = r.di ? Math.round(r.welded_di / r.di * 100) : 0;
    const color = _ISO_STATUS_COLOR[r.status] || "#94a3b8";
    const cell = (done, n) => n ? `${done}/${n}` : "—";
    return `<tr data-iso="${esc(r.iso)}" onclick="isoOpenInJM(this.dataset.iso)" style="cursor:pointer" title="Open in Joint Master">
        <td style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.iso)}">${esc(r.iso)}</td>
        <td style="text-align:center">${esc(r.rev)}</td>
        <td style="text-align:center">${esc(r.system)}</td>
        <td style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.sub_area)}">${esc(r.sub_area)}</td>
        <td style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.package)}">${esc(r.package || "—")}</td>
        <td style="text-align:center">${r.n}</td>
        <td style="text-align:right">${fmtNum(r.di, 1)}</td>
        <td><div style="display:flex;align-items:center;gap:6px"><div class="bar-track" style="flex:1;height:6px"><div style="width:${pct}%;height:100%;background:${color}"></div></div><span style="font-size:11px;width:34px;text-align:right">${pct}%</span></div></td>
        <td style="text-align:center">${cell(r.fab_w, r.fab_n)}</td>
        <td style="text-align:center">${cell(r.erect_w, r.erect_n)}</td>
        <td style="text-align:center">${r.accepted}</td>
        <td style="text-align:center;${r.pending ? "color:#f59e0b;font-weight:700" : ""}">${r.pending}</td>
        <td style="text-align:center">${cell(r.sup_done, r.sup_n)}</td>
        <td style="text-align:center;font-size:11px">${esc(r.last_weld || "—")}</td>
        <td style="text-align:center;white-space:nowrap" title="${esc(_ISO_STATUS_TABLE[r.status] || r.status)}"><span style="color:${color};font-weight:700;font-size:11px">${esc(_ISO_STATUS_TABLE[r.status] || r.status)}</span>${r.fab_done_erect_open ? ' <span title="Fab done · Erect open" style="color:#7c3aed">●</span>' : ""}</td>
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
        "Last Weld": r.last_weld, "Status": _ISO_STATUS_TABLE[r.status] || r.status, "Fab done, Erect open": r.fab_done_erect_open ? "Y" : "",
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
