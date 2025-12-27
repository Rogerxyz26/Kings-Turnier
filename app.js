// Kingsturnier – Vanilla JS (stabil, ohne JSX)
// - Spieler default INAKTIV
// - Aktivieren/Deaktivieren jederzeit -> Warteliste & Tische aktualisieren live
// - Siegerwahl direkt AM TISCH
// - Timer + optisches Feedback
// - Spielerprofil als Modal (nicht unten "Wurst")
// - localStorage speichert dauerhaft: Spieler, Turnier, Archiv, Bilder

const LS = {
  players: "king_players_v3",
  tournament: "king_tournament_v3",
  archive: "king_archive_v3",
  assets: "king_assets_v3",
};

const VIEWS = [
  "Turnier",
  "Spielerliste",
  "Rangliste",
  "Gesamtrangliste",
  "Turnier-Archiv",
];

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function")
      n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  });
  children.forEach((c) =>
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c),
  );
  return n;
};

const uid = (p = "id") =>
  `${p}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function now() {
  return Date.now();
}
function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

let state = {
  view: "Turnier",
  players: load(LS.players, []),
  tournament: load(LS.tournament, null),
  archive: load(LS.archive, { tournaments: [], lifetimeById: {} }),
  assets: load(LS.assets, { logo: null, club: null }),
  modal: null,
};

function persist() {
  save(LS.players, state.players);
  save(LS.tournament, state.tournament);
  save(LS.archive, state.archive);
  save(LS.assets, state.assets);
}

function nameOf(id) {
  const p = state.players.find((x) => x.id === id);
  return p ? p.name : "—";
}

function ensureTournament() {
  if (!state.tournament) {
    state.tournament = {
      id: uid("t"),
      name: "",
      phase: "setup", // setup | live | finished
      startedAt: null,
      endedAt: null,
      tableCount: 4,
      auto: true,
      tables: [],
      waitlist: [],
      matches: [],
      statsById: {}, // playerId -> {wins,losses,games}
    };
  }
  if (!Array.isArray(state.tournament.tables)) state.tournament.tables = [];
  if (!Array.isArray(state.tournament.waitlist)) state.tournament.waitlist = [];
  if (!Array.isArray(state.tournament.matches)) state.tournament.matches = [];
  if (!state.tournament.statsById) state.tournament.statsById = {};

  // ensure tables 1..tableCount exist
  const tc = clampTables(state.tournament.tableCount);
  state.tournament.tableCount = tc;
  const existing = new Map(state.tournament.tables.map((t) => [t.id, t]));
  const next = [];
  for (let i = 1; i <= tc; i++) {
    const id = `table_${i}`;
    const old = existing.get(id);
    next.push(
      old || {
        id,
        label: `Tisch ${i}`,
        enabled: true,
        match: null, // {aId,bId,status,startAt,awaitAt,tableId,phase}
      },
    );
  }
  state.tournament.tables = next;
}

function clampTables(n) {
  const x = parseInt(n, 10);
  if (!Number.isFinite(x)) return 4;
  return Math.max(1, Math.min(4, x));
}

function ensureStatsFor(id) {
  if (!state.tournament.statsById[id])
    state.tournament.statsById[id] = { wins: 0, losses: 0, games: 0 };
}

/**
 * Synchronisiert Warteliste LIVE:
 * - nur aktive Spieler, die NICHT am Tisch sind
 * - füllt fehlende aktive Spieler in waitlist nach
 * - entfernt deaktivierte Spieler aus waitlist
 */
function syncWaitlist() {
  if (!state.tournament) return;

  const activeIds = new Set(
    state.players.filter((p) => p.active).map((p) => p.id),
  );
  const seatedIds = new Set();

  for (const tb of state.tournament.tables) {
    if (tb.match) {
      if (tb.match.aId) seatedIds.add(tb.match.aId);
      if (tb.match.bId) seatedIds.add(tb.match.bId);
    }
  }

  // clean waitlist
  state.tournament.waitlist = (state.tournament.waitlist || []).filter(
    (id) => activeIds.has(id) && !seatedIds.has(id),
  );

  // add missing active ids not seated and not in waitlist
  const inWait = new Set(state.tournament.waitlist);
  for (const id of activeIds) {
    if (!seatedIds.has(id) && !inWait.has(id)) {
      state.tournament.waitlist.push(id);
      inWait.add(id);
    }
  }
}

/** Wenn Spieler deaktiviert wird: sofort aus Tischen & Warteliste entfernen */
function removePlayerEverywhere(playerId) {
  // remove from waitlist
  if (state.tournament) {
    state.tournament.waitlist = (state.tournament.waitlist || []).filter(
      (x) => x !== playerId,
    );

    // remove from tables
    for (const tb of state.tournament.tables) {
      if (!tb.match) continue;
      const m = tb.match;
      if (m.aId === playerId || m.bId === playerId) {
        // Match abbrechen -> Tisch leeren
        tb.match = null;
      }
    }
  }
}

/** Auto-fill: setzt Spieler aus Warteliste an freie aktive Tische */
function autoFillTables() {
  if (!state.tournament || !state.tournament.auto) return;

  syncWaitlist();

  const wl = state.tournament.waitlist;
  for (const tb of state.tournament.tables) {
    if (!tb.enabled) continue;
    if (tb.match) continue;
    if (wl.length < 2) break;

    const aId = wl.shift();
    const bId = wl.shift();
    tb.match = {
      tableId: tb.id,
      phase: state.tournament.phase,
      aId,
      bId,
      status: "idle", // idle|running|await_winner
      startAt: null,
      awaitAt: null,
    };
    ensureStatsFor(aId);
    ensureStatsFor(bId);
  }
}

function startTournamentAuto() {
  ensureTournament();
  const active = state.players.filter((p) => p.active);
  if (active.length < 2) {
    alert("Mindestens 2 aktive Spieler nötig (Spielerliste).");
    return;
  }

  state.tournament.phase = "live";
  state.tournament.startedAt = state.tournament.startedAt || now();
  state.tournament.endedAt = null;

  // ensure waitlist includes active players
  syncWaitlist();
  // clear empty tables (but keep running matches)
  for (const tb of state.tournament.tables) {
    if (
      tb.match &&
      (tb.match.status === "running" || tb.match.status === "await_winner")
    )
      continue;
    tb.match = null;
  }

  autoFillTables();
  persist();
  render();
}

function newTournamentReset() {
  if (
    !confirm(
      "Neues Turnier starten? (Aktuelles Turnier wird zurückgesetzt, Spieler bleiben gespeichert.)",
    )
  )
    return;
  state.tournament = {
    id: uid("t"),
    name: "",
    phase: "setup",
    startedAt: null,
    endedAt: null,
    tableCount: 4,
    auto: true,
    tables: [],
    waitlist: [],
    matches: [],
    statsById: {},
  };
  ensureTournament();
  persist();
  render();
}

function finalizeAndSaveTournament() {
  ensureTournament();
  if (!confirm("Turnier abschließen & ins Archiv speichern?")) return;

  const rows = buildTurnierRows();
  const championId = rows.length ? rows[0].playerId : null;

  const entry = {
    id: state.tournament.id,
    name: state.tournament.name || "",
    endedAt: now(),
    participantsCount: state.players.filter((p) => p.active).length,
    championId,
    includedInOverall: true,
    snapshot: {
      matches: state.tournament.matches.slice(0),
      statsById: state.tournament.statsById,
      name: state.tournament.name || "",
    },
  };

  state.archive.tournaments.unshift(entry);
  state.archive.lifetimeById = recomputeLifetime();

  state.tournament.phase = "finished";
  state.tournament.endedAt = entry.endedAt;

  persist();
  alert("Turnier gespeichert!");
  render();
}

function recomputeLifetime() {
  // Gesamtwertung aus Archiv (nur includedInOverall)
  const life = {};
  const add = (id) => {
    if (!life[id])
      life[id] = {
        wins: 0,
        losses: 0,
        games: 0,
        tournamentsPlayed: 0,
        totalTournamentPoints: 0,
      };
    return life[id];
  };

  for (const t of state.archive.tournaments) {
    if (!t.includedInOverall) continue;
    // tournament points aus Rangliste (Snapshot) – simpel: 1. bekommt N, 2. N-1, ...
    const snapshotStats = t.snapshot?.statsById || {};
    const rows = buildRowsFromStats(snapshotStats);
    rows.forEach((r, idx) => {
      const s = add(r.playerId);
      s.wins += r.wins;
      s.losses += r.losses;
      s.games += r.games;
      // Punkte: absteigend (max = rows.length)
      s.totalTournamentPoints += Math.max(0, rows.length - idx);
    });

    // tournamentsPlayed: jeder mit mindestens 1 Spiel
    const touched = new Set(
      rows.filter((r) => r.games > 0).map((r) => r.playerId),
    );
    for (const id of touched) add(id).tournamentsPlayed += 1;
  }

  return life;
}

function buildRowsFromStats(statsById) {
  // Volumen-Gewichtung: Start-Boost = 4 Spiele bei 50% (2 Siege / 2 Niederlagen)
  // -> verhindert, dass 1 Spiel = 100% alles dominiert
  const PRIOR_GAMES = 4;
  const PRIOR_WINS = 2;

  const ids = Object.keys(statsById || {});
  const rows = ids.map((id) => {
    const s = statsById[id] || { wins: 0, losses: 0, games: 0 };

    const wins = s.wins || 0;
    const losses = s.losses || 0;
    const games = s.games || wins + losses;

    // Quote = "echte" Gewinnquote (nur aktuelle Spiele)
    const quote = games ? wins / games : 0;

    // Score = gewichtete Quote (berücksichtigt Spielanzahl)
    const score = (wins + PRIOR_WINS) / (games + PRIOR_GAMES);

    return {
      playerId: id,
      name: nameOf(id),
      wins,
      losses,
      games,
      quote, // für Anzeige
      score, // fürs Ranking
    };
  });

  // Sortierung: erst Score (gewichtet), dann Quote, dann Wins, dann Name
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.quote !== a.quote) return b.quote - a.quote;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function buildTurnierRows() {
  ensureTournament();
  return buildRowsFromStats(state.tournament.statsById);
}

function renderRootShell() {
  const root = $("#app");
  root.innerHTML = "";
  const container = el("div", { class: "container" });

  const top = el("div", { class: "topbar" }, [
    el("div", { class: "brand" }, [
      el("h1", {}, ["Kingsturnier"]),
      el("div", { class: "sub" }, ["King of the Table • Billard"]),
    ]),
    el("div", { class: "assets" }, [
      assetPicker("Logo", "logo"),
      assetPicker("Lokal", "club"),
    ]),
  ]);

  const tabs = el(
    "div",
    { class: "tabs" },
    VIEWS.map((v) => {
      const btn = el(
        "button",
        {
          class: `tab ${state.view === v ? "active" : ""}`,
          onclick: () => {
            state.view = v;
            persist();
            render();
          },
        },
        [v],
      );
      return btn;
    }),
  );

  container.appendChild(top);
  container.appendChild(tabs);

  root.appendChild(container);
  return container;
}

function assetPicker(label, key) {
  const box = el("div", {
    class: "assetBox",
    title: `${label} (klicken zum Ändern)`,
  });
  const img = state.assets[key] ? el("img", { src: state.assets[key] }) : null;
  if (img) box.appendChild(img);
  else box.appendChild(el("div", {}, [label]));

  const overlay = el("div", { class: "overlay" }, ["Bild ändern"]);
  box.appendChild(overlay);

  box.addEventListener("click", () => {
    const input = el("input", { type: "file", accept: "image/*" });
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      state.assets[key] = dataUrl;
      persist();
      render();
    });
    input.click();
  });
  return box;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ---------------------- Spieler ---------------------- */

function addPlayerFromInput() {
  const input = $("#addPlayerInput");
  if (!input) return;

  const name = (input.value || "").trim();
  if (!name) {
    input.focus();
    return;
  }

  const exists = state.players.some(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  if (exists) {
    input.select();
    input.focus();
    return;
  }

  // ✅ default INAKTIV
  const p = { id: uid("p"), name, active: false, createdAt: now() };
  state.players.push(p);

  // Cursor bleibt im Feld
  input.value = "";
  input.focus();

  // wenn Turnier existiert: sync (aktiv bleibt false -> nicht in waitlist)
  ensureTournament();
  syncWaitlist();

  persist();
  render();
}

function togglePlayerActive(id, active) {
  const p = state.players.find((x) => x.id === id);
  if (!p) return;
  p.active = !!active;

  ensureTournament();

  if (!p.active) {
    removePlayerEverywhere(id);
  }

  // ✅ live nachziehen
  syncWaitlist();
  autoFillTables();

  persist();
  render();
}

function renamePlayer(id) {
  const p = state.players.find((x) => x.id === id);
  if (!p) return;
  const neu = prompt("Neuer Spielername:", p.name);
  if (neu === null) return;
  const n = neu.trim();
  if (!n) return;
  // prevent duplicates
  const exists = state.players.some(
    (x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase(),
  );
  if (exists) {
    alert("Dieser Name existiert schon.");
    return;
  }
  p.name = n;
  persist();
  render();
}

function deletePlayer(id) {
  const p = state.players.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`Spieler "${p.name}" löschen?`)) return;

  // entfernen
  state.players = state.players.filter((x) => x.id !== id);

  // aus Turnier entfernen
  if (state.tournament) {
    removePlayerEverywhere(id);
    delete state.tournament.statsById[id];
    // matches bleiben als Historie (zeigen dann "—" wenn gelöscht)
  }

  persist();
  render();
}

/* ---------------------- Matches / Tisch ---------------------- */

function startMatch(tableId) {
  const tb = state.tournament.tables.find((x) => x.id === tableId);
  if (!tb || !tb.match) return;
  const m = tb.match;
  if (m.status !== "idle") return;
  m.status = "running";
  m.startAt = now();
  m.awaitAt = null;
  persist();
  render();
}

function stopMatchAskWinner(tableId) {
  const tb = state.tournament.tables.find((x) => x.id === tableId);
  if (!tb || !tb.match) return;
  const m = tb.match;
  if (m.status !== "running") return;
  m.status = "await_winner";
  m.awaitAt = now();
  persist();
  render();
}

function cancelMatch(tableId) {
  const tb = state.tournament.tables.find((x) => x.id === tableId);
  if (!tb || !tb.match) return;

  // beide zurück auf Warteliste, falls aktiv
  const { aId, bId } = tb.match;
  tb.match = null;

  const a = state.players.find((p) => p.id === aId);
  const b = state.players.find((p) => p.id === bId);

  ensureTournament();
  if (a && a.active) state.tournament.waitlist.push(aId);
  if (b && b.active) state.tournament.waitlist.push(bId);

  syncWaitlist();
  autoFillTables();
  persist();
  render();
}

function chooseWinner(tableId, winnerId) {
  const tb = state.tournament.tables.find((x) => x.id === tableId);
  if (!tb || !tb.match) return;
  const m = tb.match;

  if (m.status !== "await_winner") return;

  const loserId = m.aId === winnerId ? m.bId : m.aId;
  const dur = m.startAt ? now() - m.startAt : 0;

  ensureTournament();
  ensureStatsFor(winnerId);
  ensureStatsFor(loserId);

  state.tournament.statsById[winnerId].wins += 1;
  state.tournament.statsById[winnerId].games += 1;

  state.tournament.statsById[loserId].losses += 1;
  state.tournament.statsById[loserId].games += 1;

  state.tournament.matches.unshift({
    id: uid("m"),
    at: now(),
    phase: state.tournament.phase,
    tableLabel: tb.label,
    tableId: tb.id,
    aId: m.aId,
    bId: m.bId,
    winnerId,
    durationMs: dur,
  });

  // beide zurück in Warteliste, falls aktiv
  const w = state.players.find((p) => p.id === winnerId);
  const l = state.players.find((p) => p.id === loserId);
  tb.match = null;

  if (w && w.active) state.tournament.waitlist.push(winnerId);
  if (l && l.active) state.tournament.waitlist.push(loserId);

  syncWaitlist();
  autoFillTables();
  persist();
  render();
}

/* ---------------------- Profile / Modal ---------------------- */

function openPlayerProfile(playerId) {
  ensureTournament();
  const name = nameOf(playerId);
  const stats = state.tournament.statsById[playerId] || {
    wins: 0,
    losses: 0,
    games: 0,
  };
  const games = stats.games || stats.wins + stats.losses;
  const quote = games ? Math.round((stats.wins / games) * 100) : 0;

  const recent = state.tournament.matches
    .filter((m) => m.aId === playerId || m.bId === playerId)
    .slice(0, 30);

  const back = el("div", {
    class: "modalBack",
    onclick: (e) => {
      if (e.target === back) closeModal();
    },
  });
  const modal = el("div", { class: "modal" });

  modal.appendChild(el("h3", {}, [`Spielerprofil: ${name}`]));
  modal.appendChild(
    el("div", { class: "small" }, [
      `Aktuelles Turnier: Quote ${quote}% • ${stats.wins}-${stats.losses} • ${games} Spiele`,
    ]),
  );
  modal.appendChild(el("div", { class: "hr" }));

  if (!recent.length) {
    modal.appendChild(
      el("div", { class: "small" }, [
        "Noch keine Spiele im aktuellen Turnier.",
      ]),
    );
  } else {
    const list = el("div", { class: "list" });
    recent.forEach((m) => {
      const isWin = m.winnerId === playerId;
      const other = m.aId === playerId ? m.bId : m.aId;
      const t = new Date(m.at).toLocaleString("de-AT");
      list.appendChild(
        el("div", { class: "item" }, [
          el("div", { style: "font-weight:900" }, [
            isWin
              ? `✅ Sieg vs ${nameOf(other)}`
              : `❌ Niederlage vs ${nameOf(other)}`,
          ]),
          el("div", { class: "small mono" }, [
            `${t} • ${m.phase} • ${m.tableLabel} • ${fmtMs(m.durationMs)}`,
          ]),
        ]),
      );
    });
    modal.appendChild(list);
  }

  modal.appendChild(el("div", { class: "hr" }));
  modal.appendChild(
    el("button", { class: "btn primary", onclick: closeModal }, ["Schließen"]),
  );

  back.appendChild(modal);
  state.modal = back;
  render();
}

function closeModal() {
  state.modal = null;
  render();
}

/* ---------------------- Archive ---------------------- */

function toggleArchiveIncluded(id, included) {
  const t = state.archive.tournaments.find((x) => x.id === id);
  if (!t) return;
  t.includedInOverall = !!included;
  state.archive.lifetimeById = recomputeLifetime();
  persist();
  render();
}

function deleteTournament(id) {
  if (!confirm("Turnier wirklich löschen?")) return;
  state.archive.tournaments = state.archive.tournaments.filter(
    (t) => t.id !== id,
  );
  state.archive.lifetimeById = recomputeLifetime();
  persist();
  render();
}

function renameTournament(id) {
  const t = state.archive.tournaments.find((x) => x.id === id);
  if (!t) return;
  const neu = prompt("Neuer Turniername:", t.name || "");
  if (neu === null) return;
  const name = neu.trim();
  if (!name) return;
  t.name = name;
  persist();
  render();
}

/* ---------------------- Drag & Drop Warteliste ---------------------- */

let dragId = null;

function onDragStart(e, id) {
  dragId = id;
  e.dataTransfer?.setData("text/plain", id);
}
function onDrop(e, idx) {
  e.preventDefault();
  const id = e.dataTransfer?.getData("text/plain") || dragId;
  if (!id) return;
  const wl = state.tournament.waitlist || [];
  const from = wl.indexOf(id);
  if (from === -1) return;
  wl.splice(from, 1);
  wl.splice(idx, 0, id);
  persist();
  render();
}
function onDragOver(e) {
  e.preventDefault();
}

/* ---------------------- Render Views ---------------------- */

function render() {
  ensureTournament();

  const container = renderRootShell();

  // main
  let main;
  if (state.view === "Turnier") main = renderTurnier();
  else if (state.view === "Spielerliste") main = renderSpielerliste();
  else if (state.view === "Rangliste") main = renderRangliste();
  else if (state.view === "Gesamtrangliste") main = renderGesamtrangliste();
  else main = renderArchive();

  container.appendChild(main);

  // modal overlay
  const root = $("#app");
  const existing = $("#_modalMount");
  if (existing) existing.remove();
  const mount = el("div", { id: "_modalMount" });
  root.appendChild(mount);
  if (state.modal) mount.appendChild(state.modal);
}

function renderTurnier() {
  ensureTournament();

  const left = renderRanglisteCard(true);
  const center = renderTurnierCenter();
  const right = renderWaitlistCard();

  const grid = el("div", { class: "grid" }, [left, center, right]);
  return grid;
}

function renderSpielerliste() {
  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, ["Spielerliste"]));
  card.appendChild(
    el("div", { class: "small" }, [
      "Spieler anlegen (default inaktiv). Aktivieren/deaktivieren jederzeit — auch während Turnier läuft.",
    ]),
  );
  card.appendChild(el("div", { class: "hr" }));

  const addRow = el("div", { class: "itemBtnRow" }, [
    el("input", {
      class: "input",
      id: "addPlayerInput",
      placeholder: "Spielername eintippen und Enter…",
      onkeydown: (e) => {
        if (e.key === "Enter") addPlayerFromInput();
      },
    }),
    el("button", { class: "btn primary", onclick: addPlayerFromInput }, [
      "Hinzufügen",
    ]),
  ]);
  card.appendChild(addRow);

  card.appendChild(el("div", { class: "hr" }));

  if (!state.players.length) {
    card.appendChild(el("div", { class: "small" }, ["Noch keine Spieler."]));
    return card;
  }

  const list = el("div", { class: "list" });
  state.players
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => {
      const row = el("div", { class: "item" }, [
        el("div", { class: "row" }, [
          el("div", {}, [
            el("div", { style: "font-weight:900" }, [p.name]),
            el("div", { class: "small mono" }, [
              p.active ? "aktiv" : "inaktiv",
            ]),
          ]),
          el("div", { class: "itemBtnRow" }, [
            el("label", { class: "small" }, [
              el("input", {
                type: "checkbox",
                checked: p.active ? "checked" : null,
                onchange: (e) => togglePlayerActive(p.id, e.target.checked),
              }),
              " aktiv",
            ]),
            el("button", { class: "btn", onclick: () => renamePlayer(p.id) }, [
              "Umbenennen",
            ]),
            el(
              "button",
              { class: "btn danger", onclick: () => deletePlayer(p.id) },
              ["Löschen"],
            ),
          ]),
        ]),
      ]);
      list.appendChild(row);
    });

  card.appendChild(list);
  return card;
}

function renderRangliste() {
  return renderRanglisteCard(false);
}

function renderRanglisteCard(compact) {
  const rows = buildTurnierRows();
  const card = el("div", { class: "card" });
  card.appendChild(
    el("div", { class: "row" }, [
      el("h2", {}, [
        compact ? "Aktuelle Rangliste" : "Rangliste (aktuelles Turnier)",
      ]),
      el(
        "span",
        { class: `badge ${state.tournament.phase === "live" ? "live" : ""}` },
        [state.tournament.phase],
      ),
    ]),
  );
  card.appendChild(
    el("div", { class: "small" }, ["Klick auf Spieler = Profil"]),
  );

  if (!compact) {
    card.appendChild(el("div", { class: "hr" }));
    card.appendChild(
      el("div", { class: "item" }, [
        el("div", { class: "small" }, ["Turniername"]),
        el("input", {
          class: "input",
          value: state.tournament.name || "",
          placeholder: "z.B. Vereinsabend Dezember",
          oninput: (e) => {
            state.tournament.name = e.target.value;
            persist();
          },
        }),
      ]),
    );
  }

  card.appendChild(el("div", { class: "hr" }));

  if (!rows.length) {
    card.appendChild(el("div", { class: "small" }, ["Noch keine Spiele."]));
    return card;
  }

  const list = el("div", { class: "list" });
  rows.forEach((r, idx) => {
    const games = r.games || 0;
    const quote = games ? Math.round((r.wins / games) * 100) : 0;
    list.appendChild(
      el(
        "div",
        {
          class: "item clickable",
          onclick: () => openPlayerProfile(r.playerId),
        },
        [
          el("div", { style: "font-weight:900" }, [`${idx + 1}. ${r.name}`]),
          el("div", { class: "small mono" }, [
            `Score ${Math.round(r.score * 100)}% • Quote ${Math.round(r.quote * 100)}% • ${r.wins}-${r.losses} • ${games} Sp.`,
          ]),
        ],
      ),
    );
  });

  card.appendChild(list);
  return card;
}

function renderGesamtrangliste() {
  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, ["Gesamtrangliste"]));
  card.appendChild(
    el("div", { class: "small" }, [
      "Berechnet aus Turnier-Archiv (nur Turniere, die in der Gesamtwertung sind).",
    ]),
  );
  card.appendChild(el("div", { class: "hr" }));

  const lb = state.archive.lifetimeById || {};
  const rows = Object.entries(lb).map(([id, s]) => {
    const games = s.games || s.wins + s.losses;
    const quote = games ? s.wins / games : 0;
    return {
      playerId: id,
      name: nameOf(id),
      points: s.totalTournamentPoints || 0,
      tournaments: s.tournamentsPlayed || 0,
      wins: s.wins || 0,
      losses: s.losses || 0,
      games,
      quote,
    };
  });

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.tournaments !== a.tournaments) return b.tournaments - a.tournaments;
    return b.quote - a.quote;
  });

  if (!rows.length) {
    card.appendChild(
      el("div", { class: "small" }, ["Noch keine Archiv-Turniere."]),
    );
    return card;
  }

  const list = el("div", { class: "list" });
  rows.forEach((r, idx) => {
    list.appendChild(
      el("div", { class: "item" }, [
        el("div", { style: "font-weight:900" }, [`${idx + 1}. ${r.name}`]),
        el("div", { class: "small mono" }, [
          `Punkte ${r.points} • Turniere ${r.tournaments} • Quote ${Math.round(r.quote * 100)}% • ${r.wins}-${r.losses} • ${r.games} Sp.`,
        ]),
      ]),
    );
  });

  card.appendChild(list);
  return card;
}

function renderArchive() {
  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, ["Turnier-Archiv"]));
  card.appendChild(
    el("div", { class: "small" }, [
      "Turniere aus Gesamtwertung nehmen oder löschen / umbenennen.",
    ]),
  );
  card.appendChild(el("div", { class: "hr" }));

  if (!state.archive.tournaments.length) {
    card.appendChild(
      el("div", { class: "small" }, ["Noch keine Turniere gespeichert."]),
    );
    return card;
  }

  const list = el("div", { class: "list" });
  state.archive.tournaments.forEach((t) => {
    const label = new Date(t.endedAt).toLocaleString("de-AT");
    const title = t.name || label;

    list.appendChild(
      el("div", { class: "item" }, [
        el("div", { style: "font-weight:900" }, [title]),
        el("div", { class: "small mono" }, [
          `${label} • Teilnehmer: ${t.participantsCount} • Champion: ${t.championId ? nameOf(t.championId) : "—"}`,
        ]),
        el("div", { class: "itemBtnRow" }, [
          el(
            "button",
            { class: "btn", onclick: () => renameTournament(t.id) },
            ["Umbenennen"],
          ),
          el("label", { class: "small" }, [
            el("input", {
              type: "checkbox",
              checked: t.includedInOverall ? "checked" : null,
              onchange: (e) => toggleArchiveIncluded(t.id, e.target.checked),
            }),
            " in Gesamtwertung",
          ]),
          el(
            "button",
            { class: "btn danger", onclick: () => deleteTournament(t.id) },
            ["Löschen"],
          ),
        ]),
      ]),
    );
  });

  card.appendChild(list);
  return card;
}

function renderTurnierCenter() {
  ensureTournament();

  const t = state.tournament;
  const card = el("div", { class: "card" });

  card.appendChild(
    el("div", { class: "row" }, [
      el("h2", {}, ["Turnier"]),
      el(
        "span",
        {
          class: `badge ${t.phase === "live" ? "live" : ""} ${t.phase === "finished" ? "warn" : ""}`,
        },
        [t.phase],
      ),
    ]),
  );

  // Turniername
  card.appendChild(
    el("div", { class: "item" }, [
      el("div", { class: "small" }, ["Turniername"]),
      el("input", {
        class: "input",
        value: t.name || "",
        placeholder: "z.B. Vereinsabend Dezember",
        oninput: (e) => {
          t.name = e.target.value;
          persist();
        },
      }),
    ]),
  );

  card.appendChild(el("div", { class: "hr" }));

  // Controls
  card.appendChild(
    el("div", { class: "itemBtnRow" }, [
      el("button", { class: "btn ok", onclick: startTournamentAuto }, [
        "Turnier starten (auto)",
      ]),
      el("button", { class: "btn", onclick: newTournamentReset }, [
        "Neues Turnier (Reset)",
      ]),
            el(
        "button",
        { class: "btn primary", onclick: finalizeAndSaveTournament },
        ["Turnier abschließen & speichern"],
      ),
    ]),
  );
// Backup Controls
card.appendChild(
  el("div", { class: "itemBtnRow" }, [
    el(
      "button",
      {
        class: "btn",
        onclick: exportBackup,
      },
      ["Backup exportieren"]
    ),
    el("label", { class: "btn" }, [
      "Backup importieren",
      el("input", {
        type: "file",
        accept: "application/json",
        style: "display:none",
        onchange: (e) => {
          const f = e.target.files && e.target.files[0];
          if (f) importBackup(f);
          e.target.value = "";
        },
      }),
    ]),
  ])
);

  card.appendChild(el("div", { class: "hr" }));

  // Table controls
  const tableCtl = el("div", { class: "item" }, [
    el("div", { class: "small" }, ["Tische (1–4)"]),
    el("input", {
      class: "input",
      type: "number",
      min: "1",
      max: "4",
      value: String(t.tableCount || 4),
      oninput: (e) => {
        t.tableCount = clampTables(e.target.value);
        ensureTournament();
        syncWaitlist();
        autoFillTables();
        persist();
        render();
      },
    }),
    el("div", { class: "itemBtnRow", style: "margin-top:8px" }, [
      el("label", { class: "small" }, [
        el("input", {
          type: "checkbox",
          checked: t.auto ? "checked" : null,
          onchange: (e) => {
            t.auto = e.target.checked;
            persist();
            render();
          },
        }),
        " auto",
      ]),
      el("span", { class: "small" }, [
        "Tipp: Spieler kannst du jederzeit aktivieren (Spielerliste) – sie landen sofort in der Warteliste.",
      ]),
    ]),
  ]);
  card.appendChild(tableCtl);

  // Tables grid
  const grid = el("div", { class: "tableGrid" });
  t.tables.forEach((tb) => grid.appendChild(renderTable(tb)));
  card.appendChild(el("div", { class: "hr" }));
  card.appendChild(
    el("div", { style: "font-weight:900; margin-bottom:8px" }, ["Tische"]),
  );
  card.appendChild(grid);

  // Endrunde (Top 4) – minimal: zeigt Button (du wolltest ihn finden)
  card.appendChild(el("div", { class: "hr" }));
  card.appendChild(
    el("div", { class: "row" }, [
      el("div", {}, [
        el("div", { style: "font-weight:900" }, ["Endrunde (Top 4)"]),
        el("div", { class: "small" }, [
          "Optional: nimmt die Top 4 der Rangliste. (Hier nur vorbereitet – Logik können wir danach erweitern.)",
        ]),
      ]),
      el("span", { class: `badge ${t.phase === "live" ? "live" : ""}` }, [
        t.phase === "live" ? "bereit" : "inaktiv",
      ]),
    ]),
  );
  card.appendChild(
    el("div", { class: "itemBtnRow" }, [
      el(
        "button",
        {
          class: "btn warn",
          onclick: () =>
            alert(
              "Top-4-Endrunde ist vorbereitet. Wenn du willst, bauen wir Halbfinale/Finale als Extra-Ansicht sauber fertig.",
            ),
        },
        ["Halbfinale starten (Top 4)"],
      ),
    ]),
  );

  return card;
}

function renderTable(tb) {
  const t = state.tournament;
  const enabled = tb.enabled;

  const wrap = el("div", { class: "tableCard" });

  const head = el("div", { class: "tableHead" }, [
    el("div", { class: "tableName" }, [tb.label]),
    el("div", { class: "itemBtnRow" }, [
      el("label", { class: "small" }, [
        el("input", {
          type: "checkbox",
          checked: enabled ? "checked" : null,
          onchange: (e) => {
            tb.enabled = e.target.checked;
            if (!tb.enabled) tb.match = null;
            syncWaitlist();
            autoFillTables();
            persist();
            render();
          },
        }),
        " aktiv",
      ]),
    ]),
  ]);

  wrap.appendChild(head);

  const surfaceClass = !tb.match
    ? "tableSurface"
    : tb.match.status === "running"
      ? "tableSurface running"
      : tb.match.status === "await_winner"
        ? "tableSurface await"
        : "tableSurface";

  const surface = el("div", { class: surfaceClass });

  if (!tb.enabled) {
    surface.appendChild(el("div", { class: "small" }, ["Tisch deaktiviert."]));
    wrap.appendChild(surface);
    return wrap;
  }

  if (!tb.match) {
    surface.appendChild(
      el("div", { class: "small" }, [
        "Frei – wird automatisch aus Warteliste gefüllt (Auto).",
      ]),
    );
    wrap.appendChild(surface);
    return wrap;
  }

  const m = tb.match;
  const aName = nameOf(m.aId);
  const bName = nameOf(m.bId);

  const vsRow = el("div", { class: "vsRow" }, [
    el("div", { class: "pill" }, [aName]),
    el("div", { class: "vs" }, ["VS"]),
    el("div", { class: "pill" }, [bName]),
  ]);

  const elapsed =
    m.status === "running" && m.startAt
      ? now() - m.startAt
      : m.startAt
        ? m.awaitAt
          ? m.awaitAt - m.startAt
          : 0
        : 0;

  const timerLine = el("div", { class: "timerLine" }, [
    el("div", { class: "time mono" }, [fmtMs(elapsed)]),
    el("div", { class: "small" }, [
      m.status === "idle"
        ? "bereit"
        : m.status === "running"
          ? "läuft…"
          : "Sieger wählen",
    ]),
  ]);

  surface.appendChild(vsRow);
  surface.appendChild(timerLine);

  const btnRow = el("div", { class: "itemBtnRow", style: "margin-top:10px" }, [
    el(
      "button",
      {
        class: "btn ok",
        onclick: () => startMatch(tb.id),
        disabled: m.status !== "idle" ? "disabled" : null,
      },
      ["Spiel starten"],
    ),
    el(
      "button",
      {
        class: "btn warn",
        onclick: () => stopMatchAskWinner(tb.id),
        disabled: m.status !== "running" ? "disabled" : null,
      },
      ["Spiel beenden"],
    ),
    el("button", { class: "btn", onclick: () => cancelMatch(tb.id) }, [
      "Abbrechen",
    ]),
  ]);
  surface.appendChild(btnRow);

  if (m.status === "await_winner") {
    surface.appendChild(el("div", { class: "hr" }));
    surface.appendChild(
      el("div", { style: "font-weight:900; margin-bottom:6px" }, [
        "Gewonnen hat:",
      ]),
    );
    const winRow = el("div", { class: "winRow" }, [
      el(
        "button",
        { class: "btn ok", onclick: () => chooseWinner(tb.id, m.aId) },
        [aName],
      ),
      el(
        "button",
        { class: "btn ok", onclick: () => chooseWinner(tb.id, m.bId) },
        [bName],
      ),
    ]);
    surface.appendChild(winRow);
  }

  wrap.appendChild(surface);
  return wrap;
}

function renderWaitlistCard() {
  ensureTournament();
  syncWaitlist();

  const card = el("div", { class: "card" });
  card.appendChild(
    el("div", { class: "row" }, [
      el("h2", {}, ["Warteliste"]),
      el("span", { class: "badge" }, [
        String(state.tournament.waitlist.length),
      ]),
    ]),
  );
  card.appendChild(
    el("div", { class: "small dragHint" }, ["Drag&Drop zum Umreihen"]),
  );
  card.appendChild(el("div", { class: "hr" }));

  if (!state.tournament.waitlist.length) {
    card.appendChild(
      el("div", { class: "small" }, [
        "Leer. Aktiviere Spieler in der Spielerliste.",
      ]),
    );
    return card;
  }

  const list = el("div", { class: "list" });
  state.tournament.waitlist.forEach((id, idx) => {
    const it = el("div", { class: "item", draggable: "true" }, [
      el("div", { style: "font-weight:900" }, [`${idx + 1}. ${nameOf(id)}`]),
    ]);
    it.addEventListener("dragstart", (e) => onDragStart(e, id));
    it.addEventListener("dragover", onDragOver);
    it.addEventListener("drop", (e) => onDrop(e, idx));
    list.appendChild(it);
  });

  card.appendChild(list);
  return card;
}

/* ---------------------- Startup ---------------------- */

function boot() {
  ensureTournament();

  // ticker: nur wenn irgendwo ein Tisch läuft
  setInterval(() => {
    if (!state.tournament) return;
    const anyRunning = state.tournament.tables.some(
      (tb) => tb.match && tb.match.status === "running",
    );
    if (anyRunning) render();
  }, 500);

  render();
}
// ===============================
// BACKUP / RESTORE
// ===============================

function exportBackup() {
  const data = {
    version: 1,
    createdAt: new Date().toISOString(),
    state,
  };

  const blob = new Blob(
    [JSON.stringify(data, null, 2)],
    { type: "application/json" }
  );

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kingsturnier-backup-${Date.now()}.json`;
  a.click();
}

function importBackup(file) {
  const reader = new FileReader();

  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);

      if (!data.state) {
        alert("Ungültiges Backup");
        return;
      }

      state = data.state;   // 🔥 jetzt möglich
      persist();
      render();

      alert("Backup erfolgreich geladen");
    } catch (e) {
      alert("Fehler beim Laden des Backups");
    }
  };

  reader.readAsText(file);
}
boot();

// debug
window.__king = state;
