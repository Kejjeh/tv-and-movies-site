/* Discovery view: filmography web of every creative-role person in
   your brain. Renders as a vis-network graph (titles = nodes, shared
   people = edges) OR as a sortable list. */

const STATUS_COLOR = {
  loved:    "#ff8aa6",
  liked:    "#8ab4f8",
  ok:       "#88c0d0",
  started:  "#5dd6c4",
  disliked: "#6b5b3a",
  hated:    "#5c2932",
  candidate: "#9aa0a6",
  unseen:    "#444a5a",
};

const state = {
  view: "graph",
  minPeople: 2,
  minVotes: 100,
  minRating: 7.0,
  kind: "all",
  statuses: new Set(["unseen", "candidate", "ok", "started", "liked", "loved"]),
  data: null,
  network: null,
};

async function init() {
  const res = await fetch("discovery.json", { cache: "no-store" });
  if (!res.ok) {
    document.getElementById("subtitle").textContent =
      "discovery.json not found yet — run scripts/build_discovery.py then export_discovery.py";
    return;
  }
  state.data = await res.json();
  document.getElementById("subtitle").textContent =
    `${state.data.works.length} works · ${state.data.people.length} of your creative people · generated ${state.data.generated_at.slice(0,10)}`;
  bindControls();
  render();
}

function bindControls() {
  const peopleSlider = document.getElementById("min-people");
  peopleSlider.oninput = () => {
    state.minPeople = parseInt(peopleSlider.value, 10);
    document.getElementById("people-val").textContent = state.minPeople;
    render();
  };
  const votesSlider = document.getElementById("min-votes");
  votesSlider.oninput = () => {
    state.minVotes = parseInt(votesSlider.value, 10);
    document.getElementById("votes-val").textContent = state.minVotes;
    render();
  };
  const ratingSlider = document.getElementById("min-rating");
  ratingSlider.oninput = () => {
    state.minRating = parseFloat(ratingSlider.value);
    document.getElementById("rating-val").textContent = state.minRating.toFixed(1);
    render();
  };
  for (const btn of document.querySelectorAll("[data-view]")) {
    btn.onclick = () => {
      document.querySelectorAll("[data-view]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.view = btn.dataset.view;
      render();
    };
  }
  for (const btn of document.querySelectorAll("[data-kind]")) {
    btn.onclick = () => {
      document.querySelectorAll("[data-kind]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.kind = btn.dataset.kind;
      render();
    };
  }
  for (const btn of document.querySelectorAll("[data-status]")) {
    btn.onclick = () => {
      btn.classList.toggle("active");
      const s = btn.dataset.status;
      if (state.statuses.has(s)) state.statuses.delete(s);
      else state.statuses.add(s);
      render();
    };
  }
}

function filtered() {
  return state.data.works.filter(w =>
    w.people_count >= state.minPeople &&
    (w.vote_count || 0) >= state.minVotes &&
    (w.vote_average || 0) >= state.minRating &&
    (state.kind === "all" || w.kind === state.kind) &&
    state.statuses.has(w.status || "unseen")
  );
}

function render() {
  const works = filtered();
  document.getElementById("counts").textContent =
    `${works.length} works visible · ${works.filter(w => w.status === "unseen").length} unseen`;
  if (state.view === "graph") {
    document.getElementById("discovery-graph").hidden = false;
    document.getElementById("discovery-list").hidden = true;
    renderGraph(works);
  } else {
    document.getElementById("discovery-graph").hidden = true;
    document.getElementById("discovery-list").hidden = false;
    renderList(works);
  }
}

function renderGraph(works) {
  // Cap nodes for performance — show top-N by creative_weight when over budget
  const MAX_NODES = 400;
  const trimmed = works.slice(0, MAX_NODES);
  const nodes = trimmed.map(w => ({
    id: nodeId(w),
    label: w.name,
    value: w.creative_weight,
    color: STATUS_COLOR[w.status] || STATUS_COLOR.unseen,
    title: tooltip(w),
    shape: w.kind === "movie" ? "diamond" : "dot",
  }));

  // Edges via shared people: connect any two works that share ≥1 of your
  // creative people. Limit edge count by only emitting when overlap >= 1
  // and skipping huge complete subgraphs by capping per-node degree.
  const personToWorks = new Map();
  for (const w of trimmed) {
    for (const c of w.credits) {
      if (!personToWorks.has(c.person_id)) personToWorks.set(c.person_id, []);
      personToWorks.get(c.person_id).push(w);
    }
  }
  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edgeWeight = new Map();
  for (const ws of personToWorks.values()) {
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        const k = edgeKey(nodeId(ws[i]), nodeId(ws[j]));
        edgeWeight.set(k, (edgeWeight.get(k) || 0) + 1);
      }
    }
  }
  const edges = [...edgeWeight.entries()].map(([k, w]) => {
    const [from, to] = k.split("|");
    return { from, to, value: w, color: { color: "rgba(138,180,248,0.18)" } };
  });

  const container = document.getElementById("discovery-graph");
  if (state.network) state.network.destroy();
  state.network = new vis.Network(container, { nodes, edges }, {
    nodes: {
      shape: "dot",
      scaling: { min: 6, max: 28 },
      font: { color: "#e8eaed", size: 11 },
      borderWidth: 1,
    },
    edges: { smooth: false, width: 1, scaling: { min: 0.5, max: 4 } },
    // Mirrors the working Graph page: barnesHut + bounded stabilization +
    // physics turned OFF afterwards so the canvas doesn't keep spinning.
    physics: {
      barnesHut: {
        gravitationalConstant: -18000,
        springLength: 280,
        springConstant: 0.006,
        damping: 0.32,
        centralGravity: 0.06,
        avoidOverlap: 0.6,
      },
      maxVelocity: 50,
      stabilization: { iterations: 400 },
    },
    interaction: { hover: true, tooltipDelay: 200, keyboard: { enabled: false } },
  });
  // Freeze the network as soon as stabilization completes so the
  // canvas stops re-measuring its container (which on this layout
  // caused unbounded scrollbar growth). Two events fire — guard so
  // we only touch options once per render.
  let frozen = false;
  const freeze = () => {
    if (frozen || !state.network) return;
    frozen = true;
    state.network.setOptions({ physics: { enabled: false } });
    state.network.fit();      // no animation — would re-trigger resize ticks
  };
  state.network.once("stabilizationIterationsDone", freeze);
  state.network.once("stabilized", freeze);
}

function renderList(works) {
  const html = `
    <table>
      <thead><tr>
        <th>Title</th><th>Year</th><th>Kind</th><th>Status</th>
        <th>Your people</th><th>TMDb</th><th>Credits</th>
      </tr></thead>
      <tbody>
        ${works.slice(0, 500).map(w => `
          <tr>
            <td class="title-cell">${escapeHtml(w.name)}</td>
            <td>${w.year ?? ""}</td>
            <td>${w.kind}</td>
            <td><span class="status-badge status-${w.status}">${w.status}</span></td>
            <td>${w.people_count} · weight ${w.creative_weight}</td>
            <td><span class="imdb">${(w.vote_average || 0).toFixed(1)}</span> <small>(${w.vote_count || 0})</small></td>
            <td class="credits">${w.credits.slice(0, 5).map(c => `${escapeHtml(c.person_name)} (${c.role})`).join(", ")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ${works.length > 500 ? `<p style="padding:0.6rem;color:var(--text-dim);">… ${works.length - 500} more · tighten filters to narrow</p>` : ""}
  `;
  document.getElementById("discovery-list").innerHTML = html;
}

function nodeId(w) { return `${w.kind}:${w.tmdb_id}`; }
function tooltip(w) {
  const top = w.credits.slice(0, 8).map(c => `${c.person_name} (${c.role})`).join("\n");
  return `${w.name} (${w.year || "?"})\n${w.status} · TMDb ${(w.vote_average || 0).toFixed(1)}\n\n${top}`;
}
/* escapeHtml is provided by ui.js (loaded first). */

init();
