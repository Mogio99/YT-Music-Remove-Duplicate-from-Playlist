/** YTM Duplicate Cleaner - popup */
"use strict";

const $ = (id) => document.getElementById(id);
let currentState = null;
// keepChoice[groupKey] = setVideoId della copia da TENERE, oppure "SKIP"
const keepChoice = {};

// ---------------------------------------------------------------- messaging
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(msg) {
  const tab = await activeTab();
  if (!tab || !tab.url || !tab.url.startsWith("https://music.youtube.com/")) {
    throw new Error("Apri una playlist su music.youtube.com e riprova.");
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // content script non ancora iniettato (pagina aperta prima dell'installazione)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tab.id, msg);
  }
}

// ---------------------------------------------------------------- rendering
function showMessage(text, cls) {
  const el = $("message");
  el.textContent = text;
  el.className = "message " + (cls || "");
}
function hideMessage() {
  $("message").className = "message hidden";
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function trackLabel(t) {
  const parts = [t.title];
  if (t.duration) parts.push(t.duration);
  if (t.album) parts.push(t.album);
  return parts.join(" · ");
}

function render(state) {
  currentState = state;
  const dupCount = state.groups.reduce((n, g) => n + (g.tracks.length - 1), 0);
  $("statTotal").textContent = state.totalSongs || "–";
  $("statDupes").textContent = state.groups.length ? dupCount : state.status === "ready" || state.status === "done" ? "0" : "–";

  const box = $("groups");
  box.innerHTML = "";

  if ((state.status === "ready" || state.status === "done") && state.groups.length === 0) {
    box.innerHTML = '<div class="empty">Nessun duplicato trovato 🎉</div>';
  }

  for (const g of state.groups) {
    if (!(g.key in keepChoice)) {
      // default: tieni la prima copia; ma se il gruppo mescola versioni feat diverse,
      // default "non toccare" — decide l'utente dalla combobox
      keepChoice[g.key] = g.featDiff ? "SKIP" : g.tracks[0].setVideoId;
    }
    const div = document.createElement("div");
    div.className = "group";

    let badge = "";
    if (g.exact) badge = '<span class="badge">COPIA ESATTA</span>';
    else if (g.featDiff) badge = '<span class="badge warn">FEAT — VERIFICA</span>';
    let html = `<h3>${esc(g.label)}${badge}</h3>`;

    for (const t of g.tracks) {
      const keep = keepChoice[g.key] === t.setVideoId;
      const skip = keepChoice[g.key] === "SKIP";
      const tag = skip ? "" : keep
        ? '<span class="tag keep">TIENI</span>'
        : '<span class="tag del">ELIMINA</span>';
      html += `
        <div class="track">
          ${t.thumb ? `<img src="${esc(t.thumb)}" alt="">` : ""}
          <div class="info">
            <div class="t">${esc(t.title)}</div>
            <div class="a">${esc(t.artist)}${t.duration ? " · " + esc(t.duration) : ""}${t.album ? " · " + esc(t.album) : ""}</div>
          </div>
          ${tag}
        </div>`;
    }

    // combobox: quale copia tenere
    html += `<div class="choice"><label>Tieni:</label><select data-key="${esc(g.key)}">`;
    g.tracks.forEach((t, i) => {
      const sel = keepChoice[g.key] === t.setVideoId ? "selected" : "";
      html += `<option value="${esc(t.setVideoId || "")}" ${sel}>Copia ${i + 1} — ${esc(trackLabel(t))}</option>`;
    });
    const selSkip = keepChoice[g.key] === "SKIP" ? "selected" : "";
    html += `<option value="SKIP" ${selSkip}>Non toccare questo gruppo</option>`;
    html += `</select></div>`;

    div.innerHTML = html;
    box.appendChild(div);
  }

  box.querySelectorAll("select").forEach((sel) => {
    sel.addEventListener("change", () => {
      keepChoice[sel.dataset.key] = sel.value === "SKIP" ? "SKIP" : sel.value;
      render(currentState);
    });
  });

  $("btnRemove").classList.toggle("hidden", state.groups.length === 0);

  if (state.status === "error" && state.error) showMessage(state.error, "err");
}

// ---------------------------------------------------------------- azioni
function plannedRemovals() {
  const out = [];
  for (const g of currentState.groups) {
    const keep = keepChoice[g.key];
    if (keep === "SKIP") continue;
    for (const t of g.tracks) {
      if (t.setVideoId !== keep) {
        out.push({ videoId: t.videoId, setVideoId: t.setVideoId, title: `${t.title} — ${t.artist}` });
      }
    }
  }
  return out;
}

$("btnScan").addEventListener("click", async () => {
  hideMessage();
  $("btnScan").disabled = true;
  $("btnScan").textContent = "⏳ Scansione in corso...";
  try {
    const resp = await send({ type: "scan" });
    if (!resp.ok) throw new Error(resp.error);
    Object.keys(keepChoice).forEach((k) => delete keepChoice[k]);
    render(resp.state);
    const dupCount = resp.state.groups.reduce((n, g) => n + (g.tracks.length - 1), 0);
    showMessage(
      `Trovati ${resp.state.totalSongs} brani, ${resp.state.groups.length} gruppi di duplicati (${dupCount} copie eliminabili).`,
      "ok"
    );
  } catch (e) {
    showMessage(e.message, "err");
  } finally {
    $("btnScan").disabled = false;
    $("btnScan").textContent = "🔍 Scansiona duplicati";
  }
});

$("btnRemove").addEventListener("click", async () => {
  const removals = plannedRemovals();
  if (removals.length === 0) {
    showMessage("Niente da rimuovere: tutti i gruppi sono impostati su 'Non toccare'.", "err");
    return;
  }
  if (!confirm(`Rimuovere ${removals.length} brani dalla playlist? L'operazione non è annullabile in blocco.`)) return;

  $("btnRemove").disabled = true;
  $("btnScan").disabled = true;
  $("btnRemove").textContent = "⏳ Rimozione...";
  try {
    const resp = await send({ type: "remove", removals });
    if (!resp.ok) throw new Error(resp.error);
    render(resp.state);
    const r = resp.state.lastResult || { removed: 0, failed: 0, errors: [] };
    const msg = `Fatto! Rimossi ${r.removed} brani` + (r.failed ? `, ${r.failed} falliti: ${r.errors.join("; ")}` : ".");
    showMessage(msg, r.failed ? "err" : "ok");
  } catch (e) {
    showMessage(e.message, "err");
  } finally {
    $("btnRemove").disabled = false;
    $("btnScan").disabled = false;
    $("btnRemove").textContent = "🗑 Rimuovi duplicati";
  }
});

// ---------------------------------------------------------------- init
(async () => {
  try {
    const resp = await send({ type: "getState" });
    if (resp.ok) {
      render(resp.state);
      if (!resp.state.onPlaylistPage) {
        showMessage("Apri la pagina di una playlist per fare lo scan.", "err");
      }
    }
  } catch (e) {
    showMessage(e.message, "err");
  }
})();
