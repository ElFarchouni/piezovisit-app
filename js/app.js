/* PiezoVisit - field app for piezometer network visits.
   Data comes from data/piezometers.js (generated) and data/visits.js (planned visits).
   Everything the user enters is kept on the device (localStorage) and exported as CSV. */
(function () {
  "use strict";

  const { Store, distance, pathLength, gmapsTo, gmapsRoute, geoUri, fmtDist, fmtDuration, fmtNum,
    fmtCoord, fmtDateTime, localInput, esc, uid, toCsv, saveFile } = window.PV;
  const t = I18N.t;
  const $ = id => document.getElementById(id);
  const icon = name => '<svg><use href="#i-' + name + '"/></svg>';

  const PIEZOS = (window.PIEZO_NETWORK || { piezometers: [] }).piezometers;
  const BY_ID = new Map(PIEZOS.map(p => [p.id, p]));
  const BAKED_ROADS = window.PIEZO_ROUTES || {};
  const ROUTERS = [
    "https://router.project-osrm.org/route/v1/driving/",
    "https://routing.openstreetmap.de/routed-car/route/v1/driving/",
  ];
  const NO_DTW_STATES = ["dry", "locked", "blocked", "notfound", "destroyed"];

  // ---------- state ----------
  const settings = Object.assign({ lang: null, theme: "light", base: "streets", operator: "" }, Store.get("settings", {}));
  const saveSettings = () => Store.set("settings", settings);
  let records = Store.get("records", []);
  let visits = loadVisits();
  let activeVisitId = Store.get("activeVisit", undefined);
  if (activeVisitId === undefined || (activeVisitId && !visits.some(v => v.id === activeVisitId))) {
    activeVisitId = visits.length ? visits[0].id : null;
  }
  let filter = "all";
  let query = "";
  let selectedId = null;
  let me = null;                          // {lat, lon, acc}
  let watchId = null;
  let editingRecord = null;
  let formPiezo = null;

  I18N.lang = settings.lang || ((navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en");

  function loadVisits() {
    const stored = Store.get("visits", []);
    const out = [];
    (window.PIEZO_VISITS || []).forEach(p => {
      const s = stored.find(v => v.id === p.id);
      // keep the changes made on the device unless the office published a newer revision
      if (s && s.rev === p.rev) out.push(s);
      else out.push(Object.assign({ stops: [] }, JSON.parse(JSON.stringify(p)), { planned: true }));
    });
    stored.filter(v => !v.planned).forEach(v => out.push(v));
    return out;
  }
  const saveVisits = () => Store.set("visits", visits);
  const activeVisit = () => visits.find(v => v.id === activeVisitId) || null;
  const visitStops = v => v.stops.map(id => BY_ID.get(id)).filter(Boolean);
  function visitPoints(v) {
    const pts = visitStops(v).map(p => ({ lat: p.lat, lon: p.lon }));
    if (v.start) pts.unshift(v.start);
    if (v.end) pts.push(v.end);
    return pts;
  }

  const recordsOf = id => records.filter(r => r.piezoId === id).sort((a, b) => a.datetime < b.datetime ? 1 : -1);
  const visitRecord = (v, id) => records.filter(r => r.visitId === v.id && r.piezoId === id).sort((a, b) => a.datetime < b.datetime ? 1 : -1)[0];
  function isDone(p) {
    const v = activeVisit();
    if (v && v.stops.includes(p.id)) return !!visitRecord(v, p.id);
    const today = localInput(new Date()).slice(0, 10);
    return records.some(r => r.piezoId === p.id && r.datetime.slice(0, 10) === today);
  }

  /* Best knowledge of the water level and cable before arriving on site:
     own records first, then the last mission, then the yearly mean of the fiche. */
  function lastKnown(p) {
    const out = {};
    const mine = recordsOf(p.id);
    const withDtw = mine.find(r => r.dtw != null);
    const withCable = mine.find(r => r.cableAfter != null);
    const lm = p.diver && p.diver.lastMission;
    if (withDtw) { out.dtw = withDtw.dtw; out.dtwDate = fmtDateTime(withDtw.datetime).slice(0, 10); }
    else if (lm && lm.dtw != null) { out.dtw = lm.dtw; out.dtwDate = lm.date; }
    else if (p.lastLevel) { out.dtw = p.lastLevel.dtw; out.dtwDate = String(p.lastLevel.year); out.yearly = true; }
    if (withCable) out.cable = withCable.cableAfter;
    else if (lm && lm.cable != null) out.cable = lm.cable;
    return out;
  }

  const label = p => /^\d/.test(p.id) ? p.id : p.id.replace(/\s*\(.*\)/, "");
  const title = p => (p.diverName && p.diverName !== p.id && p.diverName !== p.name) ? p.name + " - " + p.diverName : p.name;

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, ms) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3200);
  }

  // =====================================================================
  // MAP
  // =====================================================================
  const map = L.map("map", { zoomControl: false });
  map.attributionControl.setPrefix(false);
  if (matchMedia("(pointer: fine)").matches) L.control.zoom({ position: "topright" }).addTo(map);

  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  /* Backgrounds. The Esri ones work in the 3 ways the app is opened: hosted (https), local
     server, and double-click on index.html. The OpenStreetMap server (more farm tracks) refuses
     requests from a page opened as a file, so it is only offered when the app is served.
     maxNativeZoom = last level that has real tiles around Marrakech; deeper zoom enlarges them. */
  const SERVED = /^https?:$/.test(location.protocol);
  const BASES = {
    streets: L.tileLayer(esri + "World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 16, maxZoom: 19, attribution: "Esri" }),
    sat: L.layerGroup([
      L.tileLayer(esri + "World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 18, maxZoom: 19, attribution: "Esri, Maxar" }),
      L.tileLayer(esri + "Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 16, maxZoom: 19 }),
      L.tileLayer(esri + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 16, maxZoom: 19 }),
    ]),
    topo: L.tileLayer(esri + "World_Topo_Map/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 17, maxZoom: 19, attribution: "Esri" }),
  };
  if (SERVED) {
    BASES.roads = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" });
  }
  let base = null;
  function setBase(name) {
    if (!BASES[name]) name = "streets";
    if (base) map.removeLayer(base);
    base = BASES[name].addTo(map);
    settings.base = name;
    saveSettings();
    renderLayerMenu();
  }
  function renderLayerMenu() {
    $("layerMenu").innerHTML = Object.keys(BASES).map(k =>
      '<button type="button" data-base="' + k + '" class="' + (k === settings.base ? "on" : "") + '">' + esc(t("bg." + k)) + "</button>").join("");
  }

  const routeLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  const markers = new Map();

  function markerIcon(p) {
    const v = activeVisit();
    const idx = v ? v.stops.indexOf(p.id) : -1;
    const done = isDone(p);
    const cls = ["pz", p.diver ? "diver" : "net", idx >= 0 ? "stop" : "", done ? "done" : "", p.id === selectedId ? "sel" : ""].join(" ");
    const inner = done ? icon("check") : (idx >= 0 ? idx + 1 : "");
    return L.divIcon({
      className: "pz-wrap", iconSize: [44, 44], iconAnchor: [22, 22],
      html: '<div class="' + cls + '"><span class="pz-dot">' + inner + '</span><span class="pz-label">' + esc(label(p)) + "</span></div>",
    });
  }
  function passFilter(p, f) {
    const v = activeVisit();
    if (f === "diver") return !!p.diver;
    if (f === "visit") return !!v && v.stops.includes(p.id);
    if (f === "todo") return !!v && v.stops.includes(p.id) && !visitRecord(v, p.id);
    return true;
  }
  function refreshMarkers() {
    const v = activeVisit();
    PIEZOS.forEach(p => {
      let m = markers.get(p.id);
      if (!m) {
        m = L.marker([p.lat, p.lon], { keyboard: false });
        m.on("click", () => select(p.id));
        markers.set(p.id, m);
      }
      m.setIcon(markerIcon(p));
      const stop = v && v.stops.includes(p.id);
      m.setZIndexOffset(p.id === selectedId ? 3000 : stop ? 2000 : p.diver ? 1000 : 0);
      const show = passFilter(p, filter === "todo" ? "visit" : filter) || p.id === selectedId;
      if (show && !markerLayer.hasLayer(m)) markerLayer.addLayer(m);
      if (!show && markerLayer.hasLayer(m)) markerLayer.removeLayer(m);
    });
  }
  function updateLabels() {
    map.getContainer().classList.toggle("labels-on", map.getZoom() >= 12);
  }
  map.on("zoomend", updateLabels);
  map.on("click", () => { $("layerMenu").hidden = true; if (selectedId) closeSheet(); });

  function renderLegend() {
    const v = activeVisit();
    $("legend").innerHTML =
      '<span><i style="background:var(--net)"></i>' + esc(t("lg.network")) + "</span>" +
      '<span><i style="background:var(--diver)"></i>' + esc(t("lg.diver")) + "</span>" +
      '<span><i style="background:#0b7a5c"></i>' + esc(t("lg.done")) + "</span>" +
      (v && v.stops.length ? '<span><i style="background:#1a73e8;border-radius:2px;height:4px;border:0;box-shadow:none"></i>' + esc(v.name) + "</span>" : "");
  }

  // ---------- roads ----------
  const routeKey = pts => pts.map(p => p.lat.toFixed(5) + "," + p.lon.toFixed(5)).join(";");
  function roadFor(v) {
    const key = routeKey(visitPoints(v));
    const baked = BAKED_ROADS[v.id];
    if (baked && baked.key === key) return baked;
    const cached = Store.get("roads", []).find(r => r.key === key);
    return cached || null;
  }
  async function fetchRoad(v) {
    const pts = visitPoints(v);
    if (pts.length < 2) { toast(t("t.needStops")); return; }
    const coords = pts.map(p => p.lon.toFixed(6) + "," + p.lat.toFixed(6)).join(";");
    for (const server of ROUTERS) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        const res = await fetch(server + coords + "?overview=full&geometries=geojson", { signal: ctl.signal });
        clearTimeout(timer);
        const data = await res.json();
        if (data.code !== "Ok" || !data.routes.length) continue;
        const r = data.routes[0];
        const road = {
          key: routeKey(pts), distance: r.distance, duration: r.duration,
          legs: r.legs.map(l => ({ distance: l.distance, duration: l.duration })),
          geometry: r.geometry.coordinates.map(c => [+c[1].toFixed(5), +c[0].toFixed(5)]),
        };
        const cache = Store.get("roads", []).filter(x => x.key !== road.key);
        cache.unshift(road);
        Store.set("roads", cache.slice(0, 6));
        toast(t("t.roadOk"));
        refreshAll();
        return;
      } catch (e) { /* try the next server */ }
    }
    toast(t("t.roadFail"), 4500);
  }

  function drawRoute() {
    routeLayer.clearLayers();
    const v = activeVisit();
    if (!v) return;
    const pts = visitPoints(v);
    const road = roadFor(v);
    if (pts.length >= 2) {
      const line = road ? road.geometry : pts.map(p => [p.lat, p.lon]);
      L.polyline(line, { color: "#ffffff", weight: 8, opacity: .85, interactive: false }).addTo(routeLayer);
      L.polyline(line, { color: "#1a73e8", weight: 4.5, opacity: 1, dashArray: road ? null : "2 10", interactive: false }).addTo(routeLayer);
    }
    [["start", "S"], ["end", "E"]].forEach(([k, letter]) => {
      if (!v[k]) return;
      if (k === "end" && v.start && distance(v.start, v.end) < 50) return;   // loop: one marker is enough
      L.marker([v[k].lat, v[k].lon], {
        interactive: false, zIndexOffset: 1500,
        icon: L.divIcon({ className: "pz-wrap", iconSize: [30, 30], iconAnchor: [15, 15], html: '<div class="endpoint">' + letter + "</div>" }),
      }).addTo(routeLayer);
    });
  }

  function fitTo(points, maxZoom) {
    if (!points.length) return;
    const b = L.latLngBounds(points.map(p => [p.lat, p.lon]));
    const wide = innerWidth >= 900;
    map.fitBounds(b, {
      paddingTopLeft: [40, 70],
      paddingBottomRight: [wide && selectedId ? 440 : 70, 60],
      maxZoom: maxZoom || 15,
    });
  }
  function fitDefault() {
    const v = activeVisit();
    if (v && visitPoints(v).length && (filter === "visit" || filter === "todo")) fitTo(visitPoints(v));
    else fitTo(PIEZOS.filter(p => passFilter(p, filter)));
  }

  // ---------- my position ----------
  function locate() {
    if (!("geolocation" in navigator)) { toast(t("t.gpsFail")); return; }
    if (!window.isSecureContext) { toast(t("t.gpsInsecure"), 5000); return; }
    if (watchId != null) {
      if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 14));
      else toast(t("t.gpsSearching"));
      return;
    }
    $("btnLocate").classList.add("wait");
    toast(t("t.gpsSearching"));
    let first = true;
    watchId = navigator.geolocation.watchPosition(pos => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
      $("btnLocate").classList.remove("wait");
      $("btnLocate").classList.add("on");
      drawMe();
      if (first) { first = false; map.setView([me.lat, me.lon], Math.max(map.getZoom(), 13)); }
      renderList();
      if (selectedId) renderSheet();
    }, err => {
      $("btnLocate").classList.remove("wait");
      if (!me) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      toast(t(err.code === 1 ? "t.gpsDenied" : "t.gpsFail"), 5000);
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  function drawMe() {
    meLayer.clearLayers();
    if (!me) return;
    L.circle([me.lat, me.lon], { radius: me.acc, color: "#1a73e8", weight: 1, fillOpacity: .12, interactive: false }).addTo(meLayer);
    L.marker([me.lat, me.lon], {
      interactive: false, zIndexOffset: 4000,
      icon: L.divIcon({ className: "pz-wrap", iconSize: [20, 20], iconAnchor: [10, 10], html: '<div class="me-dot"></div>' }),
    }).addTo(meLayer);
  }

  // =====================================================================
  // LIST
  // =====================================================================
  function renderList() {
    const q = query.trim().toLowerCase();
    let items = PIEZOS.filter(p => passFilter(p, filter)).filter(p => !q ||
      [p.id, p.id.replace("/", "-"), p.name, p.diverName, p.commune, p.province].some(s => s && s.toLowerCase().includes(q)));
    const v = activeVisit();
    if (me) items = items.map(p => [distance(me, p), p]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    $("listCount").textContent = t("list.count", { n: items.length });
    $("listSort").textContent = t(me ? "list.sortDist" : "list.sortId");
    $("piezoList").innerHTML = items.length ? items.map(p => {
      const idx = v ? v.stops.indexOf(p.id) : -1;
      const done = isDone(p);
      const place = [title(p), p.commune].filter(Boolean).join(" · ");
      return '<button type="button" class="card' + (p.id === selectedId ? " sel" : "") + '" data-id="' + esc(p.id) + '">' +
        '<span class="dot ' + (done ? "done" : p.diver ? "diver" : "") + '"></span>' +
        '<span class="c-id">' + esc(label(p)) +
          (p.diver ? '<span class="badge diver">' + esc(p.diver.type) + "</span>" : "") +
          (idx >= 0 ? '<span class="badge stop">' + (idx + 1) + "</span>" : "") +
          (done ? '<span class="badge done">' + icon("check") + "</span>" : "") +
        "</span>" +
        '<span class="c-dist">' + (me ? fmtDist(distance(me, p)) : (p.z != null ? fmtNum(p.z, 0) + " m" : "")) + "</span>" +
        '<span class="c-name">' + esc(place) + "</span>" +
        "</button>";
    }).join("") : '<div class="empty">' + esc(t("list.empty")) + "</div>";
  }

  // =====================================================================
  // DETAIL SHEET
  // =====================================================================
  function select(id, opts) {
    const p = BY_ID.get(id);
    if (!p) return;
    selectedId = id;
    document.body.classList.add("sheet-open");
    $("sheet").hidden = false;
    renderSheet();
    $("sheet").querySelector(".sheet-body").scrollTop = 0;
    refreshMarkers();
    renderList();
    if (!opts || opts.pan !== false) {
      // keep the point visible above the sheet
      requestAnimationFrame(() => {
        const size = map.getSize();
        if (!size.x) return;
        const wide = innerWidth >= 900;
        const zoom = Math.max(map.getZoom(), opts && opts.zoom ? opts.zoom : 0);
        const target = map.project([p.lat, p.lon], zoom);
        const shift = wide ? [200, 0] : [0, Math.min($("sheet").offsetHeight, size.y * 0.6) / 2];
        map.setView(map.unproject(target.add(shift), zoom), zoom, { animate: true });
      });
    }
  }
  function closeSheet() {
    selectedId = null;
    $("sheet").hidden = true;
    document.body.classList.remove("sheet-open");
    refreshMarkers();
    renderList();
  }

  const kv = (k, v, cls) => (v == null || v === "") ? "" :
    '<div class="kv"><span>' + esc(k) + '</span><span class="' + (cls || "") + '">' + v + "</span></div>";

  function renderSheet() {
    const p = BY_ID.get(selectedId);
    if (!p) return;
    const v = activeVisit();
    const idx = v ? v.stops.indexOf(p.id) : -1;
    const done = isDone(p);
    const known = lastKnown(p);
    const mine = recordsOf(p.id);
    const android = /android/i.test(navigator.userAgent);

    let h = '<header class="sheet-head"><div class="sheet-title">' +
      '<div class="sheet-id">' + esc(label(p)) + "</div>" +
      '<div class="sheet-name">' + esc([title(p), p.commune, p.province].filter(Boolean).join(" · ")) + "</div>" +
      '<div class="sheet-badges">' +
        (p.diver ? '<span class="badge diver">Diver ' + esc(p.diver.type) + "</span>" : "") +
        (p.diver && p.diver.farmerWell ? '<span class="badge">' + esc(t("p.farmer")) + "</span>" : "") +
        (idx >= 0 ? '<span class="badge stop">' + esc(t("lg.stop")) + " " + (idx + 1) + "</span>" : "") +
        (done ? '<span class="badge done">' + icon("check") + esc(t("lg.done")) + "</span>" : "") +
        (me ? '<span class="badge">' + fmtDist(distance(me, p)) + " " + esc(t("p.fromMe")) + "</span>" : "") +
      "</div></div>" +
      '<button type="button" class="icon-btn" data-act="close" aria-label="' + esc(t("act.close")) + '">' + icon("close") + "</button></header>";

    h += '<div class="sheet-actions">' +
      '<a class="btn go" target="_blank" rel="noopener" href="' + gmapsTo(p) + '">' + icon("nav") + esc(t("act.go")) + "</a>" +
      '<button type="button" class="btn primary" data-act="record">' + icon("edit") + esc(t("act.record")) + "</button>" +
      (v ? '<button type="button" class="btn ghost wide" data-act="toggle">' + icon(idx >= 0 ? "minus" : "plus") +
        esc(t(idx >= 0 ? "act.remove" : "act.add")) + "</button>" : "") +
      "</div>";

    h += '<div class="sheet-body">';
    if (p.coordWarning) h += '<div class="warn soft">' + esc(t("warn.coords")) + ": " + esc(p.coordWarning) + "</div>";

    h += '<button type="button" class="coords" data-act="copy"><span>' + fmtCoord(p) +
      "<small>" + esc(t(p.coordSource === "gps" ? "p.gpsSource" : "p.ficheSource")) +
      (p.x ? " · " + esc(t("p.lambert")) + " X " + fmtNum(p.x, 0) + " Y " + fmtNum(p.y, 0) : "") +
      "</small></span>" + icon("copy") + "</button>";

    if (p.diver) {
      const d = p.diver;
      const margin = (known.cable != null && known.dtw != null && !known.yearly) ? known.cable - known.dtw : null;
      h += '<div class="box diver"><div class="caps">' + esc(t("p.diver")) + " " + esc(d.type) + "</div>" +
        kv(t("p.status"), esc(d.status || "")) +
        kv(t("p.interval"), esc(d.interval || "")) +
        kv(t("p.cable"), known.cable != null ? fmtNum(known.cable) + " m" : "") +
        kv(t("p.lastDtw"), known.dtw != null ? fmtNum(known.dtw) + " m <small>(" + esc(known.dtwDate) + ")</small>" : "") +
        kv(t("p.margin"), margin != null ? fmtNum(margin) + " m" : "", margin != null && margin < 1 ? "down" : "") +
        "</div>";
    }

    if (mine.length) {
      h += '<div class="box"><div class="caps">' + esc(t("p.records")) + " (" + mine.length + ")</div>" +
        mine.slice(0, 5).map(r =>
          '<button type="button" class="recline" data-act="edit" data-rec="' + esc(r.id) + '">' +
          "<span>" + esc(fmtDateTime(r.datetime)) + "</span><b>" + (r.dtw != null ? fmtNum(r.dtw) + " m" : esc(t("ws." + r.wellState))) + "</b>" +
          (r.comment ? "<small>" + esc(r.comment) + "</small>" : "") + "</button>").join("") + "</div>";
    }

    if (p.aquifer || p.depth != null || p.lastLevel) {
      const trend = (p.decline || []).map(d =>
        '<span class="' + (d.rate > 0 ? "down" : "up") + '">' + (d.rate > 0 ? "▼ " : "▲ ") + fmtNum(Math.abs(d.rate)) +
        " m/" + (I18N.lang === "fr" ? "an" : "yr") + "</span> <small>" + esc(d.period) + "</small>").join("<br>");
      h += '<div class="box"><div class="caps">' + esc(t("p.fiche")) + "</div>" +
        kv(t("p.z"), p.z != null ? fmtNum(p.z) + " m" : "") +
        kv(t("p.depth"), p.depth != null ? fmtNum(p.depth) + " m" : "") +
        kv(t("p.lastLevel", { y: p.lastLevel ? p.lastLevel.year : "" }), p.lastLevel ? fmtNum(p.lastLevel.dtw) + " m" : "") +
        kv(t("p.trend"), trend) +
        kv(t("p.cond"), p.cond != null ? fmtNum(p.cond, 0) + " µS/cm" : "") +
        kv(t("p.aquifer"), esc([p.aquifer, p.level].filter(Boolean).join(", "))) +
        kv(t("p.year"), p.year || "") +
        kv(t("p.access"), esc(p.access || "")) +
        kv(t("p.control"), esc(p.control || "")) +
        "</div>";
      if (p.log && p.log.length) {
        h += "<details><summary>" + esc(t("p.log")) + '</summary><ul class="log">' +
          p.log.map(l => "<li>" + esc(l) + "</li>").join("") + "</ul></details>";
      }
    } else {
      h += '<div class="box">' + kv(t("p.z"), p.z != null ? fmtNum(p.z) + " m" : "") +
        '<div class="stop-sub" style="padding-top:6px">' + esc(t("p.noFiche")) + "</div></div>";
    }
    if (android) h += '<a class="btn ghost small" href="' + esc(geoUri(p, label(p))) + '">' + icon("map") + esc(t("act.otherApp")) + "</a>";
    h += "</div>";
    $("sheet").innerHTML = h;
  }

  $("sheet").addEventListener("click", e => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const p = BY_ID.get(selectedId);
    const act = el.dataset.act;
    if (act === "close") closeSheet();
    else if (act === "record") openRecord(p);
    else if (act === "edit") openRecord(p, records.find(r => r.id === el.dataset.rec));
    else if (act === "toggle") toggleStop(p);
    else if (act === "copy") {
      const txt = fmtCoord(p);
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
        () => toast(t("t.copied")), () => toast(txt));
    }
  });

  function toggleStop(p) {
    const v = activeVisit();
    if (!v) return;
    const i = v.stops.indexOf(p.id);
    if (i >= 0) v.stops.splice(i, 1); else v.stops.push(p.id);
    saveVisits();
    toast(t(i >= 0 ? "t.removed" : "t.added", { v: v.name }));
    refreshAll();
  }

  // =====================================================================
  // VISIT
  // =====================================================================
  function renderVisitSelect() {
    $("visitSelect").innerHTML = '<option value="">' + esc(t("v.none")) + "</option>" + visits.map(v =>
      '<option value="' + esc(v.id) + '"' + (v.id === activeVisitId ? " selected" : "") + ">" + esc(v.name) + "</option>").join("");
  }

  function renderVisit() {
    renderVisitSelect();
    const v = activeVisit();
    const badge = $("visitBadge");
    let h = "";
    if (!v) {
      badge.hidden = true;
      h = '<div class="empty"><b>' + esc(t("v.emptyTitle")) + "</b>" + esc(t("v.emptyText")) + "</div>";
    } else {
      const stops = visitStops(v);
      const nDone = stops.filter(p => visitRecord(v, p.id)).length;
      const left = stops.length - nDone;
      badge.hidden = !left;
      badge.textContent = left;
      const pts = visitPoints(v);
      const road = roadFor(v);
      const dist = road ? road.distance : pathLength(pts);

      h += '<div class="vcard"><div class="vname"><span>' + esc(v.name) + "</span>" +
        (v.planned ? '<span class="badge">' + esc(t("v.planned")) + "</span>" : "") +
        '<button type="button" class="icon-btn" data-act="rename" aria-label="' + esc(t("act.rename")) + '">' + icon("edit") + "</button></div>" +
        '<div class="vmeta">' + (v.date ? "<span>" + esc(v.date) + "</span>" : "") +
        "<span>" + esc(t("v.distance")) + " <b>" + (pts.length > 1 ? fmtDist(dist) : "-") + "</b> " + esc(t(road ? "v.byRoad" : "v.straight")) + "</span>" +
        (road ? "<span>" + esc(t("v.drive")) + " <b>" + fmtDuration(road.duration) + "</b></span>" : "") + "</div>" +
        '<div class="bar"><i style="width:' + (stops.length ? 100 * nDone / stops.length : 0) + '%"></i></div>' +
        '<div class="stop-sub">' + esc(t("v.progress", { a: nDone, b: stops.length })) + "</div>" +
        '<div class="vactions">' +
          '<button type="button" class="btn primary" data-act="showmap">' + icon("map") + esc(t("act.showMap")) + "</button>" +
          '<button type="button" class="btn ghost" data-act="road"' + (pts.length < 2 ? " disabled" : "") + ">" + icon("route") + esc(t("act.road")) + "</button>" +
          '<button type="button" class="btn ghost" data-act="gmaps"' + (stops.length ? "" : " disabled") + ">" + icon("nav") + "Google Maps</button>" +
          '<button type="button" class="btn ghost" data-act="export">' + icon("download") + esc(t("act.export")) + "</button>" +
        "</div></div>";

      if (v.start) {
        h += '<div class="vstop"><div class="stop-n end">S</div><div class="stop-main"><div class="stop-id">' + esc(t("v.start")) +
          '</div><div class="stop-sub">' + esc(v.start.name || fmtCoord(v.start)) + "</div></div>" +
          '<div class="stop-actions"><span class="grow"></span><button type="button" class="btn ghost small" data-act="clearstart">' + esc(t("act.clearStart")) + "</button></div></div>";
      }
      if (!stops.length) h += '<div class="empty">' + esc(t("v.noStops")) + "</div>";
      let prev = v.start || null;
      let nextMarked = false;
      const legOffset = v.start ? 0 : -1;
      v.stops.forEach((id, i) => {
        const p = BY_ID.get(id);
        if (!p) {
          h += '<div class="vstop"><div class="stop-n">' + (i + 1) + '</div><div class="stop-main"><div class="stop-id">' + esc(id) +
            '</div><div class="stop-sub">' + esc(t("v.unknown")) + '</div></div><div class="stop-actions"><span class="grow"></span>' +
            '<button type="button" class="btn ghost small sq danger" data-act="del" data-i="' + i + '">' + icon("trash") + "</button></div></div>";
          return;
        }
        const rec = visitRecord(v, id);
        const n = visitStops(v).indexOf(p);
        const leg = road && road.legs[n + legOffset] ? road.legs[n + legOffset].distance : (prev ? distance(prev, p) : null);
        const isNext = !rec && !nextMarked;
        if (isNext) nextMarked = true;
        const sub = [title(p), leg != null ? t("v.leg", { d: fmtDist(leg) }) : ""].filter(Boolean).join(" · ");
        h += '<div class="vstop' + (rec ? " done" : isNext ? " next" : "") + '">' +
          '<div class="stop-n">' + (rec ? icon("check") : i + 1) + "</div>" +
          '<button type="button" class="stop-main" data-act="open" data-id="' + esc(id) + '">' +
            '<div class="stop-id">' + esc(label(p)) + (p.diver ? '<span class="badge diver">' + esc(p.diver.type) + "</span>" : "") +
            (rec ? '<span class="badge done">' + (rec.dtw != null ? fmtNum(rec.dtw) + " m" : esc(t("ws." + rec.wellState))) + "</span>" : "") + "</div>" +
            '<div class="stop-sub">' + esc(sub) + (rec ? "<br>" + esc(t("v.done", { t: fmtDateTime(rec.datetime) })) : "") + "</div></button>" +
          '<div class="stop-actions">' +
            '<button type="button" class="btn ghost small sq" data-act="up" data-i="' + i + '"' + (i === 0 ? " disabled" : "") + ">" + icon("up") + "</button>" +
            '<button type="button" class="btn ghost small sq" data-act="down" data-i="' + i + '"' + (i === v.stops.length - 1 ? " disabled" : "") + ">" + icon("down") + "</button>" +
            '<button type="button" class="btn ghost small sq danger" data-act="del" data-i="' + i + '">' + icon("trash") + "</button>" +
            '<a class="btn go small push" target="_blank" rel="noopener" href="' + gmapsTo(p) + '">' + icon("nav") + esc(t("act.go")) + "</a>" +
            '<button type="button" class="btn primary small" data-act="rec" data-id="' + esc(id) + '">' + icon("edit") + esc(t("act.record")) + "</button>" +
          "</div></div>";
        prev = p;
      });
      h += '<div class="row" style="flex-wrap:wrap;margin-top:12px">' +
        (v.start ? "" : '<button type="button" class="btn ghost small" data-act="starthere">' + icon("locate") + esc(t("act.startHere")) + "</button>") +
        '<span class="grow"></span>' +
        '<button type="button" class="btn ghost small danger" data-act="delvisit">' + icon("trash") + esc(t("act.deleteVisit")) + "</button></div>";
    }
    h += '<div class="caps section-title">' + esc(t("p.records")) + " (" + records.length + ")</div>" +
      (SERVED ? "" : '<div class="warn soft">' + esc(t("warn.fileMode")) + "</div>") +
      '<div class="row"><button type="button" class="btn ghost small" data-act="exportall"' + (records.length ? "" : " disabled") + ">" +
      icon("download") + esc(t("act.export")) + '</button><button type="button" class="btn ghost small" data-act="backup">' +
      icon("download") + esc(t("act.backup")) + "</button></div>";
    $("visitBody").innerHTML = h;
  }

  $("visitBody").addEventListener("click", e => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const v = activeVisit();
    const act = el.dataset.act;
    const i = +el.dataset.i;
    if (act === "exportall") return exportCsv(records, "piezovisit_all");
    if (act === "backup") return backup();
    if (!v) return;
    if (act === "open") { setView("map"); select(el.dataset.id, { zoom: 13 }); }
    else if (act === "rec") openRecord(BY_ID.get(el.dataset.id));
    else if (act === "up" || act === "down") {
      const j = act === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= v.stops.length) return;
      [v.stops[i], v.stops[j]] = [v.stops[j], v.stops[i]];
      saveVisits(); refreshAll();
    }
    else if (act === "del") { v.stops.splice(i, 1); saveVisits(); refreshAll(); }
    else if (act === "showmap") { setFilter("visit"); setView("map"); setTimeout(fitDefault, 60); }
    else if (act === "road") fetchRoad(v);
    else if (act === "gmaps") {
      const todo = visitStops(v).filter(p => !visitRecord(v, p.id));
      window.open(gmapsRoute(todo.length ? todo : visitStops(v)), "_blank", "noopener");
    }
    else if (act === "export") exportCsv(records.filter(r => r.visitId === v.id), "piezovisit_" + v.name);
    else if (act === "rename") {
      const name = prompt(t("v.newName"), v.name);
      if (name && name.trim()) { v.name = name.trim(); saveVisits(); refreshAll(); }
    }
    else if (act === "starthere") {
      if (!me) { locate(); return; }
      v.start = { name: fmtCoord(me), lat: +me.lat.toFixed(6), lon: +me.lon.toFixed(6) };
      saveVisits(); refreshAll();
    }
    else if (act === "clearstart") { v.start = null; saveVisits(); refreshAll(); }
    else if (act === "delvisit") {
      if (!confirm(t("v.confirmDelete"))) return;
      if (v.planned) {                   // planned visits come back from data/visits.js: just reset them
        const src = (window.PIEZO_VISITS || []).find(x => x.id === v.id);
        Object.assign(v, JSON.parse(JSON.stringify(src)));
      } else {
        visits = visits.filter(x => x !== v);
        setActiveVisit(visits.length ? visits[0].id : null);
      }
      saveVisits(); refreshAll();
    }
  });

  function setActiveVisit(id) {
    activeVisitId = id || null;
    Store.set("activeVisit", activeVisitId);
    const v = activeVisit();
    if (!v && (filter === "visit" || filter === "todo")) setFilter("all");
    refreshAll();
  }
  $("visitSelect").addEventListener("change", e => {
    setActiveVisit(e.target.value);
    const v = activeVisit();
    if (v && visitPoints(v).length) fitTo(visitPoints(v));
  });
  $("btnNewVisit").addEventListener("click", () => {
    const d = new Date();
    const def = t("v.defaultName", { d: fmtDateTime(localInput(d)).slice(0, 10) });
    const name = prompt(t("v.newName"), def);
    if (!name || !name.trim()) return;
    const v = { id: "v-" + uid(), name: name.trim(), date: localInput(d).slice(0, 10), start: null, end: null, stops: [] };
    visits.push(v);
    saveVisits();
    setActiveVisit(v.id);
  });

  // =====================================================================
  // FIELD RECORD
  // =====================================================================
  const form = $("recordForm");
  const dlg = $("recordDlg");
  const F = name => form.elements[name];
  // numbers are typed in text boxes so that both "63.4" and "63,4" are accepted on every phone
  const val = name => {
    const s = String(F(name).value).trim().replace(",", ".");
    return /^\d{1,3}(\.\d{0,3})?$/.test(s) ? parseFloat(s) : null;
  };
  const badNumber = name => String(F(name).value).trim() !== "" && val(name) == null;

  function openRecord(p, rec) {
    if (!p) return;
    formPiezo = p;
    editingRecord = rec || null;
    const known = lastKnown(p);
    form.reset();
    $("recTitle").textContent = label(p) + "  " + p.name;
    $("recDelete").hidden = !rec;
    F("datetime").value = rec ? rec.datetime : localInput(new Date());
    F("operator").value = rec ? (rec.operator || "") : settings.operator;
    F("wellState").value = rec ? rec.wellState : "ok";
    F("dtw").value = rec && rec.dtw != null ? rec.dtw : "";
    F("hasDiver").checked = rec ? !!rec.hasDiver : !!p.diver;
    F("diverStatus").value = rec && rec.diverStatus ? rec.diverStatus : "recording";
    F("downloaded").checked = rec ? !!rec.downloaded : false;
    F("cableBefore").value = rec ? (rec.cableBefore != null ? rec.cableBefore : "") : (known.cable != null ? known.cable : "");
    F("cableAfter").value = rec ? (rec.cableAfter != null ? rec.cableAfter : "") : (known.cable != null ? known.cable : "");
    F("comment").value = rec ? (rec.comment || "") : "";

    const hints = [];
    if (known.dtw != null) hints.push(known.yearly ? t("rec.hintFiche", { y: known.dtwDate, v: fmtNum(known.dtw) })
      : t("rec.hintLast", { v: fmtNum(known.dtw), d: known.dtwDate }));
    if (known.cable != null) hints.push(t("rec.hintCable", { v: fmtNum(known.cable) }));
    if (p.depth != null) hints.push(t("rec.hintDepth", { v: fmtNum(p.depth) }));
    $("recHint").textContent = hints.join(" ");

    const gps = rec ? rec.gps : me;
    let g = t("rec.gpsNone");
    if (gps) {
      g = t("rec.gpsOk", { c: fmtCoord(gps), a: gps.acc });
      const far = distance(gps, p);
      if (far > 200) g += " " + t("rec.gpsFar", { d: fmtDist(far) });
    }
    $("recGps").textContent = g;
    syncForm();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
  }
  function closeRecord() {
    if (dlg.close) dlg.close(); else dlg.removeAttribute("open");
  }

  function syncForm(showRequired) {
    $("recDiverFields").hidden = !F("hasDiver").checked;
    F("dtw").disabled = NO_DTW_STATES.includes(F("wellState").value);
    if (F("dtw").disabled) F("dtw").value = "";
    const p = formPiezo;
    const dtw = val("dtw");
    const msgs = [];
    let hard = false;
    if (["dtw", "cableBefore", "cableAfter"].some(badNumber)) { msgs.push(t("rec.badNumber")); hard = true; }
    else if (showRequired && dtw == null && !F("dtw").disabled) { msgs.push(t("rec.needDtw")); hard = true; }
    if (dtw != null && p) {
      const known = lastKnown(p);
      const before = editingRecord ? null : known.dtw;
      if (p.depth != null && dtw > p.depth) msgs.push(t("w.deeper", { v: fmtNum(p.depth) }));
      else if (before != null && Math.abs(dtw - before) > (known.yearly ? 25 : 10)) {
        msgs.push(t("w.jump", { d: fmtNum(Math.abs(dtw - before), 1), v: fmtNum(before) }));
      }
      const cable = val("cableAfter");
      if (F("hasDiver").checked && cable != null) {
        if (cable <= dtw) { msgs.push(t("w.cable", { c: fmtNum(cable), w: fmtNum(dtw) })); hard = true; }
        else if (cable - dtw < 1) msgs.push(t("w.margin", { m: fmtNum(cable - dtw) }));
      }
    }
    const w = $("recWarn");
    w.hidden = !msgs.length;
    w.className = "warn" + (hard ? "" : " soft");
    w.textContent = msgs.join(" ");
    return msgs;
  }
  form.addEventListener("input", () => syncForm());
  form.addEventListener("change", () => syncForm());

  form.addEventListener("submit", e => {
    e.preventDefault();
    const p = formPiezo;
    if (!F("datetime").value) { F("datetime").focus(); return; }
    const bad = ["dtw", "cableBefore", "cableAfter"].find(badNumber);
    if (bad || (val("dtw") == null && !F("dtw").disabled)) {
      syncForm(true);
      F(bad || "dtw").focus();
      return;
    }
    const v = activeVisit();
    const hasDiver = F("hasDiver").checked;
    const base = editingRecord || {
      id: uid(), piezoId: p.id, name: p.diverName || p.name,
      visitId: v && v.stops.includes(p.id) ? v.id : null,
      visitName: v && v.stops.includes(p.id) ? v.name : "",
      visitDate: v && v.stops.includes(p.id) ? (v.date || "") : "",
      gps: me ? { lat: +me.lat.toFixed(6), lon: +me.lon.toFixed(6), acc: me.acc } : null,
    };
    const rec = Object.assign(base, {
      datetime: F("datetime").value,
      operator: F("operator").value.trim(),
      wellState: F("wellState").value,
      dtw: val("dtw"),
      hasDiver,
      diverStatus: hasDiver ? F("diverStatus").value : null,
      downloaded: hasDiver ? F("downloaded").checked : null,
      cableBefore: hasDiver ? val("cableBefore") : null,
      cableAfter: hasDiver ? val("cableAfter") : null,
      comment: F("comment").value.trim(),
      savedAt: new Date().toISOString(),
    });
    if (!editingRecord) records.push(rec);
    Store.set("records", records) || toast("Storage full or blocked: export your records now", 6000);
    settings.operator = rec.operator;
    saveSettings();
    closeRecord();
    toast(t("t.saved"));
    refreshAll();
  });
  $("recDelete").addEventListener("click", () => {
    if (!editingRecord || !confirm(t("rec.confirmDelete"))) return;
    records = records.filter(r => r.id !== editingRecord.id);
    Store.set("records", records);
    closeRecord();
    toast(t("t.deleted"));
    refreshAll();
  });
  $("recClose").addEventListener("click", closeRecord);
  $("recCancel").addEventListener("click", closeRecord);

  // ---------- export ----------
  /* First 10 columns = PiezoTool "manual measurements" format, so the file can be dropped in
     PiezoTool/input/manual_measurements/. Rows without a depth are ignored by PiezoTool. */
  function exportCsv(list, name) {
    if (!list.length) { toast(t("t.noRecords")); return; }
    const rows = [["station_id", "station_name", "mission", "mission_date", "datetime", "measured_DTW_m", "role",
      "cable_before_m", "cable_after_m", "notes", "well_state", "diver_status", "data_downloaded", "operator",
      "gps_lat", "gps_lon", "gps_accuracy_m"]];
    list.slice().sort((a, b) => a.datetime < b.datetime ? -1 : 1).forEach(r => rows.push([
      r.piezoId, r.name, r.visitName, r.visitDate, fmtDateTime(r.datetime), r.dtw, "check",
      r.cableBefore, r.cableAfter, r.comment, r.wellState, r.diverStatus,
      r.downloaded == null ? "" : (r.downloaded ? "yes" : "no"), r.operator,
      r.gps ? r.gps.lat : "", r.gps ? r.gps.lon : "", r.gps ? r.gps.acc : "",
    ]));
    const stamp = localInput(new Date()).slice(0, 10);
    saveFile(name.replace(/[^\w-]+/g, "_").slice(0, 50) + "_" + stamp + ".csv", toCsv(rows), "text/csv");
    toast(t("t.exported", { n: list.length }));
  }
  function backup() {
    const data = { app: "PiezoVisit", saved: new Date().toISOString(), records, visits };
    saveFile("piezovisit_backup_" + localInput(new Date()).slice(0, 10) + ".json", JSON.stringify(data, null, 1), "application/json");
  }

  // =====================================================================
  // SHELL
  // =====================================================================
  function setView(view) {
    document.body.dataset.view = view;
    document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("on", b.dataset.view === view));
    $("layerMenu").hidden = true;
    if (view !== "map" && innerWidth < 900 && selectedId) closeSheet();
    requestAnimationFrame(() => map.invalidateSize());
  }
  function setFilter(f) {
    if ((f === "visit" || f === "todo") && !activeVisit()) f = "all";
    filter = f;
    document.querySelectorAll("#listFilters .chip").forEach(c => c.classList.toggle("on", c.dataset.filter === f));
    document.querySelectorAll("#mapFilters .chip").forEach(c => c.classList.toggle("on", c.dataset.filter === (f === "todo" ? "visit" : f)));
    refreshMarkers();
    renderList();
  }
  function refreshAll() {
    refreshMarkers();
    drawRoute();
    renderLegend();
    renderList();
    renderVisit();
    if (selectedId) renderSheet();
  }
  function applyLanguage() {
    I18N.apply();
    $("btnLang").textContent = I18N.lang === "fr" ? "EN" : "FR";
    $("netCount").textContent = t("net.count", { n: PIEZOS.length, d: PIEZOS.filter(p => p.diver).length });
    renderLayerMenu();
    updateOnline();
    refreshAll();
  }
  function updateOnline() {
    const on = navigator.onLine !== false;
    $("netState").classList.toggle("off", !on);
    $("netStateTxt").textContent = t(on ? "net.online" : "net.offline");
  }

  $("nav").addEventListener("click", e => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });
  ["listFilters", "mapFilters"].forEach(id => $(id).addEventListener("click", e => {
    const c = e.target.closest(".chip");
    if (!c) return;
    setFilter(c.dataset.filter);
    if (id === "mapFilters") fitDefault();
  }));
  $("listSearch").addEventListener("input", e => { query = e.target.value; renderList(); });
  $("piezoList").addEventListener("click", e => {
    const c = e.target.closest(".card");
    if (!c) return;
    if (innerWidth < 900) setView("map");
    select(c.dataset.id, { zoom: 13 });
  });
  $("btnLocate").addEventListener("click", locate);
  $("btnFit").addEventListener("click", fitDefault);
  $("btnLayers").addEventListener("click", e => { e.stopPropagation(); $("layerMenu").hidden = !$("layerMenu").hidden; });
  $("layerMenu").addEventListener("click", e => {
    const b = e.target.closest("button[data-base]");
    if (b) { setBase(b.dataset.base); $("layerMenu").hidden = true; }
  });
  $("btnLang").addEventListener("click", () => {
    I18N.lang = I18N.lang === "fr" ? "en" : "fr";
    settings.lang = I18N.lang;
    saveSettings();
    applyLanguage();
  });
  $("btnTheme").addEventListener("click", () => {
    settings.theme = settings.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = settings.theme;
    saveSettings();
  });
  addEventListener("online", updateOnline);
  addEventListener("offline", updateOnline);
  addEventListener("resize", () => map.invalidateSize());

  // ---------- start ----------
  document.documentElement.dataset.theme = settings.theme;
  setBase(settings.base);
  applyLanguage();
  const v0 = activeVisit();
  map.invalidateSize();
  if (v0 && visitPoints(v0).length > 1) fitTo(visitPoints(v0)); else fitTo(PIEZOS);
  updateLabels();

  // links: index.html#list, #visit, or #p=4102/53 to open one piezometer
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash === "list" || hash === "visit") setView(hash);
  else if (hash.startsWith("p=") && BY_ID.has(hash.slice(2))) select(hash.slice(2), { zoom: 13 });

  // offline use: only possible when the app is served over http(s), not from a file
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").then(reg => {
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w && w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) toast(t("t.updated"), 6000);
        });
      });
    }).catch(() => { /* the app still works online */ });
  }

  window.PiezoVisit = { map, select, setView, setFilter, get records() { return records; }, get visits() { return visits; } };
})();
