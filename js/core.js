/* PiezoVisit - small helpers: storage, geography, formatting, files. No UI here. */
(function () {
  "use strict";

  // ---------- storage (everything stays on the device, in the browser) ----------
  const PREFIX = "piezovisit.";
  const memory = {};                      // fallback when the browser blocks localStorage
  const Store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw == null ? (key in memory ? memory[key] : fallback) : JSON.parse(raw);
      } catch (e) { return key in memory ? memory[key] : fallback; }
    },
    set(key, value) {
      memory[key] = value;
      try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
      catch (e) { return false; }
    },
  };

  // ---------- geography ----------
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  function distance(a, b) {               // metres between two {lat, lon}
    const p1 = rad(a.lat), p2 = rad(b.lat);
    const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function pathLength(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += distance(points[i - 1], points[i]);
    return d;
  }
  function gmapsTo(p) {
    return "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + p.lat + "," + p.lon;
  }
  function gmapsRoute(points) {           // Google Maps accepts up to 9 intermediate points
    const pts = points.slice(0, 10);
    const dest = pts[pts.length - 1];
    let url = "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + dest.lat + "," + dest.lon;
    if (pts.length > 1) url += "&waypoints=" + encodeURIComponent(pts.slice(0, -1).map(p => p.lat + "," + p.lon).join("|"));
    return url;
  }
  function geoUri(p, label) {
    return "geo:" + p.lat + "," + p.lon + "?q=" + p.lat + "," + p.lon + "(" + encodeURIComponent(label) + ")";
  }

  // ---------- formatting ----------
  function fmtDist(m) {
    if (m == null || isNaN(m)) return "";
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    return (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)) + " km";
  }
  function fmtDuration(s) {
    const min = Math.round(s / 60);
    return min < 60 ? min + " min" : Math.floor(min / 60) + " h " + String(min % 60).padStart(2, "0");
  }
  function fmtNum(v, d) {
    if (v == null || isNaN(v)) return "";
    const s = Number(v).toFixed(d == null ? 2 : d);
    return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  }
  const fmtCoord = p => p.lat.toFixed(6) + ", " + p.lon.toFixed(6);
  const pad = n => String(n).padStart(2, "0");
  function localInput(d) {                // value for <input type="datetime-local">
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtDateTime(s) {               // "2026-10-02T09:15" -> "02/10/2026 09:15"
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(s || "");
    return m ? m[3] + "/" + m[2] + "/" + m[1] + " " + m[4] + ":" + m[5] : (s || "");
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- files ----------
  function toCsv(rows, sep) {
    sep = sep || ";";
    const cell = v => {
      const s = v == null ? "" : String(v);
      return /[";\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "﻿" + rows.map(r => r.map(cell).join(sep)).join("\r\n") + "\r\n";
  }
  async function saveFile(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    // on phones, the share sheet lets the user send the file by mail, WhatsApp, Drive...
    try {
      const file = new File([blob], name, { type: blob.type });
      const touch = matchMedia("(pointer: coarse)").matches;
      if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  window.PV = {
    Store, distance, pathLength, gmapsTo, gmapsRoute, geoUri,
    fmtDist, fmtDuration, fmtNum, fmtCoord, fmtDateTime, localInput, esc, uid, toCsv, saveFile,
  };
})();
