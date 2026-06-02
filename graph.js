/* Force-directed graph of seen titles connected by shared people.
   Loaded after vis-network UMD; uses the same data.json the
   recommendations page uses. */

const TONE_COLOR = {
  cerebral: "#8ab4f8",
  dystopian: "#e58c5a",
  paranoid: "#c293ff",
  antihero: "#f5c518",
  "animation-dark": "#5dd6c4",
  surreal: "#ff8aa6",
};

const CLUSTER_PALETTE = [
  "#8ab4f8", "#ff8aa6", "#c293ff", "#f5c518", "#5dd6c4", "#e58c5a",
  "#ffb86b", "#7ee787", "#ff79c6", "#bd93f9", "#50fa7b", "#ffb86c",
];
const ISOLATED_COLOR = "#5a5d66";

const NON_ACTOR_ROLES = new Set(["creator", "showrunner", "writer", "director", "producer"]);

const state = {
  data: null,
  roles: new Set(["creator", "showrunner", "writer", "director", "producer"]),
  minPeople: 1,
  kind: "all",
  network: null,
  nodes: null,
  edges: null,
  selectedId: null,
  peopleIndex: null,  // person_id -> { id, name, roles: Map(role->count), titles: [{title, role}] }
  colorMode: "tone",
  clusters: new Map(),         // nodeId -> clusterId (-1 for isolated)
  clusterMembers: new Map(),   // clusterId -> Set(nodeId)
  clusterLabels: [],           // [{clusterId, text, ids}]
  _labelEls: new Map(),        // clusterId -> HTMLElement
};

async function load() {
  const r = await fetch("data.json");
  state.data = await r.json();
  state.peopleIndex = buildPeopleIndex(state.data.titles);
  setSubtitle();
  bindControls();
  render();
}

function buildPeopleIndex(titles) {
  const idx = new Map();
  for (const t of titles) {
    if (!t.seen) continue;
    for (const p of t.people) {
      let entry = idx.get(p.id);
      if (!entry) {
        entry = { id: p.id, name: p.name, roles: new Map(), titles: [] };
        idx.set(p.id, entry);
      }
      entry.roles.set(p.role, (entry.roles.get(p.role) || 0) + 1);
      entry.titles.push({ title: t, role: p.role });
    }
  }
  return idx;
}

function setSubtitle() {
  const seen = state.data.titles.filter(t => t.seen).length;
  const loved = state.data.titles.filter(t => t.loved).length;
  document.getElementById("subtitle").textContent =
    `${seen} seen · ${loved} loved · click a node to inspect, scroll to zoom, drag to pan`;
}

function bindControls() {
  document.querySelectorAll("#role-chips .chip").forEach(b => {
    b.onclick = () => {
      const role = b.dataset.role;
      if (state.roles.has(role)) { state.roles.delete(role); b.classList.remove("active"); }
      else { state.roles.add(role); b.classList.add("active"); }
      render();
    };
  });
  document.querySelectorAll("#color-mode .chip").forEach(b => {
    b.onclick = () => {
      const mode = b.dataset.mode;
      if (mode === state.colorMode) return;
      state.colorMode = mode;
      document.querySelectorAll("#color-mode .chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      applyColorMode();
    };
  });
  document.querySelectorAll("#kind-chips .chip").forEach(b => {
    b.onclick = () => {
      state.kind = b.dataset.kind;
      document.querySelectorAll("#kind-chips .chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      render();
    };
  });
  const mp = document.getElementById("minppl");
  mp.oninput = () => {
    state.minPeople = parseInt(mp.value, 10);
    document.getElementById("minppl-val").textContent = state.minPeople;
    render();
  };
  const s = document.getElementById("search");
  s.oninput = () => onSearch(s.value);
  document.getElementById("close-details").onclick = () => {
    document.getElementById("details").classList.add("hidden");
    state.selectedId = null;
    if (state.network) state.network.unselectAll();
  };
}

function filterTitles() {
  let t = state.data.titles.filter(x => x.seen);
  if (state.kind === "tv") t = t.filter(x => x.kind === "tv");
  else if (state.kind === "movie") t = t.filter(x => x.kind === "movie");
  else if (state.kind === "loved") t = t.filter(x => x.loved);
  return t;
}

function colorForNode(t) {
  if (state.colorMode === "cluster") {
    const cid = state.clusters.get(t.tmdb_id);
    if (cid === undefined || cid === -1) return ISOLATED_COLOR;
    return CLUSTER_PALETTE[cid % CLUSTER_PALETTE.length];
  }
  const primaryTone = t.tone_tags[0] || "cerebral";
  return TONE_COLOR[primaryTone] || "#8ab4f8";
}

function buildNodes(titles) {
  return titles.map(t => {
    const baseColor = colorForNode(t);
    return {
      id: t.tmdb_id,
      label: t.name,
      title: makeNodeTooltip(t),
      shape: t.kind === "movie" ? "square" : "dot",
      size: t.loved ? 20 : 11,
      color: {
        background: baseColor,
        border: t.loved ? "#fff7a8" : "#1a1d27",
        highlight: { background: "#fff", border: "#ff8aa6" },
      },
      borderWidth: t.loved ? 3 : 1,
      font: { color: "#e8eaed", size: t.loved ? 13 : 10, face: "system-ui" },
      _payload: t,
    };
  });
}

function makeNodeTooltip(t) {
  const year = t.year ? ` (${t.year})` : "";
  const kindBadge = t.kind === "movie" ? "movie" : "tv";

  // Narrative id -> label lookup
  const narrLabels = new Map(
    (state.data && state.data.narratives ? state.data.narratives : []).map(n => [n.id, n.label])
  );
  // Cluster id -> label lookup
  const clusterLabel = (() => {
    if (t.cluster_id === undefined || t.cluster_id === -1) return null;
    const c = (state.data && state.data.clusters ? state.data.clusters : [])
      .find(c => c.cluster_id === t.cluster_id);
    return c ? c.label : null;
  })();

  const div = document.createElement("div");
  div.className = "node-tip";

  // 1. Title line
  const head = document.createElement("div");
  head.className = "tip-head";
  head.innerHTML =
    `<b>${escapeHtml(t.name)}${escapeHtml(year)}</b>` +
    ` <span class="tip-badge">${escapeHtml(kindBadge)}</span>`;
  div.appendChild(head);

  // 2. IMDb · ★ loved
  if (t.imdb_rating || t.loved) {
    const meta = document.createElement("div");
    meta.className = "tip-line";
    const bits = [];
    if (t.imdb_rating) bits.push(`IMDb ${t.imdb_rating}`);
    if (t.loved) bits.push("★ loved");
    meta.textContent = bits.join(" · ");
    div.appendChild(meta);
  }

  const addLabeled = (label, value) => {
    if (!value) return;
    const row = document.createElement("div");
    row.className = "tip-line tip-row";
    const lab = document.createElement("span");
    lab.className = "tip-label";
    lab.textContent = `${label}:`;
    const val = document.createElement("span");
    val.className = "tip-value";
    val.textContent = value;
    row.appendChild(lab);
    row.appendChild(document.createTextNode(" "));
    row.appendChild(val);
    div.appendChild(row);
  };

  // 3. Tones
  if (t.tone_tags && t.tone_tags.length) {
    addLabeled("Tones", t.tone_tags.join(", "));
  }

  // 4. Narratives (top 3, mapped to labels)
  if (t.narratives && t.narratives.length) {
    const top = t.narratives.slice(0, 3).map(id => narrLabels.get(id) || id);
    addLabeled("Narratives", top.join(", "));
  }

  // 5. Themes (top 4, already sorted by rarity)
  if (t.themes && t.themes.length) {
    addLabeled("Themes", t.themes.slice(0, 4).join(", "));
  }

  // 6. Cluster
  if (clusterLabel) {
    addLabeled("Cluster", clusterLabel);
  }

  return div;
}

function buildEdges(titles) {
  const titleIds = new Set(titles.map(t => t.tmdb_id));

  // person.id -> { name, appearances: [{titleId, role}] }
  const persons = new Map();
  for (const t of titles) {
    for (const p of t.people) {
      if (!state.roles.has(p.role)) continue;
      if (!persons.has(p.id)) persons.set(p.id, { name: p.name, appearances: [] });
      persons.get(p.id).appearances.push({ titleId: t.tmdb_id, role: p.role });
    }
  }

  // pair-key -> { people: [{id, name, role}], weight }
  const pairs = new Map();
  for (const [pid, info] of persons) {
    if (info.appearances.length < 2) continue;
    for (let i = 0; i < info.appearances.length; i++) {
      for (let j = i + 1; j < info.appearances.length; j++) {
        const ai = info.appearances[i], aj = info.appearances[j];
        if (!titleIds.has(ai.titleId) || !titleIds.has(aj.titleId)) continue;
        const a = Math.min(ai.titleId, aj.titleId);
        const b = Math.max(ai.titleId, aj.titleId);
        const key = `${a}|${b}`;
        if (!pairs.has(key)) pairs.set(key, { people: [], weight: 0 });
        const entry = pairs.get(key);
        const roleWeight = (state.data.role_weights[ai.role] ?? 1.0);
        entry.people.push({ id: pid, name: info.name, role: ai.role });
        entry.weight += roleWeight;
      }
    }
  }

  const edges = [];
  for (const [key, info] of pairs) {
    if (info.people.length < state.minPeople) continue;
    const [from, to] = key.split("|").map(Number);
    edges.push({
      id: key,
      from, to,
      value: info.weight,
      title: makeEdgeTooltip(info.people),
      color: { color: edgeColor(info.weight), highlight: "#8ab4f8" },
      smooth: false,
      _people: info.people,
    });
  }
  return edges;
}

function makeEdgeTooltip(people) {
  const grouped = {};
  for (const p of people) {
    if (!grouped[p.role]) grouped[p.role] = [];
    grouped[p.role].push(p.name);
  }
  const div = document.createElement("div");
  div.innerHTML = Object.entries(grouped)
    .map(([role, names]) => `<b>${role}</b>: ${names.map(escapeHtml).join(", ")}`)
    .join("<br>");
  return div;
}

function edgeColor(weight) {
  // weight 1.0..10 -> alpha 0.25..0.8 over a neutral grey
  const a = Math.min(0.8, 0.25 + weight * 0.05);
  return `rgba(138, 180, 248, ${a.toFixed(2)})`;
}

// ---- Server-computed clusters (Louvain, baked into data.json) ----------

function populateClustersFromData(titles) {
  // Read cluster_id assigned by scripts/export_to_json.py (Louvain).
  const clusters = new Map();
  const clusterMembers = new Map();
  for (const t of titles) {
    const cid = (t.cluster_id === undefined ? -1 : t.cluster_id);
    clusters.set(t.tmdb_id, cid);
    if (!clusterMembers.has(cid)) clusterMembers.set(cid, new Set());
    clusterMembers.get(cid).add(t.tmdb_id);
  }
  state.clusters = clusters;
  state.clusterMembers = clusterMembers;

  // Build labels from the server-side metadata
  const labelByCid = new Map();
  for (const c of (state.data.clusters || [])) {
    // Trim auteur labels to last name where reasonable
    const parts = c.label.split(/\s+/);
    const text = parts.length > 1 ? parts[parts.length - 1] : c.label;
    labelByCid.set(c.cluster_id, text);
  }

  const out = [];
  for (const [cid, members] of clusterMembers) {
    if (cid === -1) continue;
    if (members.size < 4) continue;
    const text = labelByCid.get(cid) || `cluster ${cid}`;
    out.push({ clusterId: cid, text, ids: [...members] });
  }
  state.clusterLabels = out;
}

function ensureLabelEls() {
  const container = document.getElementById("network-container");
  // Remove stale
  const liveIds = new Set(state.clusterLabels.map(l => l.clusterId));
  for (const [cid, el] of state._labelEls) {
    if (!liveIds.has(cid)) {
      el.remove();
      state._labelEls.delete(cid);
    }
  }
  for (const lbl of state.clusterLabels) {
    let el = state._labelEls.get(lbl.clusterId);
    if (!el) {
      el = document.createElement("div");
      el.className = "cluster-label";
      container.appendChild(el);
      state._labelEls.set(lbl.clusterId, el);
    }
    el.textContent = lbl.text;
  }
}

function renderClusterLabels() {
  if (state.colorMode !== "cluster" || !state.network) {
    for (const el of state._labelEls.values()) el.style.display = "none";
    return;
  }
  for (const lbl of state.clusterLabels) {
    const el = state._labelEls.get(lbl.clusterId);
    if (!el) continue;
    const positions = state.network.getPositions(lbl.ids);
    let sx = 0, sy = 0, n = 0;
    for (const id of lbl.ids) {
      const p = positions[id];
      if (!p) continue;
      sx += p.x; sy += p.y; n++;
    }
    if (n === 0) { el.style.display = "none"; continue; }
    const dom = state.network.canvasToDOM({ x: sx / n, y: sy / n });
    el.style.left = `${dom.x}px`;
    el.style.top = `${dom.y}px`;
    el.style.display = "";
  }
}

function applyColorMode() {
  if (!state.nodes) return;
  const updates = [];
  state.nodes.forEach(n => {
    const t = n._payload;
    const baseColor = colorForNode(t);
    updates.push({
      id: n.id,
      color: {
        background: baseColor,
        border: t.loved ? "#fff7a8" : "#1a1d27",
        highlight: { background: "#fff", border: "#ff8aa6" },
      },
    });
  });
  state.nodes.update(updates);
  renderClusterLabels();
}

function clearAllLabels() {
  for (const el of state._labelEls.values()) el.remove();
  state._labelEls.clear();
}

function render() {
  const titles = filterTitles();
  const edgeList = buildEdges(titles);
  populateClustersFromData(titles);
  const nodeList = buildNodes(titles);

  document.getElementById("stats").textContent =
    `${nodeList.length} nodes · ${edgeList.length} edges`;

  if (state.network) {
    state.network.destroy();
    clearAllLabels();
  }
  state.nodes = new vis.DataSet(nodeList);
  state.edges = new vis.DataSet(edgeList);

  const container = document.getElementById("network");
  const options = {
    physics: {
      barnesHut: {
        gravitationalConstant: -18000,
        springLength: 340,
        springConstant: 0.006,
        damping: 0.32,
        centralGravity: 0.06,
        avoidOverlap: 0.6,
      },
      maxVelocity: 50,
      stabilization: { iterations: 400 },
    },
    nodes: { borderWidth: 1 },
    edges: { smooth: false, width: 1 },
    interaction: {
      hover: true,
      tooltipDelay: 150,
      multiselect: false,
      navigationButtons: false,
      keyboard: { enabled: false },
    },
  };

  state.network = new vis.Network(container, { nodes: state.nodes, edges: state.edges }, options);
  state.network.on("click", params => {
    if (params.nodes.length === 0) return;
    showDetails(params.nodes[0]);
  });
  state.network.on("doubleClick", params => {
    if (params.nodes.length === 0) return;
    state.network.focus(params.nodes[0], { scale: 1.3, animation: { duration: 400 } });
  });

  ensureLabelEls();
  state.network.on("afterDrawing", renderClusterLabels);
  state.network.on("zoom", renderClusterLabels);
  state.network.on("dragEnd", renderClusterLabels);
  renderClusterLabels();
}

const TITLE_HEADERS = ["Tones", "Genres", "People", "Connected titles"];

function resetPanelHeaders() {
  const headers = document.querySelectorAll("#details h4");
  for (let i = 0; i < headers.length; i++) {
    headers[i].textContent = TITLE_HEADERS[i] || "";
    headers[i].style.display = "";
  }
}

function showDetails(nodeId) {
  resetPanelHeaders();
  state.selectedId = nodeId;
  const t = state.nodes.get(nodeId)._payload;
  document.getElementById("d-title").textContent = `${t.name}${t.year ? ` (${t.year})` : ""}`;
  const metaBits = [t.kind];
  if (t.imdb_rating) metaBits.push(`IMDb ${t.imdb_rating}`);
  if (t.loved) metaBits.push("★ loved");
  document.getElementById("d-meta").textContent = metaBits.join(" · ");
  document.getElementById("d-tones").textContent = t.tone_tags.join(", ") || "—";
  document.getElementById("d-genres").textContent = t.genres.join(", ") || "—";

  const peopleUl = document.getElementById("d-people");
  peopleUl.innerHTML = "";
  for (const p of t.people) {
    const li = document.createElement("li");
    li.innerHTML = `${escapeHtml(p.name)} <span class="role">${escapeHtml(p.role)}</span>`;
    peopleUl.appendChild(li);
  }

  // connected titles via current edges
  const connections = new Map(); // titleId -> {via: [people]}
  state.edges.forEach(e => {
    if (e.from === nodeId || e.to === nodeId) {
      const other = e.from === nodeId ? e.to : e.from;
      connections.set(other, e._people);
    }
  });
  const connUl = document.getElementById("d-connections");
  connUl.innerHTML = "";
  if (connections.size === 0) {
    const li = document.createElement("li");
    li.textContent = "(no connections under current filters)";
    li.style.color = "var(--text-dim)";
    connUl.appendChild(li);
  } else {
    const sorted = [...connections.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [otherId, people] of sorted) {
      const other = state.nodes.get(otherId)._payload;
      const li = document.createElement("li");
      const names = people.map(p => p.name).slice(0, 3).join(", ");
      const more = people.length > 3 ? ` +${people.length - 3} more` : "";
      li.innerHTML = `<a class="title-link" data-id="${otherId}">${escapeHtml(other.name)}</a>
        <span class="role">via ${escapeHtml(names)}${more}</span>`;
      connUl.appendChild(li);
    }
    connUl.querySelectorAll(".title-link").forEach(a => {
      a.onclick = () => {
        const id = parseInt(a.dataset.id, 10);
        showDetails(id);
        state.network.selectNodes([id]);
        state.network.focus(id, { scale: 1.2, animation: { duration: 400 } });
      };
    });
  }

  document.getElementById("details").classList.remove("hidden");
}

function onSearch(q) {
  const results = document.getElementById("search-results");
  results.innerHTML = "";
  q = q.trim().toLowerCase();
  if (!q) return;

  const titleMatches = state.nodes.get()
    .filter(n => n._payload.name.toLowerCase().includes(q))
    .slice(0, 6);
  const peopleMatches = [...state.peopleIndex.values()]
    .filter(p => p.name.toLowerCase().includes(q))
    .sort((a, b) => b.titles.length - a.titles.length)
    .slice(0, 8);

  if (titleMatches.length === 0 && peopleMatches.length === 0) {
    const div = document.createElement("div");
    div.className = "result";
    div.style.color = "var(--text-dim)";
    div.textContent = "no matches";
    results.appendChild(div);
    return;
  }

  if (titleMatches.length > 0) {
    const h = document.createElement("div");
    h.className = "result-header";
    h.textContent = "TITLES";
    results.appendChild(h);
    for (const n of titleMatches) {
      const div = document.createElement("div");
      div.className = "result";
      div.textContent = n._payload.name;
      div.onclick = () => {
        state.network.selectNodes([n.id]);
        state.network.focus(n.id, { scale: 1.4, animation: { duration: 400 } });
        showDetails(n.id);
      };
      results.appendChild(div);
    }
  }
  if (peopleMatches.length > 0) {
    const h = document.createElement("div");
    h.className = "result-header";
    h.textContent = "PEOPLE";
    results.appendChild(h);
    for (const p of peopleMatches) {
      const div = document.createElement("div");
      div.className = "result";
      const roleNames = [...p.roles.keys()].join(", ");
      div.innerHTML = `${escapeHtml(p.name)}
        <span class="result-meta">${p.titles.length}× · ${escapeHtml(roleNames)}</span>`;
      div.onclick = () => showPerson(p.id);
      results.appendChild(div);
    }
  }
}

function showPerson(personId) {
  const p = state.peopleIndex.get(personId);
  if (!p) return;
  resetPanelHeaders();

  const roleSummary = [...p.roles.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([role, n]) => n > 1 ? `${role} ×${n}` : role)
    .join(", ");

  document.getElementById("d-title").textContent = p.name;
  document.getElementById("d-meta").textContent = `${p.titles.length} appearance${p.titles.length === 1 ? "" : "s"} · ${roleSummary}`;
  document.getElementById("d-tones").textContent = "—";
  document.getElementById("d-genres").textContent = "—";

  document.getElementById("d-people").innerHTML = "";
  const connUl = document.getElementById("d-connections");
  connUl.innerHTML = "";

  // Mutate the headers so the panel reads as a person view
  const headers = document.querySelectorAll("#details h4");
  if (headers.length >= 4) {
    headers[0].textContent = "Roles";
    headers[1].textContent = "Appearances in seen-set";
    headers[2].textContent = "Titles";
    headers[3].style.display = "none";
  }
  document.getElementById("d-tones").textContent = roleSummary;
  document.getElementById("d-genres").textContent = `${p.titles.length} title${p.titles.length === 1 ? "" : "s"} below`;

  // Reuse d-people for the title list with one-click navigation
  const titlesUl = document.getElementById("d-people");
  // sort by year desc
  const sorted = [...p.titles].sort((a, b) =>
    (b.title.year || 0) - (a.title.year || 0)
  );
  for (const entry of sorted) {
    const t = entry.title;
    const li = document.createElement("li");
    const yr = t.year ? `(${t.year})` : "";
    const loved = t.loved ? " ★" : "";
    li.innerHTML = `<a class="title-link" data-id="${t.tmdb_id}">${escapeHtml(t.name)} ${yr}${loved}</a>
      <span class="role">${escapeHtml(entry.role)}${t.kind === "movie" ? " · movie" : ""}</span>`;
    titlesUl.appendChild(li);
  }
  titlesUl.querySelectorAll(".title-link").forEach(a => {
    a.onclick = () => {
      const tid = parseInt(a.dataset.id, 10);
      showDetails(tid);
      state.network.selectNodes([tid]);
      state.network.focus(tid, { scale: 1.3, animation: { duration: 400 } });
    };
  });

  // Highlight all this person's title nodes in the graph
  const ids = p.titles.map(t => t.title.tmdb_id).filter(id => state.nodes.get(id));
  if (ids.length > 0) {
    state.network.selectNodes(ids);
    if (ids.length > 1) state.network.fit({ nodes: ids, animation: { duration: 500 } });
    else state.network.focus(ids[0], { scale: 1.3, animation: { duration: 400 } });
  }

  document.getElementById("details").classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

load();
