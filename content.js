/**
 * YTM Duplicate Cleaner - content script
 * Gira su music.youtube.com. Parla con l'API interna InnerTube della pagina:
 *  - browse (VL<playlistId>) per leggere tutte le tracce (con setVideoId, necessario per la rimozione)
 *  - playlist/edit_playlist (ACTION_REMOVE_VIDEO) per rimuovere le copie scelte
 * Nessuna automazione DOM: stessa API usata dalla pagina, autenticata con i cookie di sessione.
 */
"use strict";

// ---------------------------------------------------------------- stato
const state = {
  status: "idle", // idle | scanning | ready | removing | done | error
  playlistId: null,
  playlistTitle: null,
  totalSongs: 0,
  groups: [], // [{key, label, tracks:[{videoId,setVideoId,title,artist,duration,thumb,index}]}]
  lastResult: null, // {removed, failed, errors:[]}
  error: null,
};

// ---------------------------------------------------------------- config pagina
let cfgCache = null;
function getCfg() {
  if (cfgCache) return cfgCache;
  const html = document.documentElement.innerHTML;
  const grab = (re, fallback) => {
    const m = html.match(re);
    return m ? m[1] : fallback;
  };
  cfgCache = {
    apiKey: grab(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/, null),
    clientVersion: grab(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/, "1.20260101.01.00"),
    sessionIndex: grab(/"SESSION_INDEX"\s*:\s*"?(\d+)"?/, "0"),
    delegatedSession: grab(/"DELEGATED_SESSION_ID"\s*:\s*"([^"]+)"/, null),
  };
  return cfgCache;
}

// ---------------------------------------------------------------- auth (SAPISIDHASH)
function getCookie(name) {
  const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authHeader() {
  const sapisid = getCookie("SAPISID") || getCookie("__Secure-3PAPISID");
  if (!sapisid) throw new Error("Non sei loggato su YouTube Music (cookie SAPISID assente).");
  const ts = Math.floor(Date.now() / 1000);
  const hash = await sha1Hex(`${ts} ${sapisid} https://music.youtube.com`);
  return `SAPISIDHASH ${ts}_${hash}`;
}

// ---------------------------------------------------------------- chiamata API
async function api(endpoint, body, ctoken) {
  const cfg = getCfg();
  let url = `https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`;
  if (cfg.apiKey) url += `&key=${encodeURIComponent(cfg.apiKey)}`;
  if (ctoken) {
    const t = encodeURIComponent(ctoken);
    url += `&ctoken=${t}&continuation=${t}&type=next`;
  }
  const headers = {
    "Content-Type": "application/json",
    Authorization: await authHeader(),
    "X-Origin": "https://music.youtube.com",
    "X-Goog-AuthUser": cfg.sessionIndex,
  };
  if (cfg.delegatedSession) headers["X-Goog-PageId"] = cfg.delegatedSession;

  const payload = {
    context: {
      client: {
        clientName: "WEB_REMIX",
        clientVersion: cfg.clientVersion,
        hl: "it",
        gl: "IT",
      },
    },
    ...body,
  };
  const resp = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`API ${endpoint}: HTTP ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------- utility ricerca JSON
function findAll(obj, key, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) out.push(v);
    findAll(v, key, out);
  }
  return out;
}

function findFirst(obj, key) {
  const r = findAll(obj, key);
  return r.length ? r[0] : null;
}

function textOf(runsObj) {
  if (!runsObj) return "";
  if (runsObj.runs) return runsObj.runs.map((r) => r.text).join("");
  return runsObj.simpleText || "";
}

// ---------------------------------------------------------------- parsing tracce
function parseItem(mrlir, index) {
  const pid = mrlir.playlistItemData || {};
  const flex = mrlir.flexColumns || [];
  const col = (i) =>
    textOf(flex[i] && flex[i].musicResponsiveListItemFlexColumnRenderer
      ? flex[i].musicResponsiveListItemFlexColumnRenderer.text
      : null);
  const fixed = mrlir.fixedColumns || [];
  const duration = textOf(
    fixed[0] && fixed[0].musicResponsiveListItemFixedColumnRenderer
      ? fixed[0].musicResponsiveListItemFixedColumnRenderer.text
      : null
  );
  const thumbs = findFirst(mrlir.thumbnail || {}, "thumbnails") || [];
  return {
    index,
    videoId: pid.videoId || findFirst(mrlir, "videoId"),
    setVideoId: pid.playlistSetVideoId || null,
    title: col(0),
    artist: col(1),
    album: col(2),
    duration,
    thumb: thumbs.length ? thumbs[0].url : null,
  };
}

// ---------------------------------------------------------------- normalizzazione e dedup
const STRIP_TAGS =
  /\b(official\s*(music)?\s*(video|audio)?|lyric(s)?(\s*video)?|audio|visuali[sz]er|m\/?v|hd|hq|4k|full\s*(song|video)|topic)\b/i;
const KEEP_TAGS =
  /\b(remix|live|acoustic|acustic|unplugged|instrumental|cover|demo|sped\s*up|slowed|reverb|version|ver\s*\.?|edit|mix|radio|extended|tv|size|remaster(ed)?)\b/i;

function normalize(s, keepFeat = false) {
  if (!s) return "";
  let t = s.normalize("NFKC").toLowerCase();
  // rimuovi tag tra parentesi/quadre solo se puramente cosmetici (official video, audio, lyrics...)
  t = t.replace(/[\(\[\{]([^\)\]\}]*)[\)\]\}]/g, (m, inner) => {
    if (KEEP_TAGS.test(inner)) return " " + inner + " ";
    if (/\b(feat|ft)\.?\b/i.test(inner)) return keepFeat ? " " + inner + " " : " ";
    if (STRIP_TAGS.test(inner)) return " ";
    return " " + inner + " ";
  });
  if (!keepFeat) t = t.replace(/\b(feat|ft)\.?\s+.*$/i, " "); // feat. fuori parentesi
  t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // diacritici
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  return t;
}

function firstArtist(artist) {
  if (!artist) return "";
  // la colonna artista può contenere "A & B", "A, B", "A e B", "A • album"
  return artist.split(/\s*(?:,|&|•|·|\be\b|\band\b|×)\s*/i)[0] || artist;
}

function buildGroups(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const key = `${normalize(t.title)}|${normalize(firstArtist(t.artist))}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  const groups = [];
  for (const [key, arr] of map) {
    if (arr.length < 2) continue;
    const exact = new Set(arr.map((t) => t.videoId)).size < arr.length;
    // se tenendo il feat le chiavi divergono, il gruppo contiene versioni feat diverse:
    // possibile duplicato, ma la decisione spetta all'utente (default: non toccare)
    const featDiff = new Set(arr.map((t) => normalize(t.title, true))).size > 1;
    groups.push({
      key,
      label: `${arr[0].title} — ${firstArtist(arr[0].artist)}`,
      exact, // true se almeno due copie hanno lo stesso videoId
      featDiff,
      tracks: arr,
    });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

// ---------------------------------------------------------------- estrazione shelf playlist
/**
 * Estrae SOLO le tracce della playlist (non i "Suggerimenti" o le playlist correlate,
 * che contengono anch'essi musicResponsiveListItemRenderer) e il token di continuazione.
 * Gestisce sia il formato vecchio (nextContinuationData) sia il nuovo (continuationItemRenderer).
 */
function extractChunk(resp, initial) {
  let contents = null;
  let shelfConts = null;

  if (initial) {
    // la playlist è il primo musicPlaylistShelfRenderer della risposta;
    // i Suggerimenti stanno in sezioni successive di altro tipo
    const shelf = findFirst(resp, "musicPlaylistShelfRenderer");
    if (shelf) {
      contents = shelf.contents || [];
      shelfConts = shelf.continuations || null;
    }
  } else {
    const cont =
      findFirst(resp, "musicPlaylistShelfContinuation") ||
      findFirst(resp, "musicShelfContinuation");
    if (cont) {
      contents = cont.contents || [];
      shelfConts = cont.continuations || null;
    }
    if (!contents) {
      // formato nuovo: onResponseReceivedActions[].appendContinuationItemsAction.continuationItems
      const apps = findAll(resp, "appendContinuationItemsAction");
      if (apps.length) contents = apps.flatMap((a) => a.continuationItems || []);
    }
  }

  contents = contents || [];
  const items = [];
  let token = null;
  for (const c of contents) {
    if (c.musicResponsiveListItemRenderer) {
      items.push(c.musicResponsiveListItemRenderer);
    } else if (c.continuationItemRenderer) {
      const t = findFirst(c.continuationItemRenderer, "token");
      if (typeof t === "string") token = t;
    }
  }
  if (!token && shelfConts) {
    const t = findFirst(shelfConts, "continuation");
    if (typeof t === "string") token = t;
  }
  return { items, token };
}

// ---------------------------------------------------------------- scan
function playlistIdFromUrl() {
  const u = new URL(location.href);
  if (u.pathname !== "/playlist") return null;
  let id = u.searchParams.get("list");
  if (!id) return null;
  if (id.startsWith("VL")) id = id.slice(2);
  return id;
}

async function scan() {
  const playlistId = playlistIdFromUrl();
  if (!playlistId) throw new Error("Apri la pagina di una playlist su YouTube Music, poi rilancia lo scan.");
  state.status = "scanning";
  state.playlistId = playlistId;
  state.groups = [];
  state.lastResult = null;
  state.error = null;

  let resp = await api("browse", { browseId: "VL" + playlistId });
  state.playlistTitle = textOf(findFirst(resp, "title")) || playlistId;

  const tracks = [];
  const seenTokens = new Set();
  let guard = 0;
  let chunk = extractChunk(resp, true);
  while (guard++ < 300) {
    for (const mrlir of chunk.items) {
      tracks.push(parseItem(mrlir, tracks.length + 1));
    }
    if (!chunk.token || seenTokens.has(chunk.token)) break;
    seenTokens.add(chunk.token);
    resp = await api("browse", { continuation: chunk.token }, chunk.token);
    chunk = extractChunk(resp, false);
  }

  // tieni solo righe con videoId e titolo (esclude header/righe non-traccia)
  const clean = tracks.filter((t) => t.videoId && t.title);
  state.totalSongs = clean.length;
  state.groups = buildGroups(clean);
  state.status = "ready";
  return snapshot();
}

// ---------------------------------------------------------------- rimozione
async function removeTracks(removals) {
  // removals: [{videoId, setVideoId, title}]
  state.status = "removing";
  const result = { removed: 0, failed: 0, errors: [] };
  for (const r of removals) {
    if (!r.setVideoId) {
      result.failed++;
      result.errors.push(`${r.title}: manca setVideoId (playlist non tua o non modificabile).`);
      continue;
    }
    try {
      // NB: su music.youtube.com l'endpoint è browse/edit_playlist
      // (playlist/edit_playlist esiste solo su www.youtube.com e qui risponde 404)
      const resp = await api("browse/edit_playlist", {
        playlistId: state.playlistId,
        actions: [
          {
            action: "ACTION_REMOVE_VIDEO",
            setVideoId: r.setVideoId,
            removedVideoId: r.videoId,
          },
        ],
      });
      if (resp && resp.status === "STATUS_SUCCEEDED") {
        result.removed++;
      } else {
        result.failed++;
        result.errors.push(`${r.title}: risposta ${resp && resp.status}`);
      }
    } catch (e) {
      result.failed++;
      result.errors.push(`${r.title}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 350)); // rate limit prudente
  }
  state.lastResult = result;
  state.status = "done";
  // aggiorna lo stato locale rimuovendo le tracce eliminate dai gruppi
  const goneSet = new Set(removals.map((r) => r.setVideoId));
  if (result.removed > 0) {
    state.totalSongs -= result.removed;
    state.groups = state.groups
      .map((g) => ({ ...g, tracks: g.tracks.filter((t) => !goneSet.has(t.setVideoId)) }))
      .filter((g) => g.tracks.length > 1);
  }
  return snapshot();
}

// ---------------------------------------------------------------- messaging
function snapshot() {
  return {
    status: state.status,
    playlistId: state.playlistId,
    playlistTitle: state.playlistTitle,
    totalSongs: state.totalSongs,
    groups: state.groups,
    lastResult: state.lastResult,
    error: state.error,
    onPlaylistPage: !!playlistIdFromUrl(),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "getState") {
        sendResponse({ ok: true, state: snapshot() });
      } else if (msg.type === "scan") {
        const s = await scan();
        sendResponse({ ok: true, state: s });
      } else if (msg.type === "remove") {
        const s = await removeTracks(msg.removals || []);
        sendResponse({ ok: true, state: s });
      } else {
        sendResponse({ ok: false, error: "Messaggio sconosciuto" });
      }
    } catch (e) {
      state.status = "error";
      state.error = e.message;
      sendResponse({ ok: false, error: e.message, state: snapshot() });
    }
  })();
  return true; // risposta asincrona
});
