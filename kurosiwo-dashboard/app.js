const map = L.map("map").setView([20, 0], 2);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 15,
  attribution: "© OpenStreetMap contributors"
}).addTo(map);

document.getElementById("no-interp-checkbox").addEventListener("change", e => {
  document.getElementById("map").classList.toggle("no-interp", e.target.checked);
});

function continentColor(continent) {
  const colors = {
    Europe: "#1f77b4",
    Asia: "#ff7f0e",
    Africa: "#2ca02c",
    "North America": "#d62728",
    "South America": "#9467bd",
    Oceania: "#8c564b"
  };
  return colors[continent] || "#555";
}

// Populated once layers.json has loaded.
let LAYERS_META = {};
let EVENT_LAYERS = {};
let THRESHOLDS = [];
let currentThreshold = null;

// One Leaflet imageOverlay per layer key, reused across event selections.
const activeOverlays = {};
// Per-layer UI state, keyed by layer id (e.g. "viirs").
const layerState = {};

let currentEvent = null;
// flood_case -> DOM node in the event list, for active-row highlighting.
const eventListRows = {};

function clearOverlays() {
  Object.values(activeOverlays).forEach(layer => map.removeLayer(layer));
  for (const key in activeOverlays) delete activeOverlays[key];
}

function renderThresholdControls() {
  const container = document.getElementById("threshold-rows");
  container.innerHTML = "";

  THRESHOLDS.forEach(t => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "threshold-btn" + (t.key === currentThreshold ? " active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      currentThreshold = t.key;
      renderThresholdControls();
      updateOverlaysForCurrentEvent();
    });
    container.appendChild(btn);
  });
}

function renderLayerControls() {
  const container = document.getElementById("layer-rows");
  container.innerHTML = "";

  const keys = Object.keys(LAYERS_META);
  keys.forEach(key => {
    if (!(key in layerState)) {
      // Reference water is a diagnostic overlay (lakes/rivers, not a
      // flood/model layer), so keep it off by default to avoid clutter.
      layerState[key] = { visible: key !== "reference_water", opacity: 0.85 };
    }

    const meta = LAYERS_META[key];
    const row = document.createElement("div");
    row.className = "layer-row";

    const main = document.createElement("div");
    main.className = "layer-row-main";

    const label = document.createElement("label");
    label.className = "layer-label";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = layerState[key].visible;
    checkbox.addEventListener("change", () => {
      layerState[key].visible = checkbox.checked;
      updateOverlaysForCurrentEvent();
    });

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    if (key === "reference_water") {
      // Matches the hatched fill used for this layer on the map, so the
      // swatch doesn't look like just another flat-colour flood layer.
      swatch.style.backgroundColor = "rgba(0,172,193,0.35)";
      swatch.style.backgroundImage =
        "repeating-linear-gradient(45deg, rgba(0,172,193,0.9) 0, rgba(0,172,193,0.9) 2px, transparent 2px, transparent 6px)";
    } else {
      swatch.style.background = meta.color;
    }

    label.appendChild(checkbox);
    label.appendChild(swatch);
    label.appendChild(document.createTextNode(meta.label));

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.1";
    slider.max = "1";
    slider.step = "0.05";
    slider.value = layerState[key].opacity;
    slider.addEventListener("input", () => {
      layerState[key].opacity = parseFloat(slider.value);
      updateOverlaysForCurrentEvent();
    });

    const dateSpan = document.createElement("span");
    dateSpan.className = "layer-date";
    dateSpan.id = `layer-date-${key}`;

    main.appendChild(label);
    main.appendChild(slider);
    main.appendChild(dateSpan);

    row.appendChild(main);
    container.appendChild(row);
  });
}

// One CSI/FAR/HR-by-threshold table per observation source (everything
// in LAYERS_META except the model layer itself), always showing all
// thresholds at once regardless of which one is selected for the map.
function renderScoreTables(layers) {
  const container = document.getElementById("score-tables");
  container.innerHTML = "";

  const sourceKeys = Object.keys(LAYERS_META).filter(k => k !== "cama_flood");
  const fmt = v => (v === null || v === undefined ? "&ndash;" : v.toFixed(2));

  let anyScores = false;

  sourceKeys.forEach(key => {
    const layer = layers[key];
    if (!layer || !layer.scores) return;
    anyScores = true;

    const meta = LAYERS_META[key];
    const block = document.createElement("div");
    block.className = "score-block";

    const title = document.createElement("div");
    title.className = "score-block-title";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = meta.color;
    title.appendChild(swatch);
    title.appendChild(document.createTextNode(meta.label));
    block.appendChild(title);

    const rowsHtml = ["csi", "far", "hr"].map(metric => {
      const cells = THRESHOLDS.map(t => {
        const s = layer.scores[t.key];
        return `<td>${s ? fmt(s[metric]) : "&ndash;"}</td>`;
      }).join("");
      return `<tr><th>${metric.toUpperCase()}</th>${cells}</tr>`;
    }).join("");

    const headCells = THRESHOLDS.map(t => `<th>${t.label}</th>`).join("");

    block.insertAdjacentHTML("beforeend", `
      <table class="score-table">
        <thead><tr><th></th>${headCells}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `);

    container.appendChild(block);
  });

  if (!anyScores) {
    container.innerHTML = '<p class="muted">No benchmark scores computed for this event yet.</p>';
  }
}

function updateOverlaysForCurrentEvent() {
  clearOverlays();

  if (!currentEvent) return;

  const layers = EVENT_LAYERS[currentEvent] || {};
  const emptyMsg = document.getElementById("layer-empty");
  emptyMsg.style.display = Object.keys(layers).length ? "none" : "block";

  Object.keys(LAYERS_META).forEach(key => {
    const dateSpan = document.getElementById(`layer-date-${key}`);
    const layer = layers[key];

    if (dateSpan) dateSpan.textContent = layer ? layer.date || "" : "";

    if (!layer || !layerState[key] || !layerState[key].visible) return;

    const pngPath = layer.png[currentThreshold] || Object.values(layer.png)[0];
    if (!pngPath) return;

    const bounds = layer.bounds; // [[south, west], [north, east]]
    const overlay = L.imageOverlay(`dashboard_data/${pngPath}`, bounds, {
      opacity: layerState[key].opacity,
      interactive: false
    });
    overlay.addTo(map);
    activeOverlays[key] = overlay;
  });
}

function selectEvent(event, bounds) {
  currentEvent = event.flood_case;

  document.getElementById("event-title").textContent = event.flood_case;

  const riverLine = event.main_river_system
    ? `<b>Main river system:</b> ${event.main_river_system}<br>`
    : "";

  document.getElementById("event-info").innerHTML = `
    <b>Country:</b> ${event.country || "Unknown"}<br>
    <b>Continent:</b> ${event.continent || "Unknown"}<br>
    ${riverLine}
    <b>Date of max flood extent:</b> ${event.date_of_max_flood_extent}<br>
    <b>Latitude range:</b> ${event.lat_min} to ${event.lat_max}<br>
    <b>Longitude range:</b> ${event.lon_min} to ${event.lon_max}
  `;

  const img = document.getElementById("event-image");
  if (img) {
    img.src = `dashboard_data/floods_png/${event.flood_case}.png`;
    img.onerror = () => { img.style.display = "none"; };
    img.onload = () => { img.style.display = "block"; };
  }

  renderScoreTables(EVENT_LAYERS[currentEvent] || {});
  updateOverlaysForCurrentEvent();
  map.fitBounds(bounds);

  Object.values(eventListRows).forEach(row => row.classList.remove("active"));
  const activeRow = eventListRows[event.flood_case];
  if (activeRow) activeRow.classList.add("active");
}

function renderEventList(events) {
  const container = document.getElementById("event-list");
  const countLabel = document.getElementById("event-count");
  container.innerHTML = "";
  for (const key in eventListRows) delete eventListRows[key];

  const sorted = [...events].sort((a, b) => {
    const da = new Date(a.date_of_max_flood_extent);
    const db = new Date(b.date_of_max_flood_extent);
    return db - da; // newest first
  });

  countLabel.textContent = `(${sorted.length})`;

  sorted.forEach(event => {
    const bounds = [
      [event.lat_min, event.lon_min],
      [event.lat_max, event.lon_max]
    ];

    const row = document.createElement("div");
    row.className = "event-list-item";

    const name = document.createElement("span");
    name.className = "event-list-name";
    name.textContent = event.flood_case;

    const place = document.createElement("span");
    place.className = "event-list-place";
    place.textContent = [event.country, event.continent].filter(Boolean).join(", ") || "Unknown";

    const date = document.createElement("span");
    date.className = "event-list-date";
    date.textContent = event.date_of_max_flood_extent;

    row.appendChild(name);
    row.appendChild(place);
    row.appendChild(date);

    row.addEventListener("click", () => selectEvent(event, bounds));

    container.appendChild(row);
    eventListRows[event.flood_case] = row;
  });
}

// Cache-bust the manifest + catalogue CSV so a page load always sees the
// latest data, not a browser-cached copy from a previous run against the
// same URL (dashboard_shell.py serves plain http.server, no cache-control
// headers of its own).
const PAGE_LOAD_CACHE_BUST = Date.now();

fetch(`dashboard_data/layers.json?v=${PAGE_LOAD_CACHE_BUST}`)
  .then(r => (r.ok ? r.json() : { layers_meta: {}, thresholds: [], events: {} }))
  .catch(() => ({ layers_meta: {}, thresholds: [], events: {} }))
  .then(manifest => {
    LAYERS_META = manifest.layers_meta || {};
    EVENT_LAYERS = manifest.events || {};
    THRESHOLDS = manifest.thresholds || [];
    currentThreshold = manifest.default_threshold || (THRESHOLDS[0] && THRESHOLDS[0].key) || null;
    renderThresholdControls();
    renderLayerControls();

    Papa.parse(`dashboard_data/KuroSiwo_events.csv?v=${PAGE_LOAD_CACHE_BUST}`, {
      download: true,
      header: true,
      dynamicTyping: true,

      complete: function(results) {
        const data = results.data.filter(d => d.flood_case);

        renderEventList(data);

        data.forEach(event => {
          const bounds = [
            [event.lat_min, event.lon_min],
            [event.lat_max, event.lon_max]
          ];

          const color = continentColor(event.continent);

          const rect = L.rectangle(bounds, {
            color: color,
            weight: 2,
            fillColor: color,
            fillOpacity: 0.12
          }).addTo(map);

          const hoverText = `
            <div class="event-popup">
              <b>${event.flood_case}</b><br>
              ${event.country || "Unknown"} (${event.continent || "Unknown"})<br>
              Date: ${event.date_of_max_flood_extent}<br>
              BBox: ${event.lat_min}, ${event.lon_min}, ${event.lat_max}, ${event.lon_max}
            </div>
          `;

          rect.bindTooltip(hoverText, {
            sticky: true,
            direction: "top"
          });

          rect.on("click", () => selectEvent(event, bounds));
        });
      }
    });
  });
