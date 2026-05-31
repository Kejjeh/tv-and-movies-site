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

const state = {
  data: null,
  roles: new Set(["creator", "showrunner", "writer", "director", "producer"]),
  minPeople: 1,
  kind: "all",
  network: null,
  nodes: null,
  edges: null,
  selectedId: null,
};

async function load() {
  const r = await fetch("data.json");
  state.data = await r.json();
  setSubtitle();
  bindControls();
  render();
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

function buildNodes(titles) {
  return titles.map(t => {
    const primaryTone = t.tone_tags[0] || "cerebral";
    const baseColor = TONE_COLOR[primaryTone] || "#8ab4f8";
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
  const lines = [];
  const year = t.year ? ` (${t.year})` : "";
  lines.push(`<b>${escapeHtml(t.name)}${year}</b>`);
  if (t.imdb_rating) lines.push(`IMDb ${t.imdb_rating}`);
  lines.push(`${t.kind} · ${t.tone_tags.join(", ")}`);
  if (t.loved) lines.push("★ loved");
  const div = document.createElement("div");
  div.innerHTML = lines.join("<br>");
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

function render() {
  const titles = filterTitles();
  const nodeList = buildNodes(titles);
  const edgeList = buildEdges(titles);

  document.getElementById("stats").textContent =
    `${nodeList.length} nodes · ${edgeList.length} edges`;

  if (state.network) state.network.destroy();
  state.nodes = new vis.DataSet(nodeList);
  state.edges = new vis.DataSet(edgeList);

  const container = document.getElementById("network");
  const options = {
    physics: {
      barnesHut: {
        gravitationalConstant: -9000,
        springLength: 220,
        springConstant: 0.008,
        damping: 0.28,
        centralGravity: 0.15,
        avoidOverlap: 0.4,
      },
      stabilization: { iterations: 300 },
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
}

function showDetails(nodeId) {
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
  const matches = state.nodes.get()
    .filter(n => n._payload.name.toLowerCase().includes(q))
    .slice(0, 10);
  for (const n of matches) {
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

load();
