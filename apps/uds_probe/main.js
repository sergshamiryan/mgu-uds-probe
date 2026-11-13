'use strict';
/**
 * UDS Probe - reads engine/gearbox basics over READ-ONLY diagnostics only.
 *
 * Declares no car-data SOME/IP, so it bypasses the generateSomeIpInterfaces
 * "nothing found" install failure. Everything is read through
 * kit/readonly-diag.js (ReadOnlyDiag), whose check() permits only 0x22
 * (ReadDataByIdentifier), 0x01/0x09 (OBD read) and the 22 F1 50 discovery
 * broadcast - every write/actuator/routine/session service throws before the
 * bus. Safe while driving.
 *
 *   rpm / speed / coolant / throttle / load : standard OBD-II (service 01) to the DME (0x12)
 *   gear (best-effort)                       : candidate UDS DIDs to EGS (0x18) / DME (0x12), raw
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { hex } = require('./kit/diag');

const W = 1600, H = 500;
const OK = '#2fd27a', DIM = '#9fb0c0', WARN = '#ffb01a';
const DME = 0x12, EGS = 0x18;
const PAGES = ['Readings', 'Raw / discovery', 'Report'];

// standard OBD-II PIDs (service 01) and how to turn the reply into a value
const OBD = [
    { id: 'rpm', pid: 0x0C, label: 'Engine RPM', unit: 'rpm', fn: (u) => ((u[2] << 8) + u[3]) / 4 },
    { id: 'speed', pid: 0x0D, label: 'Vehicle speed', unit: 'km/h', fn: (u) => u[2] },
    { id: 'coolant', pid: 0x05, label: 'Coolant temp', unit: 'C', fn: (u) => u[2] - 40 },
    { id: 'load', pid: 0x04, label: 'Engine load', unit: '%', fn: (u) => Math.round(u[2] * 100 / 255) },
    { id: 'throttle', pid: 0x11, label: 'Throttle', unit: '%', fn: (u) => Math.round(u[2] * 100 / 255) },
    { id: 'iat', pid: 0x0F, label: 'Intake air temp', unit: 'C', fn: (u) => u[2] - 40 },
];
// gear over UDS is model-specific; try a few candidate DIDs on EGS then DME and report raw bytes
const GEAR_DIDS = [
    { ecu: EGS, did: 0xD005 }, { ecu: EGS, did: 0x2000 }, { ecu: EGS, did: 0xDE00 }, { ecu: EGS, did: 0x4A36 },
    { ecu: DME, did: 0xD005 }, { ecu: DME, did: 0x4A36 },
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let status = 'Press "Read now" (read-only).', page = 0, result = null, saved = [], running = false;

        async function obd(link, pid) {
            const u = await link.physical(DME, 0x01, [pid], 1800, (x) => (x[0] === 0x41 && x[1] === pid) || (x[0] === 0x7F && x[1] === 0x01));
            if (!u || u[0] !== 0x41) return { ok: false, why: !u ? 'no reply' : 'NRC ' + hex(u[2] || 0) };
            return { ok: true, raw: u.slice(2).map((b) => hex(b)).join(' ') };
        }

        async function readAll() {
            if (running) return; running = true; status = 'Reading...'; render();
            const rep = { at: new Date().toISOString(), link: null, discovered: [], obd: {}, gear: [], stats: null };
            let link;
            try { link = await new ReadOnlyDiag(ctx.signals, log).init(); } catch (e) { rep.link = 'init failed: ' + e; }
            if (link && link.ready) {
                rep.link = 'ready (available=' + link.available + ')';
                try { const d = await link.discover(); rep.discovered = Array.from(d.keys()).map((a) => '0x' + hex(a)); } catch (e) { rep.discoverErr = String(e); }
                for (const o of OBD) {
                    try { const r = await obd(link, o.pid); rep.obd[o.id] = r.ok ? { value: Math.round(o.fn(parseBytes(r.raw)) * 10) / 10, unit: o.unit, raw: r.raw } : { why: r.why }; }
                    catch (e) { rep.obd[o.id] = { why: String(e.message || e) }; }
                }
                for (const g of GEAR_DIDS) {
                    try {
                        const u = await link.read(g.ecu, g.did, 1800);
                        if (u && u[0] === 0x62) rep.gear.push({ ecu: '0x' + hex(g.ecu), did: hex(g.did, 4), bytes: u.slice(3).map((b) => hex(b)).join(' ') });
                        else if (u && u[0] === 0x7F) rep.gear.push({ ecu: '0x' + hex(g.ecu), did: hex(g.did, 4), nrc: hex(u[2]) });
                    } catch (e) { /* skip */ }
                }
                rep.stats = link.stats;
                try { link.cancel(); } catch (e) {}
            } else if (!rep.link) { rep.link = (link && link.error) || 'no diagnostic link'; }

            result = rep;
            saved = saveReport(rep);
            const got = Object.keys(rep.obd).filter((k) => rep.obd[k].value !== undefined);
            status = link && link.ready ? (got.length + '/' + OBD.length + ' OBD values read' + (saved.length ? ', saved.' : '.')) : ('No diagnostic link: ' + rep.link);
            running = false; page = 0; render();
        }

        function parseBytes(s) { return [0, 0].concat(s.split(' ').map((h) => parseInt(h, 16))); }  // align index 2 = first data byte

        function saveReport(rep) {
            const txt = formatText(rep), json = JSON.stringify(rep, null, 2), where = [];
            const write = (dir) => { try { fs.writeFileSync(path.join(dir, 'uds_probe_report.json'), json); fs.writeFileSync(path.join(dir, 'uds_probe_report.txt'), txt); return true; } catch (e) { log.warn('save ' + dir + ': ' + e); return false; } };
            if (write(ctx.dataDir)) where.push(ctx.dataDir);
            if (settings.get('usb') !== false) { const u = findUsb(); if (u && write(u)) where.push(u + '  (USB)'); }
            return where;
        }
        function findUsb() {
            const roots = ['/mnt/usb', '/media', '/run/media', '/mnt', '/var/opt/usb', '/media/usb', '/mnt/usb0', '/mnt/usb1'];
            const cands = [];
            roots.forEach((r) => { try { if (fs.statSync(r).isDirectory()) { cands.push(r); fs.readdirSync(r).forEach((s) => { const p = r + '/' + s; try { if (fs.statSync(p).isDirectory()) cands.push(p); } catch (e) {} }); } } catch (e) {} });
            try { fs.readFileSync('/proc/mounts', 'utf8').split('\n').forEach((l) => { const a = l.split(' '); if (a[0] && /\/dev\/sd|usb|mmcblk/i.test(a[0]) && a[1] && a[1].length > 1) cands.push(a[1].replace(/\\040/g, ' ')); }); } catch (e) {}
            for (const c of cands) { try { const t = c + '/.udsprobe_wtest'; fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return c; } catch (e) {} }
            return null;
        }

        /* ---------- drawing ---------- */
        function header(cv, t) {
            cv.text('UDS PROBE', 40, 48, 32, t.text, { font: 'bold', spacing: 2 });
            cv.text('read-only', 290, 48, 24, OK);
            cv.text(PAGES[page] + '  (' + (page + 1) + '/' + PAGES.length + ')', W - 40, 48, 24, t.dim, { align: 'right' });
            cv.fillRect(40, 70, W - 80, 2, t.dim);
        }
        function drawReadings(cv, t) {
            cv.text(status, 40, 116, 24, running ? WARN : (result ? OK : t.text));
            if (!result) { cv.text('Reads rpm, speed, coolant, load, throttle via OBD to the DME, and tries gear via UDS.', 40, 170, 22, t.dim); return; }
            let y = 166;
            OBD.forEach((o) => {
                const r = result.obd[o.id] || {};
                cv.text(o.label, 40, y, 24, t.dim);
                if (r.value !== undefined) { cv.text(r.value + ' ' + o.unit, 420, y, 24, OK); cv.text(r.raw, 640, y, 20, t.dim); }
                else cv.text(r.why || '-', 420, y, 22, DIM);
                y += 40;
            });
        }
        function drawRaw(cv, t) {
            if (!result) { cv.text('Read first.', 40, 130, 24, t.dim); return; }
            cv.text('Diagnostic link: ' + result.link, 40, 110, 22, t.text);
            cv.text('Control units answering: ' + (result.discovered.join(' ') || '(none)'), 40, 145, 22, t.dim);
            cv.text('Gear DID candidates (model-specific, raw):', 40, 190, 22, t.dim);
            let y = 224;
            if (!result.gear.length) cv.text('no candidate gear DID answered - gear over UDS may not be exposed; rpm/speed above are the reliable reads.', 60, y, 20, DIM);
            result.gear.slice(0, 7).forEach((g) => { cv.text(g.ecu + ' DID ' + g.did + ': ' + (g.bytes || ('NRC ' + g.nrc)), 60, y, 20, g.bytes ? t.text : DIM); y += 28; });
        }
        function drawReport(cv, t) {
            cv.text('Report file', 40, 120, 26, t.text);
            (saved.length ? saved : ['(read first)']).forEach((s, i) => cv.text(s, 60, 168 + i * 34, 22, OK));
            let y = 168 + (saved.length || 1) * 34 + 24;
            cv.text('Files: uds_probe_report.json / .txt', 40, y, 22, t.dim); y += 34;
            cv.text('USB: pull the stick and send me the files. SSH: find /var/opt -name uds_probe_report.json', 60, y, 22, t.text);
        }

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            header(cv, t);
            try { [drawReadings, drawRaw, drawReport][page](cv, t); } catch (e) { cv.text('render: ' + e, 40, 200, 22, WARN); }
            return ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_READ', () => readAll());
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ui.onClick('BTN_SAVE', () => { if (result) { saved = saveReport(result); status = 'Report saved.'; } return render(); });

        if (settings.get('autorun') !== false) readAll(); else render().catch((e) => log.warn('first render: ' + e));
        log.info('uds_probe started');
    },
});

function formatText(rep) {
    const L = [];
    L.push('BMW G20 - UDS Probe (read-only) report');
    L.push('at ' + rep.at);
    L.push('diagnostic link: ' + rep.link);
    L.push('control units answering discovery: ' + (rep.discovered || []).join(' '));
    L.push('');
    L.push('== OBD-II (service 01) to DME 0x12 ==');
    Object.keys(rep.obd).forEach((k) => { const r = rep.obd[k]; L.push('  ' + k + ': ' + (r.value !== undefined ? r.value + ' (' + r.raw + ')' : (r.why || '-'))); });
    L.push('');
    L.push('== gear DID candidates (UDS 0x22, raw) ==');
    (rep.gear || []).forEach((g) => L.push('  ' + g.ecu + ' DID ' + g.did + ': ' + (g.bytes || ('NRC ' + g.nrc))));
    if (rep.stats) { L.push(''); L.push('stats: ' + JSON.stringify(rep.stats)); }
    return L.join('\n');
}
