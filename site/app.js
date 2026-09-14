// --- two players, so that the sound never stops ---------------------------------------
// Chrome keeps a backgrounded page alive while it is audible, and the exemption "lasts
// for several seconds after audio stops playing to allow applications to queue the next
// audio track" - after which a phone with a dark screen freezes the page and will not
// let it take the sound back, because android forbids restarting a media foreground
// service from the background. Swapping src on one element puts a hole of silence in
// exactly the wrong place: the log has watched a track start from a full buffer and be
// paused a tenth of a second later.
//
// So there are two elements and the next track starts before the last one finishes.
// Which of them is the player of record moves between them; everything else in this file
// goes on saying `audio` and means whichever that is.
const audioA = document.getElementById("audio");
const audioB = audioA.cloneNode(false);
audioB.removeAttribute("id");
audioA.parentNode.insertBefore(audioB, audioA.nextSibling);
const players = [audioA, audioB];
let audio = audioA;

// Listeners go on both and fire for one: an element that is not the player of record is
// either finishing its last second or sitting empty, and neither is anybody's business.
function onAudio(type, handler, options) {
  const forTheActiveOne = (e) => {
    if (e.target === audio) handler(e);
  };
  players.forEach((el) => el.addEventListener(type, forTheActiveOne, options));
}

function idlePlayer() {
  return audio === audioA ? audioB : audioA;
}

// The one that has just been handed over from: it plays out its own last second and is
// then emptied, so it is ready to be the next incoming.
players.forEach((el) =>
  el.addEventListener("ended", () => {
    if (el === audio) return;
    el.removeAttribute("src");
    el.load();
  })
);

// Under a flag while it is proved: ?gapless=1 turns it on, ?gapless=0 off, and the
// choice sticks, because a tab thrown out of memory comes back without its query.
const GAPLESS_KEY = "rd_player_gapless_v1";
let gapless = false;
try {
  const asked = new URLSearchParams(location.search);
  if (asked.has("gapless")) {
    gapless = asked.get("gapless") !== "0";
    localStorage.setItem(GAPLESS_KEY, gapless ? "1" : "0");
  } else {
    // On unless it has been turned off: twenty-four minutes and five handovers with the
    // screen dark, against seven minutes and a stop before this existed.
    gapless = localStorage.getItem(GAPLESS_KEY) !== "0";
  }
} catch (e) {
  gapless = new URLSearchParams(location.search).get("gapless") !== "0";
}

const nowTitle = document.getElementById("now-title");
const nowArtist = document.getElementById("now-artist");
const artwork = document.getElementById("artwork");
const coverView = document.getElementById("cover-view");
const coverViewImg = document.getElementById("cover-view-img");
const playerEl = document.querySelector(".player");
const playBtn = document.getElementById("play-btn");
const seekEl = document.getElementById("seek");
const muteBtn = document.getElementById("mute-btn");
const volPopEl = document.getElementById("vol-pop");
const volEl = document.getElementById("vol");
const nowLikeBtn = document.getElementById("now-like");
const postContextEl = document.getElementById("post-context");
const postContextLinkEl = document.getElementById("post-context-link");
const postContextTextEl = document.getElementById("post-context-text");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const radioBtn = document.getElementById("radio-btn");
const transportEl = document.querySelector(".transport");
const nowPlayingEl = document.querySelector(".now-playing");
const nowHeadEl = document.getElementById("now-head");
const searchEl = document.getElementById("search");
const searchWrapEl = document.querySelector(".search-wrap");
const searchClearEl = document.getElementById("search-clear");
const hailEl = document.getElementById("hail");
const hailLineEl = document.getElementById("hail-line");
const hailFaceEl = document.getElementById("hail-face");
const postListEl = document.getElementById("post-list");
const playerSlot = document.getElementById("player-slot");
const preciousBtn = document.getElementById("precious-btn");
const preciousCountEl = document.getElementById("precious-count");
const listInfoEl = document.getElementById("list-info");


// --- analytics ----------------------------------------------------------------------
// GoatCounter, loaded at the bottom of index.html: a visit counted on load, plus the
// presses tallied below. What goes out is the name of a control and nothing else - not
// the track, not the album, not the search query. The point is to see which parts of
// the player get used; who used them is deliberately out of reach, the same promise
// the likes and categories in localStorage already make.
//
// The script is async and a good share of the audience blocks it outright, so every
// call here has to survive it simply not being there. Analytics is never allowed to be
// the reason a button stops working.

function tally(name) {
  try {
    window.goatcounter?.count?.({ path: name, event: true });
  } catch (e) {
    // blocked, half-loaded, offline - all of it is fine, the press already happened
  }
}

// For the things worth counting per visitor rather than per press: one listener who
// searched eleven times is one person who uses the search, not eleven.
const tallied = new Set();

function tallyOnce(name) {
  if (tallied.has(name)) return;
  tallied.add(name);
  tally(name);
}

const UI_PREFS_KEY = "rd_player_prefs_v1";
const PAGE_SIZE = 30; // posts appended per step - the channel has thousands of tracks,
// so rendering the whole filtered list at once would make the page unusably heavy.
const LOAD_AHEAD = 3; // posts left below the fold when the next batch starts loading

let posts = [];

let sortOrder = "new"; // 'new' | 'old'
let placeholderIcon = "none"; // set once at startup, see rollPlaceholderIcon()
let radioMode = false;
let radioBag = []; // tracks not yet played in the current radio round

let current = null; // { messageId, trackId } | null
let history = [];
let historyPos = -1;

let shownCount = PAGE_SIZE; // how far down the feed we have rendered so far

let pollTimer = null;


// --- persistence of UI preferences (filter/sort/repeat) --------------------------
// Small per-browser display preferences. What you liked lives under its own key.

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.sortOrder) sortOrder = p.sortOrder;
  } catch (e) {
    // corrupt or blocked storage - just fall back to defaults
  }
}

function saveUiPrefs() {
  try {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        sortOrder,
      })
    );
  } catch (e) {
    // storage unavailable - non-critical, ignore
  }
}

// Bandcamp art urls end in a size code, and asking for the right one matters: a feed
// of 30 posts holds a couple of hundred covers, and at the baked _5 that is thirty-odd
// megabytes of 700px jpeg for squares drawn 40px wide. A phone spends the difference
// on decoding, which is what made scrolling crawl.
const ART_ROW = "7"; // 150px, ~9KB - the 40px square in a track row
const ART_PLAYER = "2"; // 350px, ~42KB - the 96px square beside the controls
const ART_BACKDROP = "5"; // 700px - fills the whole player block on a phone
const ART_FULL = "10"; // 1200px - the cover viewer

function coverUrl(url, size) {
  if (!url) return url;
  return url.replace(/_\d+\.(jpe?g|png)$/i, `_${size}.$1`);
}

// --- data loading -------------------------------------------------------------

// One collection, kept in this browser: the tracks you liked. Album likes and
// user-named categories are gone, and their old key is left untouched rather than
// migrated - it held albums and folders, neither of which this means.

// --- where you left off --------------------------------------------------------------
// Android takes the sound away a few minutes after the screen goes dark, and there is
// nothing a page can do about that - bandcamp's own site, in the same browser on the
// same phone, manages one track before it goes quiet. What a page can do is make the
// interruption cost nothing: the track and the second are remembered, and the player
// comes back to them.
//
// It comes back paused, and that is not a preference. When the tab has been thrown out
// of memory the page starts from nothing, and a browser will not let a fresh page make
// noise on its own - nobody asked it to. So the player is put back exactly where it
// stood, and one press carries on.
const RESUME_KEY = "rd_player_resume_v1";
const RESUME_SAVE_EVERY_MS = 5000;
let resumeSavedAt = 0;

function saveResumePoint() {
  if (!current || !isFinite(audio.currentTime)) return;
  try {
    localStorage.setItem(
      RESUME_KEY,
      JSON.stringify({
        messageId: current.messageId,
        trackId: current.trackId,
        at: Math.max(0, Math.floor(audio.currentTime)),
      })
    );
  } catch (e) {
    // storage blocked or full: losing the place is survivable, throwing here is not
  }
}

onAudio("timeupdate", () => {
  const now = Date.now();
  if (now - resumeSavedAt < RESUME_SAVE_EVERY_MS) return;
  resumeSavedAt = now;
  saveResumePoint();
});
onAudio("pause", saveResumePoint);
// The last chance a page gets on a phone: `unload` is not delivered there.
window.addEventListener("pagehide", saveResumePoint);

// Remembered, not restored. Putting the player back on the saved track the moment the
// page opens takes away the thing an empty player is for: the mascot, and whatever it
// has to say today. That greeting is the first thing anybody sees, and a returning
// listener was losing it every time.
//
// So the place is kept in hand and spent on the first press instead. The player opens
// empty, as it always did; play carries on from where the music stopped rather than
// rolling a stranger. Same single press either way - it just lands somewhere better.
let pendingResume = null;

function takeUpResumePoint() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(RESUME_KEY) || "null");
  } catch (e) {
    saved = null;
  }
  if (!saved || !saved.trackId) return;
  // The catalogue is rebuilt every two hours and a post can leave it; and the url in it
  // is today's, not the one that was saved - which is the point of looking the track up
  // rather than keeping its address.
  const track = findTrack(saved.trackId);
  if (!track || !track.stream_url) return;
  pendingResume = saved;
}

function playPendingResume() {
  const saved = pendingResume;
  pendingResume = null;
  if (!saved) return false;
  const track = findTrack(saved.trackId);
  if (!track || !track.stream_url) return false;

  current = { messageId: saved.messageId, trackId: saved.trackId };
  history = [current];
  historyPos = 0;

  const at = Number(saved.at) || 0;
  if (at > 1) {
    const seek = () => {
      audio.removeEventListener("loadedmetadata", seek);
      // A track saved on its last breath starts again rather than ending immediately.
      if (isFinite(audio.duration) && at < audio.duration - 10) audio.currentTime = at;
      syncTransport();
    };
    audio.addEventListener("loadedmetadata", seek);
  }
  audio.src = track.stream_url;
  paintSeek(0);
  startPlayback();
  updateNowPlaying(track);
  highlightCurrentTrack();
  logPlayback("resume:taken", { pos: at });
  return true;
}

const LIKED_KEY = "rd_player_liked_v1";
let likedIds = new Set();

let dataGeneratedAt = 0;
let dataExpiresAt = 0;

function loadUserData() {
  try {
    const raw = localStorage.getItem(LIKED_KEY);
    if (raw) likedIds = new Set(JSON.parse(raw));
  } catch (e) {
    // corrupt or blocked storage - start empty rather than break the player
  }
}

function saveUserData() {
  try {
    localStorage.setItem(LIKED_KEY, JSON.stringify([...likedIds]));
  } catch (e) {
    // storage unavailable - likes just won't survive a reload
  }
}

async function loadPosts({ force = false } = {}) {
  // Let http caching do its job. no-store used to be here to avoid serving expired
  // stream links, but the maths says it cannot happen: the host caches this file for
  // ten minutes while the links inside live for twenty-four hours. What no-store did
  // instead was re-download 1.3 MB on every single visit - which on a slow connection
  // is a blank list for several seconds. `force` is for the recovery path, where the
  // whole point is to get past a copy whose links really have expired.
  const res = await fetch("data/posts.json", force ? { cache: "reload" } : undefined);
  if (!res.ok) throw new Error(`data/posts.json: HTTP ${res.status}`);
  const payload = await res.json();
  dataGeneratedAt = payload.generated_at || 0;
  dataExpiresAt = payload.expires_at || 0;
  posts = payload.posts || [];
}

async function refreshPosts() {
  await loadPosts();
  renderPostList();
  if (current) {
    const track = findTrack(current.trackId);
    if (track) updateNowPlaying(track);
  }
}

// Compilations on bandcamp name their tracks "ARTIST - Title", and we carry the artist
// as a field as well - so printing both says the name twice in a row. When the title
// already opens with it, the field has nothing to add.
function artistLeadsTitle(track) {
  if (!track || !track.artist || !track.title) return false;
  const artist = track.artist.trim().toLowerCase();
  const title = track.title.trim().toLowerCase();
  if (!title.startsWith(artist)) return false;
  // Only when it really is a prefix and not the start of a longer name: "AVXARC" must
  // not swallow the title of a track by "AVXARC & PERCIDAE".
  return /^[\s]*[-–—:|]/.test(title.slice(artist.length));
}

function findTrack(trackId) {
  for (const post of posts) {
    const t = post.tracks.find((tr) => tr.id === trackId);
    if (t) return t;
  }
  return null;
}

// --- active (filtered + sorted) list -------------------------------------------
// This is the single source of truth both for what's rendered as post cards and for
// what next/prev are allowed to play - nothing outside it is ever picked.

// --- the album detour ---------------------------------------------------------------
// Pressing the name of what is playing narrows the feed to the one post that track came
// from. Nothing about playback is interrupted: `current` and the audio element are not
// touched, only what counts as "the list" - which is the same lever "Моя прелесть"
// pulls, so the order, the highlight and the feed all follow for free.
let albumMode = false;
let albumPostId = null;
let orderBefore = null; // where "back" puts things: { precious, radio }

function postOf(messageId) {
  return posts.find((p) => String(p.message_id) === String(messageId)) || null;
}

// Which post a track really came from. Not `current.messageId`: in "Моя прелесть" that
// is the synthetic post the collection is served from, and the album behind the track
// is exactly what this view is for reaching from there.
function postOfTrack(trackId) {
  return posts.find((p) => p.tracks.some((t) => t.id === trackId)) || null;
}

function enterAlbumView() {
  const post = current ? postOfTrack(current.trackId) : null;
  if (!post) return;
  orderBefore = { precious: preciousMode, radio: radioMode };
  stopRadio();
  preciousMode = false;
  albumMode = true;
  albumPostId = post.message_id;
  shownCount = PAGE_SIZE;
  updatePreciousButton();
  updateNowHead();
  renderPostList();
  showPostContext();
  window.scrollTo({ top: 0 });
}

function leaveAlbumView() {
  if (!albumMode) return;
  const back = orderBefore || { precious: false, radio: false };
  albumMode = false;
  albumPostId = null;
  orderBefore = null;
  preciousMode = back.precious;
  // The order goes back to what it was. Not a fresh press of the disco: the colour
  // belongs to the evening, not to this trip out of it.
  radioMode = back.radio;
  shownCount = PAGE_SIZE;
  updateModeButtons();
  updatePreciousButton();
  updateNowHead();
  renderPostList();
  showPostContext();
  window.scrollTo({ top: 0 });
}

// Nothing to open when nothing is playing, and nowhere to go when the feed already
// shows exactly this album.
function updateNowHead() {
  if (!nowHeadEl) return;
  const post = current ? postOfTrack(current.trackId) : null;
  const usable = !!post && !(albumMode && String(post.message_id) === String(albumPostId));
  nowHeadEl.classList.toggle("no-track", !current);
  nowHeadEl.disabled = !usable;
  nowHeadEl.title = usable ? "Открыть альбом целиком" : "";
}

nowHeadEl?.addEventListener("click", () => {
  tally("btn/album");
  enterAlbumView();
});

// --- search --------------------------------------------------------------------------
// The query is one phrase, not a bag of words: typing "hymn of rites" looks for that
// string, and a track called "Hymn of Sorrow" is not a hit. Each field is searched
// whole - post text, and the title, artist and album of every track - rather than one
// joined blob, so a phrase can never match by straddling the seam between two of them.
// The post comes back whole when any field matches: the album is the unit that plays,
// and cutting it down to the matching row would break the order.
let searchPhrase = "";
// Words are the fallback, used only when the phrase is nowhere in the channel. Keeping
// them apart from the phrase is what keeps the highlighting honest: marks show why this
// post matched, so "hymn of rites" never lights up the "of" in a different hymn.
let searchWords = [];
let searchByWords = false;
const loweredFields = new WeakMap();

function postFields(post) {
  let fields = loweredFields.get(post);
  if (fields === undefined) {
    fields = [(post.message_text || "").toLowerCase()];
    for (const t of post.tracks) {
      fields.push(
        (t.title || "").toLowerCase(),
        (t.artist || "").toLowerCase(),
        (t.album || "").toLowerCase(),
      );
    }
    loweredFields.set(post, fields);
  }
  return fields;
}

function hasPhrase(post) {
  return postFields(post).some((field) => field.includes(searchPhrase));
}

// Every word somewhere in the post, each one free to sit in a different field - which is
// the whole point: "trollslayer mirage" is an artist and an album, and nobody ever wrote
// those two next to each other.
function hasAllWords(post) {
  const fields = postFields(post);
  return searchWords.every((word) => fields.some((field) => field.includes(word)));
}

function matchesSearch(post) {
  if (!searchPhrase) return true;
  return searchByWords ? hasAllWords(post) : hasPhrase(post);
}

// Where the query sits inside one piece of text, so the render can mark it. Overlapping
// hits merge, which only happens in word mode - one word inside another.
function matchRanges(text) {
  if (!searchPhrase) return [];
  const needles = searchByWords ? searchWords : [searchPhrase];
  const lower = text.toLowerCase();
  const found = [];
  for (const needle of needles) {
    let at = lower.indexOf(needle);
    while (at !== -1) {
      found.push([at, at + needle.length]);
      at = lower.indexOf(needle, at + needle.length);
    }
  }
  if (found.length < 2) return found;
  found.sort((a, b) => a[0] - b[0]);
  const merged = [found[0]];
  for (const range of found.slice(1)) {
    const last = merged[merged.length - 1];
    if (range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

// Writes `text` into `el`, wrapping whatever the query hit. Replaces textContent at every
// call site that can carry a match, so a card never keeps marks from an older query.
function writeMarked(el, text) {
  const ranges = matchRanges(text);
  if (!ranges.length) {
    el.textContent = text;
    return;
  }
  el.textContent = "";
  let pos = 0;
  for (const [from, to] of ranges) {
    if (from > pos) el.appendChild(document.createTextNode(text.slice(pos, from)));
    el.appendChild(Object.assign(document.createElement("mark"), {
      textContent: text.slice(from, to),
    }));
    pos = to;
  }
  if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
}

function setSearch(raw) {
  // Runs of whitespace collapse so a stray double space still finds the phrase.
  const phrase = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (phrase === searchPhrase) return;
  searchPhrase = phrase;
  searchWords = phrase.split(" ").filter(Boolean);
  // Strict first, relaxed only if strict finds nothing anywhere. A query that exists as
  // a phrase should never be diluted by posts that merely contain its words.
  searchByWords =
    searchWords.length > 1 && phrase !== "" && !posts.some(hasPhrase);
  shownCount = PAGE_SIZE;
  renderPostList();
  window.scrollTo({ top: 0 });
}

// A keystroke is cheap to match and expensive to render, so the render waits for a pause.
let searchTimer = null;
searchEl?.addEventListener("input", () => {
  // Once per visit, on the first keystroke: whether search gets used at all is the
  // question, and counting every debounced pause would answer a different one.
  tallyOnce("search");
  if (searchClearEl) searchClearEl.hidden = !searchEl.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => setSearch(searchEl.value), 120);
});

searchClearEl?.addEventListener("click", () => {
  searchEl.value = "";
  searchClearEl.hidden = true;
  clearTimeout(searchTimer);
  setSearch("");
  searchEl.focus();
});

function computeActiveList() {
  if (albumMode) {
    const post = albumPost();
    return post ? [post] : [];
  }
  if (preciousMode) return [preciousPost()];

  const list = posts.filter(matchesSearch);
  list.sort((a, b) => {
    const da = a.message_date ? new Date(a.message_date).getTime() : 0;
    const db = b.message_date ? new Date(b.message_date).getTime() : 0;
    return sortOrder === "new" ? db - da : da - db;
  });
  return list;
}

// --- my precious --------------------------------------------------------------------
// Liked tracks, shaped as a single post so that next, previous and the disco keep
// working on them without the playback engine knowing this view exists.

let preciousMode = false;

function likedTracks() {
  const out = [];
  posts.forEach((post) =>
    post.tracks.forEach((t) => {
      if (likedIds.has(t.id)) out.push(t);
    })
  );
  return out;
}

function albumPost() {
  return postOf(albumPostId);
}

function preciousPost() {
  return {
    message_id: "__precious__",
    message_date: null,
    message_text: "",
    telegram_url: null,
    tracks: likedTracks(),
  };
}

function toggleTrackLike(track) {
  if (likedIds.has(track.id)) likedIds.delete(track.id);
  else likedIds.add(track.id);
  tally(likedIds.has(track.id) ? "btn/like" : "btn/unlike");
  saveUserData();
  updatePreciousButton();
  updateNowLike();
  if (preciousMode) {
    renderPostList();
    return;
  }
  const btn = postListEl.querySelector(`.like-btn[data-track-id="${track.id}"]`);
  if (btn) setLikeButtonState(btn, likedIds.has(track.id));
}

function updatePreciousButton() {
  if (!preciousBtn) return;
  const count = likedIds.size;
  preciousBtn.classList.toggle("active", preciousMode);
  preciousBtn.setAttribute("aria-pressed", String(preciousMode));
  preciousBtn.title = preciousMode ? "Вернуться к каналу" : "Показать залайканные треки";
  if (preciousCountEl) preciousCountEl.textContent = count ? String(count) : "";
}

function setPreciousMode(on) {
  preciousMode = on;
  shownCount = PAGE_SIZE;
  updatePreciousButton();
  renderPostList();
  window.scrollTo({ top: 0 });
}

preciousBtn?.addEventListener("click", () => {
  tally("btn/precious");
  setPreciousMode(!preciousMode);
});

function flattenActive(active) {
  const flat = [];
  active.forEach((post) => {
    post.tracks.forEach((t) => flat.push({ messageId: post.message_id, trackId: t.id }));
  });
  return flat;
}

function tracksOfPostFromActive(active, messageId) {
  const post = active.find((p) => String(p.message_id) === String(messageId));
  return post ? post.tracks.map((t) => ({ messageId: post.message_id, trackId: t.id })) : [];
}

// --- playback engine ------------------------------------------------------------
// `current` and `history` identify tracks by {messageId, trackId} rather than a flat
// index, so pointers stay valid across re-renders (a like or a rebuild of the data
// rebuilds `posts` but never invalidates existing ids).

function activatePlayback(ref) {
  const track = findTrack(ref.trackId);
  if (!track) return;
  current = ref;
  cancelHandoff();
  audio.src = track.stream_url;
  paintSeek(0);
  startPlayback();
  updateNowPlaying(track);
  highlightCurrentTrack();
}

// Moving the highlight used to rebuild every card on the page - half a second of frozen
// ui after 400 posts, and over a second once the disco had grown the feed to 800. The
// highlight is two class changes; the list has no reason to be touched.
function setRowPlayState(btn, playing) {
  btn.setAttribute("aria-pressed", String(playing));
  btn.setAttribute("aria-label", playing ? "Пауза" : "Играть");
  btn.title = btn.getAttribute("aria-label");
}

// Two lookups rather than a sweep of every row: the feed runs to thousands of them and
// only one can be the playing one.
function syncRowPlayButtons() {
  const lit = postListEl.querySelector('.row-play[aria-pressed="true"]');
  if (lit) setRowPlayState(lit, false);
  if (!current || audio.paused || audio.ended) return;
  const btn = postListEl.querySelector(
    `.track-row[data-track-id="${current.trackId}"] .row-play`,
  );
  if (btn) setRowPlayState(btn, true);
}

function highlightCurrentTrack() {
  const previous = postListEl.querySelector(".track-row.playing");
  if (previous) previous.classList.remove("playing");
  if (!current) return;
  const row = postListEl.querySelector(`.track-row[data-track-id="${current.trackId}"]`);
  if (row) row.classList.add("playing");
  syncRowPlayButtons();
}

function playNewRef(ref) {
  if (!ref) return;
  // A track picked by hand answers a different question than the plan was made for.
  if (!plannedQueue.length || plannedQueue[0].trackId !== ref.trackId) plannedQueue = [];
  history = history.slice(0, historyPos + 1);
  history.push(ref);
  historyPos = history.length - 1;
  activatePlayback(ref);
}

// The bar belongs to whatever is playing, so it stays dead until something is. On a
// first visit its knob sat at the left end of a full-width groove, which reads as a
// handle you could drag - and there was nothing behind it to drag. Same reasoning as
// updateNowLike() right below it.
function updateSeekState() {
  if (seekEl) seekEl.disabled = !current;
}

function updateNowPlaying(track) {
  silenceHail();
  nowTitle.textContent = track.title;
  updateMediaSession(track);
  updateSeekState();
  updateNowLike();
  updateNowHead();
  // Second line carries whose album this is - the track name alone says nothing about
  // where it came from, and that is what the channel is recommending.
  nowArtist.textContent = "";
  const showArtist = track.artist && !artistLeadsTitle(track);
  if (showArtist) {
    nowArtist.appendChild(document.createTextNode(track.artist));
  }
  if (track.album) {
    if (showArtist) {
      nowArtist.appendChild(Object.assign(document.createElement("span"), {
        className: "now-sep",
        textContent: " — ",
      }));
    }
    nowArtist.appendChild(Object.assign(document.createElement("span"), {
      className: "now-album",
      textContent: track.album,
    }));
  }
  // An <img> with src="" resolves to the page itself and can draw a broken-image icon,
  // so drop the attribute entirely and let the css placeholder show through.
  if (track.thumbnail) {
    artwork.style.backgroundImage = `url("${coverUrl(track.thumbnail, ART_PLAYER)}")`;
    artwork.classList.remove("empty");
    artwork.setAttribute("role", "button");
    artwork.setAttribute("tabindex", "0");
    artwork.title = "Показать обложку";
  } else {
    artwork.style.backgroundImage = placeholderIcon;
    artwork.classList.add("empty");
    artwork.removeAttribute("role");
    artwork.removeAttribute("tabindex");
    artwork.removeAttribute("title");
  }
  setCover(coverUrl(track.thumbnail, ART_BACKDROP));
  showPostContext();
}

// The post text is the whole point of the channel - it is where the recommendation
// actually lives. Playing a track without it shows the music but loses the voice.
function showPostContext() {
  if (!postContextEl) return;
  if (albumMode) {
    postContextEl.hidden = true;
    return;
  }
  const post = current ? posts.find((p) => p.message_id === current.messageId) : null;
  if (!post || !post.message_text) {
    postContextEl.hidden = true;
    return;
  }
  postContextTextEl.textContent = post.message_text;
  if (post.telegram_url) {
    postContextLinkEl.href = post.telegram_url;
    postContextLinkEl.hidden = false;
  } else {
    postContextLinkEl.hidden = true;
  }
  // Some of these run long; show a few lines and let it open on a tap.
  postContextEl.classList.remove("expanded");
  postContextEl.hidden = false;
}

postContextEl?.addEventListener("click", (e) => {
  if (e.target.closest("#post-context-link")) {
    tally("out/telegram");
    return;
  }
  postContextEl.classList.toggle("expanded");
});

// On a phone the cover is not a thumbnail beside the controls - it is the backdrop of
// the whole player. Handing css a variable keeps that decision in the stylesheet, so
// the wide layout can go on ignoring it.
function setCover(url) {
  if (!playerEl) return;
  if (url) {
    playerEl.style.setProperty("--cover", `url("${url}")`);
    playerEl.classList.add("has-cover");
  } else {
    playerEl.style.removeProperty("--cover");
    playerEl.classList.remove("has-cover");
  }
}

function allTrackRefs() {
  const refs = [];
  posts.forEach((post) =>
    post.tracks.forEach((t) => refs.push({ messageId: post.message_id, trackId: t.id }))
  );
  return refs;
}

function pickRandomFromChannel() {
  // A bag, not a fresh dice roll every time: hearing the same track twice within an
  // hour while a thousand others go unplayed is exactly what makes "random" feel broken.
  if (!radioBag.length) {
    radioBag = allTrackRefs();
    for (let i = radioBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [radioBag[i], radioBag[j]] = [radioBag[j], radioBag[i]];
    }
  }
  let ref = radioBag.pop();
  // Refilling the bag can put the track that just played back on top of it.
  if (ref && current && ref.trackId === current.trackId && radioBag.length) {
    const next = radioBag.pop();
    radioBag.unshift(ref);
    ref = next;
  }
  return ref || null;
}

// `after` is what the question is asked from - normally whatever is playing, but the
// planner asks it again from the track it has just planned, to see two moves ahead.
function pickNext(after) {
  const from = after || current;
  // The radio ignores the filter on purpose: it plays the channel, not the view.
  if (radioMode) return pickRandomFromChannel();

  const active = computeActiveList();
  const flat = flattenActive(active);
  if (!flat.length) return null;
  if (!from) return flat[0];

  const idx = flat.findIndex((r) => r.trackId === from.trackId);
  if (idx === -1) return flat[0];
  if (idx + 1 < flat.length) return flat[idx + 1];
  // The feed loops back to the top; an album just ends, the way an album does.
  return albumMode ? null : flat[0];
}

// Chosen before it is needed, because choosing is also what says which file to fetch.
// pickNext() cannot simply be called twice: on radio it pops from the shuffled bag, so
// the second call would answer with a different track than the first one fetched.
// Two tracks, not one. One was enough for a seam; it is not enough for a phone whose
// network is taken away for the next ten minutes - the log showed the fetch at the seam
// failing outright (NETWORK_NO_SOURCE) while the track already in the cache started
// instantly. Depth is the only thing that buys time against a line that is simply gone.
// Two was the number for covering a seam. The log showed a run where the network died
// three minutes into the dark and never came back: every fetch after that failed, and
// when the one cached track ran out there was nothing to hand over to. So the queue is
// no longer about the seam - it is about how long the phone can play with no line at
// all. Five tracks is something like twenty minutes of it, and they are fetched while
// the screen is still on and the network still answers.
const PLAN_AHEAD = 5;
let plannedQueue = [];

function planNextTracks() {
  // Stepping back through history needs no plan - those tracks are already in hand.
  if (historyPos < history.length - 1) return plannedQueue;
  while (plannedQueue.length < PLAN_AHEAD) {
    const from = plannedQueue.length ? plannedQueue[plannedQueue.length - 1] : current;
    const ref = pickNext(from);
    if (!ref) break;
    if (plannedQueue.some((r) => r.trackId === ref.trackId)) break;
    plannedQueue.push(ref);
  }
  return plannedQueue;
}

function forgetPlannedNext() {
  plannedQueue = [];
  warmedUrls.clear();
}

function nextTrack() {
  if (historyPos < history.length - 1) {
    historyPos++;
    activatePlayback(history[historyPos]);
    return;
  }
  const ref = plannedQueue.shift() || pickNext();
  if (ref) playNewRef(ref);
}

function prevTrack() {
  if (historyPos > 0) {
    historyPos--;
    activatePlayback(history[historyPos]);
  }
}


// --- cover viewer -------------------------------------------------------------------
// The thumbnail beside the controls is 96px of art that was made to be looked at, so
// clicking it opens the big one, the way the album's own page does.

function bigCoverUrl(url) {
  return coverUrl(url, ART_FULL);
}

function openCover() {
  if (!coverView || !coverViewImg || !current) return;
  const track = findTrack(current.trackId);
  if (!track || !track.thumbnail) return;
  // If the larger size is not there, fall back to the one already on screen.
  coverViewImg.onerror = () => {
    coverViewImg.onerror = null;
    coverViewImg.src = coverUrl(track.thumbnail, ART_BACKDROP);
  };
  coverViewImg.src = bigCoverUrl(track.thumbnail);
  coverViewImg.alt = track.album ? `${track.album} — обложка` : "Обложка альбома";
  coverView.hidden = false;
}

function closeCover() {
  if (coverView) coverView.hidden = true;
}

artwork?.addEventListener("click", () => {
  if (!artwork.classList.contains("empty")) {
    tally("btn/cover");
    openCover();
  }
});
artwork?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (!artwork.classList.contains("empty")) openCover();
  }
});
coverView?.addEventListener("click", closeCover);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCover();
});

// --- transport ---------------------------------------------------------------------
// The browser's own <audio controls> is a white pill that cannot be themed the same way
// twice across browsers, so the element stays as the engine and these drive it.

let seeking = false; // user is dragging: don't fight them with timeupdate

function paintSeek(fraction) {
  const percent = Math.max(0, Math.min(1, fraction || 0)) * 100;
  if (seekEl) {
    seekEl.value = String(Math.round(percent * 10));
    seekEl.style.setProperty("--p", `${percent}%`);
  }
}

function syncTransport() {
  if (!audio.duration || !isFinite(audio.duration)) {
    paintSeek(0);
    return;
  }
  if (!seeking) paintSeek(audio.currentTime / audio.duration);
}

const PLAY_PATH =
  "M106.854 106.002a26.003 26.003 0 0 0-25.64 29.326c16 124 16 117.344 0 241.344a26.003 26.003 0 0 0 35.776 27.332l298-124a26.003 26.003 0 0 0 0-48.008l-298-124a26.003 26.003 0 0 0-10.136-1.994z";
const PAUSE_PATH =
  "M120.16 45A20.162 20.162 0 0 0 100 65.16v381.68A20.162 20.162 0 0 0 120.16 467h65.68A20.162 20.162 0 0 0 206 446.84V65.16A20.162 20.162 0 0 0 185.84 45h-65.68zm206 0A20.162 20.162 0 0 0 306 65.16v381.68A20.162 20.162 0 0 0 326.16 467h65.68A20.162 20.162 0 0 0 412 446.84V65.16A20.162 20.162 0 0 0 391.84 45h-65.68z";

// --- the fire under the plate ------------------------------------------------------
// One <i> per tongue, sized and phased from a deterministic hash rather than Math.random:
// a re-render must not reshuffle the flames, or the fire visibly jumps.
function lightTheFire() {
  const tongues = document.querySelector(".fire-tongues");
  if (!tongues || tongues.childElementCount) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 34; i++) {
    const seed = Math.sin(i * 12.9898) * 43758.5453;
    const f = seed - Math.floor(seed);
    const el = document.createElement("i");
    el.style.setProperty("--fh", `${(24 + f * 74).toFixed(0)}%`);
    el.style.setProperty("--fd", `${(0.42 + f * 0.7).toFixed(2)}s`);
    el.style.setProperty("--fdelay", `${(f * -1.4).toFixed(2)}s`);
    frag.appendChild(el);
  }
  tongues.appendChild(frag);
}

// Paused, the fire settles to embers rather than going out.
function syncFire() {
  if (playerEl) playerEl.classList.toggle("is-paused", audio.paused);
}

function syncPlayButton() {
  if (!playBtn) return;
  const playing = !audio.paused && !audio.ended;
  const path = playBtn.querySelector("path");
  if (path) path.setAttribute("d", playing ? PAUSE_PATH : PLAY_PATH);
  playBtn.title = playing ? "Пауза" : "Играть";
  playBtn.setAttribute("aria-label", playBtn.title);
}

playBtn?.addEventListener("click", () => {
  if (!audio.src) {
    // Nothing chosen yet. If the last visit left off somewhere, carry on from there;
    // otherwise the play button means "start something".
    if (playPendingResume()) {
      tally("btn/play");
      return;
    }
    // Falling through to the disco, which counts the press as its own.
    radioBtn?.click();
    return;
  }
  if (audio.paused) {
    tally("btn/play");
    startPlayback();
  } else {
    tally("btn/pause");
    stopPlayback();
  }
});

seekEl?.addEventListener("input", () => {
  seeking = true;
  const fraction = Number(seekEl.value) / 1000;
  seekEl.style.setProperty("--p", `${fraction * 100}%`);
});

seekEl?.addEventListener("change", () => {
  if (isFinite(audio.duration)) audio.currentTime = (Number(seekEl.value) / 1000) * audio.duration;
  seeking = false;
});

// --- volume -----------------------------------------------------------------------
// The speaker mutes on a click, the way it always has. On a machine with a pointer it
// also opens a column above the strip: click a height to set it, drag it, or roll the
// wheel - the last one only while the cursor is over the column itself, so a roll aimed
// at the page never quietly turns the music down on the way past.
//
// A touch screen gets none of it. There is no hover to open the column with, and the
// only way to offer it would be to steal the tap that mutes.
const canHover = window.matchMedia("(hover: hover)");

let volHideTimer = null;

// The popup hangs off the slot, not off the button it belongs to: the transport pill
// and the player plate are both drawn with a clip-path, and a clip-path cuts its whole
// subtree - inside either one the column came out sawn off at the bevel. Out here it
// has nothing clipping it and nothing laying it out either, so its place has to be
// measured rather than declared.
function positionVolume() {
  if (!volPopEl || !muteBtn || !playerSlot) return;
  const btn = muteBtn.getBoundingClientRect();
  const host = playerSlot.getBoundingClientRect();
  volPopEl.style.left = `${btn.left - host.left + btn.width / 2}px`;
  volPopEl.style.bottom = `${host.bottom - btn.top + 10}px`;
}

function openVolume() {
  if (!volPopEl || !canHover.matches) return;
  clearTimeout(volHideTimer);
  volPopEl.hidden = false;
  // Measured with the popup laid out, and every time: the player moves under the page
  // as the feed grows, and the strip rearranges itself when a cover arrives.
  positionVolume();
}

// A grace period, because the cursor has to cross the gap between the button and the
// popup to reach it, and for those few pixels it is over neither.
function closeVolume() {
  if (!volPopEl) return;
  clearTimeout(volHideTimer);
  volHideTimer = setTimeout(() => {
    // Focus holds the column open only while focus is being *shown*: clicking either
    // the speaker or the slider leaves it focused too, and on that alone the column
    // stayed up long after the cursor had gone. :focus-visible is the browser's own
    // answer to "is this person on the keyboard", which is the only case that needs it.
    const focused = document.activeElement;
    const onTheControl = focused === muteBtn || volPopEl.contains(focused);
    if (focused && onTheControl && focused.matches(":focus-visible")) return;
    // And the pointer holds it open on its own terms - a blur while the cursor is
    // still resting on the column is no reason to pull it out from under it.
    if (muteBtn?.matches(":hover") || volPopEl.matches(":hover")) return;
    volPopEl.hidden = true;
  }, 160);
}

function setVolume(level) {
  const next = Math.min(1, Math.max(0, level));
  audio.volume = next;
  // Dragged to the floor is muted, and raised off it is not: two ways to say the same
  // thing that disagree are worse than either.
  audio.muted = next === 0;
  syncVolume();
}

function syncVolume() {
  const level = audio.muted ? 0 : audio.volume;
  if (volEl) {
    volEl.value = String(Math.round(level * 100));
    volEl.style.setProperty("--p", `${level * 100}%`);
  }
  if (!muteBtn) return;
  muteBtn.textContent = level === 0 ? "🔇" : "🔊";
  muteBtn.title = level === 0 ? "Включить звук" : "Выключить звук";
  muteBtn.setAttribute("aria-label", muteBtn.title);
}

muteBtn?.addEventListener("click", () => {
  tally("btn/mute");
  // Unmuting a player whose level is already nothing would be a click with no sound to
  // show for it, so it comes back at half.
  if (audio.muted && audio.volume === 0) audio.volume = 0.5;
  audio.muted = !audio.muted;
  syncVolume();
});

// Arrows on the speaker itself, so the keyboard never has to walk to the slider: it
// lives outside the player in the markup (nothing else clears the clip-path), which
// puts it after the disco button in the tab order, a strange place to find the volume.
// The column still opens on focus, so the arrows have something to point at.
muteBtn?.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && volPopEl && !volPopEl.hidden) {
    volPopEl.hidden = true;
    return;
  }
  const up = e.key === "ArrowUp" || e.key === "ArrowRight";
  const down = e.key === "ArrowDown" || e.key === "ArrowLeft";
  if (!up && !down) return;
  // Or the page would scroll away under the player on every step.
  e.preventDefault();
  openVolume();
  setVolume(audio.volume + (up ? 0.05 : -0.05));
  tallyOnce("btn/volume-keys");
});

muteBtn?.addEventListener("pointerenter", openVolume);
muteBtn?.addEventListener("pointerleave", closeVolume);
// Reached by keyboard too: the column opens on focus, so the arrows above have
// something to point at while they move it.
muteBtn?.addEventListener("focus", openVolume);
// Tabbing onward puts the column away; the guard above lets a hovering cursor keep it.
muteBtn?.addEventListener("blur", closeVolume);
volPopEl?.addEventListener("pointerenter", () => clearTimeout(volHideTimer));
volPopEl?.addEventListener("pointerleave", closeVolume);
volPopEl?.addEventListener("focusout", closeVolume);

volEl?.addEventListener("input", () => setVolume(Number(volEl.value) / 100));
// Once per grab rather than once per pixel: `input` fires all the way through a drag.
volEl?.addEventListener("change", () => tally("btn/volume"));

// The wheel is bound to the popup, which is the whole of the rule: the cursor can only
// be over it while it is open, so a roll anywhere else scrolls the page as usual.
volPopEl?.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    setVolume(audio.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    tallyOnce("btn/volume-wheel");
  },
  { passive: false }
);

// The strip moves under the column while it is open: a track starting gives the player
// a title line, a cover arriving re-wraps it, a resize re-flows the lot. The column is
// placed by measurement, so it has to be re-measured whenever the plate changes shape -
// otherwise it hangs where the speaker used to be.
function repositionOpenVolume() {
  if (volPopEl && !volPopEl.hidden) positionVolume();
}

if (playerEl && window.ResizeObserver) {
  new ResizeObserver(repositionOpenVolume).observe(playerEl);
}
window.addEventListener("resize", repositionOpenVolume);

// Whatever moves the level - this control, a keyboard, the browser's own media keys -
// the strip says the same thing about it.
onAudio("volumechange", syncVolume);

// A pointer that leaves for a phone-shaped window takes the column with it.
canHover.addEventListener("change", () => {
  if (!canHover.matches && volPopEl) volPopEl.hidden = true;
});

syncVolume();

onAudio("timeupdate", syncTransport);
onAudio("durationchange", syncTransport);
onAudio("loadedmetadata", syncTransport);
onAudio("emptied", syncTransport);
onAudio("play", syncPlayButton);
onAudio("pause", syncPlayButton);
onAudio("ended", syncPlayButton);
onAudio("play", syncFire);
onAudio("pause", syncFire);
onAudio("play", syncRowPlayButtons);
onAudio("pause", syncRowPlayButtons);
onAudio("ended", syncRowPlayButtons);

// The one number that says whether a visit turned into listening: sound actually
// started. Once per visit - a channel played through is still one listener.
onAudio("play", () => tallyOnce("listen"));

onAudio("ended", nextTrack);
// A failed load used to mean "next track", immediately and without limit. With the
// network gone that emptied the queue at ten tracks a second - each one failing the same
// way, each one a fragment of nothing, and the carefully fetched track skipped past in
// the stampede. Three failures in a row are not three bad tracks, they are a line that
// is down, and the answer to that is to wait and ask again for the same track.
let errorStreak = 0;
let lastErrorAt = 0;
let retryTimer = null;

onAudio("playing", () => {
  errorStreak = 0;
});

onAudio("error", async () => {
  if (!current) return;
  const now = Date.now();
  errorStreak = now - lastErrorAt < 20000 ? errorStreak + 1 : 1;
  lastErrorAt = now;
  logPlayback("track:error", { streak: errorStreak });
  if (errorStreak >= 3) {
    tally("error/offline");
    clearTimeout(retryTimer);
    // The same track again, once the line has had time to come back. Not the next one:
    // there is nothing wrong with this one that waiting will not fix.
    retryTimer = setTimeout(() => {
      if (wantsToPlay && current) activatePlayback(current);
    }, 15000);
    return;
  }
  // A link past its 24h expiry fails exactly like a dropped connection, so try one
  // data refresh before writing the track off - the rebuild may already have run.
  if (dataLooksStale() && (await refreshDataAndRetry(current))) return;
  console.warn("Playback error, skipping to next track", current);
  // A link the rebuild failed to keep alive. Counting these is how a rise in dead
  // tracks shows up here instead of only in listeners' silence.
  tally("error/track");
  nextTrack();
});

// --- a black box for the screen-off problem -----------------------------------------
// Silence with the screen off cannot be watched: by the time anyone can look, the page
// has been asleep and whatever it saw is gone. So the player writes a short log of its
// own - what the element did, when, and what state it was in - and keeps it in storage,
// which survives both a frozen tab and a tab thrown out of memory. Opening the site with
// ?debug=1 prints it back.
//
// It answers the question three rounds of guessing could not: a `pause` while hidden
// means the system took the sound away; a `waiting` with the buffer level sitting at the
// playhead means the network was cut and the sound ran out; a log that simply stops, and
// starts again from nothing, means the tab was discarded. This comes out once the
// question is settled.
const LOG_KEY = "rd_player_log_v1";
const LOG_MAX = 140;

function logPlayback(name, extra) {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    const buffered = audio.buffered.length
      ? audio.buffered.end(audio.buffered.length - 1)
      : 0;
    log.push(
      Object.assign(
        {
          at: new Date().toTimeString().slice(0, 8),
          e: name,
          t: +audio.currentTime.toFixed(1),
          // How much sound is on the phone ahead of the needle. This is the number that
          // tells a cut line from a system that pulled the plug.
          ahead: +(buffered - audio.currentTime).toFixed(1),
          paused: audio.paused,
          ready: audio.readyState,
          net: audio.networkState,
          vis: document.visibilityState === "visible" ? "v" : "h",
        },
        extra || {}
      )
    );
    while (log.length > LOG_MAX) log.shift();
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch (e) {
    // storage blocked or full - a diagnostic is never worth breaking playback over
  }
}

[
  "loadstart",
  "play",
  "playing",
  "pause",
  "waiting",
  "stalled",
  "suspend",
  "ended",
  "error",
  "emptied",
].forEach((name) => onAudio(name, () => logPlayback(name)));

document.addEventListener("visibilitychange", () =>
  logPlayback("page:" + document.visibilityState)
);

// Printed plainly, oldest first, because it will be read on a phone with a thumb.
function showPlaybackLog() {
  let log = [];
  try {
    log = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
  } catch (e) {
    log = [];
  }
  const box = document.createElement("pre");
  box.id = "debug-log";
  box.textContent =
    log.map((r) =>
      [r.at, r.e, "t=" + r.t, "ahead=" + r.ahead, r.paused ? "paused" : "playing",
       "ready=" + r.ready, "net=" + r.net, r.vis].join("  ")
    ).join("\n") || "журнал пуст";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.id = "debug-clear";
  clear.textContent = "Очистить журнал";
  clear.addEventListener("click", () => {
    try {
      localStorage.removeItem(LOG_KEY);
    } catch (e) {
      // nothing to do about it, and nothing that matters
    }
    box.textContent = "журнал пуст";
  });
  document.querySelector("main")?.prepend(box, clear);
}

if (new URLSearchParams(location.search).has("debug")) showPlaybackLog();

// --- fetching the next track before it is wanted ------------------------------------
// The difference between this and a music app on the same phone was never the sound: it
// was the seam. At the end of a track the player asked the network for the next one, and
// a phone with the screen off is exactly where that request is slowest - the radio has
// gone to sleep, the tab is nobody's priority. Meanwhile the page falls silent, and a
// silent page is what chrome freezes; frozen, it never starts anything again.
//
// So the seam is where the network must not be. Half a minute before the end the next
// track is chosen and pulled into the cache by a second, muted element that never plays.
// Measured on a desktop, where the network is not even the problem: a warmed track
// started in 26ms against 318 and 819 for cold ones. The point is not the milliseconds -
// it is that the handover no longer needs the radio to wake up.
const WARM_AHEAD_S = 35;

// Fetched, not played into existence. The element that used to do this had to be asked
// whether it was finished, and it has no honest way to answer: chrome fires `suspend`
// once after the first seconds and again at the end, stops a little short of the last
// chunk, and fires `emptied` the moment a new url is handed to it. Three different
// readings of "done", and two of them quietly aborted the previous fetch - which is how
// a track came to be handed over with four seconds of sound behind it and no network
// left to fetch the rest.
//
// A plain request has none of that. Bandcamp sends no CORS headers, so the response is
// opaque and its body cannot be read - which does not matter in the least, because the
// point was never to read it. The browser downloads it and puts it in the cache, and the
// player finds it there. Measured: fetched, then eight seconds later the element started
// that track in 29ms with 191 of its 194 seconds already in hand.
const warmedUrls = new Set();
// Fifteen seconds was right for a hiccup and wrong for what actually happens: the log
// shows a line that went away for four minutes, asked sixteen times, refused sixteen
// times. Each failure pushes the next attempt further out, up to two minutes, and a
// success puts it back to the start.
const WARM_RETRY_BASE_MS = 15000;
const WARM_RETRY_MAX_MS = 120000;
let warmFailures = 0;

function warmNextTrack() {
  if (!current || !isFinite(audio.duration) || audio.duration <= 0) return;
  const left = audio.duration - audio.currentTime;
  if (left < 0) return;
  // Thirty-five seconds before the end is late for a phone: by then the screen has been
  // dark for minutes and android has put the network to sleep for anything running in
  // the background, so the fetch meant to protect the seam runs into the same wall the
  // seam did. The moment the current track is wholly in hand, there is nothing left to
  // compete with and no reason to wait, so the next one is fetched right then - minutes
  // earlier, while the page is still allowed out. The old deadline stays as the fallback
  // for a connection slow enough that the current track never gets that far ahead.
  // "In hand" is not "downloaded whole": chrome buffers a long way ahead and then stops,
  // so a five minute track may never be complete while it plays. A minute of sound
  // already on the phone is enough to say the current track is not competing for the
  // line any more.
  const buffered = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
  const currentTrackIsInHand =
    buffered >= audio.duration - 2 || buffered - audio.currentTime >= 60;
  if (!currentTrackIsInHand && left > WARM_AHEAD_S) return;
  // A listener who asked the phone to spend less data did not ask for this.
  if (navigator.connection && navigator.connection.saveData) return;
  for (const ref of planNextTracks()) {
    const track = findTrack(ref.trackId);
    if (!track || !track.stream_url || warmedUrls.has(track.stream_url)) continue;
    warmedUrls.add(track.stream_url);
    // Only ever a couple of tracks deep, so the set cannot grow into a leak.
    if (warmedUrls.size > PLAN_AHEAD * 3) {
      warmedUrls.delete(warmedUrls.values().next().value);
    }
    const depth = plannedQueue.indexOf(ref) + 1;
    logPlayback("warm:next", { depth: depth });
    fetch(track.stream_url, { mode: "no-cors" })
      .then(() => {
        warmFailures = 0;
        logPlayback("warm:done", { depth: depth });
      })
      .catch(() => {
        // Let it be tried again rather than counting a failure as done - but not at
        // once. timeupdate comes four times a second, and with the network gone that
        // turned one dead track into ten failed requests in two seconds, which the log
        // caught happening. A failure means the line is down; the line will not be back
        // within a quarter of a second.
        warmFailures++;
        const wait = Math.min(WARM_RETRY_BASE_MS * warmFailures, WARM_RETRY_MAX_MS);
        logPlayback("warm:error", { depth: depth, wait: Math.round(wait / 1000) });
        setTimeout(() => warmedUrls.delete(track.stream_url), wait);
      });
    // One per pass; timeupdate comes round again in a quarter of a second and takes the
    // next one, which keeps two downloads from starting in the same breath.
    return;
  }
}

onAudio("timeupdate", warmNextTrack);

// --- the handover ---------------------------------------------------------------------
// Eight tenths of a second of overlap: long enough that there is no silence between the
// two, short enough to fall inside the quiet tail almost every track ends with. The next
// track has been fetched whole by now, so it starts instantly - which is the difference
// between an overlap and a stutter.
// The first version did all of this eight tenths of a second before the end, and the log
// showed why that is not enough: three minutes into deep sleep the page was throttled so
// hard that no timeupdate arrived inside that window at all, the handover never happened
// and the music stopped there.
//
// So it is split in two, and the risky half is moved to where the page is still awake.
// Five seconds out, while the current track is still making sound and the page is still
// in its own right, the next one is started - silently, at zero volume. Starting playback
// is the part a phone can refuse; it is done early, with seconds of slack.
//
// At the seam only the volume moves, and a volume change cannot be refused. It is
// triggered by whichever comes first: the last tick before the end, or the outgoing
// element's own `ended`. That second trigger is the point - `ended` fires even on a page
// too throttled to get a timeupdate.
// How long before the end the next track is started, silently. Five seconds buys slack
// against a throttled page that may not be given a tick inside a narrow window - but a
// second element rolling quietly alongside the first for that long is also the thing the
// phone might object to, and the twenty-four minute run happened at 0.8 with no quiet
// roll at all. So it is adjustable from the address bar while the two are compared:
// ?arm=0.8 is the older behaviour, ?arm=5 the newer, and the choice sticks the way the
// gapless flag does.
const ARM_KEY = "rd_player_arm_v1";
let ARM_AHEAD_S = 5;
try {
  const asked = new URLSearchParams(location.search).get("arm");
  if (asked !== null && isFinite(Number(asked))) {
    ARM_AHEAD_S = Math.min(30, Math.max(0.3, Number(asked)));
    localStorage.setItem(ARM_KEY, String(ARM_AHEAD_S));
  } else {
    const kept = Number(localStorage.getItem(ARM_KEY));
    if (isFinite(kept) && kept > 0) ARM_AHEAD_S = kept;
  }
} catch (e) {
  // storage blocked: the default stands
}
const HANDOVER_AHEAD_S = 0.6;
// The source whose handover has been arranged, so it is only arranged once.
let handedOverFrom = "";
// { incoming, outgoing, ref, track } once the next track is playing silently.
let armed = null;

function cancelHandoff() {
  handedOverFrom = "";
  armed = null;
  const idle = idlePlayer();
  if (idle.currentSrc || !idle.paused) {
    idle.pause();
    idle.removeAttribute("src");
    idle.load();
  }
}

function armHandoff() {
  if (!gapless || armed || !wantsToPlay || audio.paused) return;
  if (!isFinite(audio.duration) || audio.duration <= 0) return;
  if (audio.currentTime < audio.duration - ARM_AHEAD_S) return;
  if (handedOverFrom === audio.currentSrc) return;
  // Walking back through history is not a handover; it is a choice, and rare.
  if (historyPos < history.length - 1) return;

  const ref = planNextTracks()[0];
  if (!ref) return;
  const track = findTrack(ref.trackId);
  if (!track || !track.stream_url) return;

  handedOverFrom = audio.currentSrc;
  const outgoing = audio;
  const incoming = idlePlayer();
  incoming.src = track.stream_url;
  incoming.volume = 0;
  incoming.muted = outgoing.muted;
  logPlayback("handoff:arm", { lead: ARM_AHEAD_S });

  const started = incoming.play();
  if (!started || !started.then) return;
  started
    .then(() => {
      armed = { incoming: incoming, outgoing: outgoing, ref: ref, track: track };
      // The safety net for a page too asleep to be given a timeupdate.
      outgoing.addEventListener("ended", handOver, { once: true });
      logPlayback("handoff:armed");
    })
    .catch(() => {
      // Not a policy refusal, usually: the next track is simply not on the phone,
      // because the fetch for it failed while the line was down - and asking the
      // element to play a file that is not there fails the same way every time. The
      // log caught twenty of these in five seconds. One attempt per track, then; the
      // ordinary path at `ended` is still there to carry on with.
      logPlayback("handoff:nothing-to-play");
    });
}

function handOver() {
  if (!armed) return;
  const { incoming, outgoing, ref, track } = armed;
  if (outgoing !== audio) return;
  armed = null;

  // It has been playing silently for a few seconds, so it is a few seconds in.
  try {
    incoming.currentTime = 0;
  } catch (e) {
    // not seekable for some reason: a few seconds lost beats silence
  }
  incoming.volume = outgoing.volume;
  incoming.muted = outgoing.muted;

  plannedQueue.shift();
  history = history.slice(0, historyPos + 1);
  history.push(ref);
  historyPos = history.length - 1;
  current = ref;
  audio = incoming;
  resetStallWatch();
  logPlayback("handoff:done");
  updateNowPlaying(track);
  highlightCurrentTrack();
}

function handOverIfDue() {
  if (!armed) return;
  if (!isFinite(audio.duration) || audio.duration <= 0) return;
  // On a short lead the arm itself lands inside the handover window, so the two would
  // fire in the same tick; the mark is whichever is nearer the end.
  const mark = Math.min(HANDOVER_AHEAD_S, ARM_AHEAD_S / 2);
  if (audio.currentTime < audio.duration - mark) return;
  handOver();
}

onAudio("timeupdate", armHandoff);
onAudio("timeupdate", handOverIfDue);


// --- keeping the sound alive with the screen off ------------------------------------
// A phone puts a page it cannot see at the mercy of the system: android throttles a
// socket nobody is watching, chrome freezes a tab that has gone quiet, and a fresh
// play() in the background can simply be refused. None of it announces itself - the
// music stops, and the page that would have started the next track is asleep.
//
// Three answers, none of them clever. Say what this page is, so the system treats it as
// a media session rather than a tab that happens to make noise. Keep what the listener
// asked for apart from what the element is doing, so a pause nobody asked for can be
// undone. And watch the clock, because a stalled stream fires no `error` and would
// otherwise wait forever.

// What the listener asked for. `audio.paused` cannot answer this: the background pauses
// us too, and that pause is the one worth fighting.
let wantsToPlay = false;

function startPlayback() {
  wantsToPlay = true;
  forgiveRefusals();
  const started = audio.play();
  if (!started || !started.catch) return;
  started.catch(() => {
    // Refused - almost always because the page is in the background. One retry, and
    // after that the intent is kept: visibilitychange below picks it up when the screen
    // comes back, rather than leaving a player that claims to be playing over silence.
    setTimeout(() => {
      if (wantsToPlay && audio.paused && !audio.ended) audio.play().catch(() => {});
    }, 500);
  });
}

function stopPlayback() {
  wantsToPlay = false;
  // Both: during a handover the other one is already playing, silently, underneath.
  players.forEach((el) => el.pause());
  cancelHandoff();
}

// The lock screen is where a phone plays music from. Without this the controls there
// are generic at best, and - the part that actually matters - chrome has no reason to
// keep the tab alive between one track and the next.
function updateMediaSession(track) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "",
      artist: track.artist || "",
      album: track.album || "",
      // The same 350px cover the player is already showing, so the notification costs
      // no download of its own.
      artwork: track.thumbnail
        ? [{ src: coverUrl(track.thumbnail, ART_PLAYER), sizes: "350x350", type: "image/jpeg" }]
        : [],
    });
  } catch (e) {
    // A browser with a half-built mediaSession: the controls degrade, playback does not
  }
}

// The scrubber on the lock screen, and what tells the system the sound is still moving.
function syncPositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(Math.max(audio.currentTime, 0), audio.duration),
    });
  } catch (e) {
    // a position outside the range mid-seek: the next event sends it again
  }
}

if ("mediaSession" in navigator) {
  const bindMediaKey = (name, fn) => {
    try {
      navigator.mediaSession.setActionHandler(name, fn);
    } catch (e) {
      // an action this browser has never heard of - the others still bind
    }
  };
  bindMediaKey("play", () => startPlayback());
  bindMediaKey("pause", () => stopPlayback());
  bindMediaKey("nexttrack", () => nextTrack());
  bindMediaKey("previoustrack", () => prevTrack());
  onAudio("play", () => {
    navigator.mediaSession.playbackState = "playing";
  });
  onAudio("pause", () => {
    navigator.mediaSession.playbackState = "paused";
  });
  onAudio("durationchange", syncPositionState);
  onAudio("seeked", syncPositionState);
  onAudio("play", syncPositionState);
  onAudio("pause", syncPositionState);
}

// A stream that stops feeding fires no `error`: the element waits, a waiting player
// makes no sound, and a page making no sound is exactly what gets frozen. So the clock
// is watched instead. Eight seconds is slow enough to cost nothing and quick enough
// that a listener hears a hiccup rather than a silence.
const STALL_TICK_MS = 8000;
// Where the clock stood at the previous tick - a mark to compare against, not a high
// water mark. It was a high water mark at first, and that broke every track after the
// first one: track two starts at zero, which is nowhere near where track one finished,
// so the watch read a clock that had not moved and started rescuing a stream that was
// playing perfectly well - a nudge, a re-request you could hear as a stutter, and then
// the track thrown away at twenty-four seconds. A seek backwards did the same thing.
// What matters is that the position *changed*, in either direction.
let clockWasAt = 0;
let stallStrikes = 0;
// How many ticks in a row we have found the player paused without being asked to be.
let pausedTicks = 0;

function resetStallWatch() {
  clockWasAt = audio.currentTime;
  stallStrikes = 0;
}

// Deliberate starts - a thumb, a lock screen button, a track of our own choosing - are
// the only things that wipe the record of being refused. Notably `playing` does not:
// each refused attempt does start the sound for a moment before the system stops it
// again, and counting that as success is what turned the retry into a loop that could
// be heard chopping away at the speaker.
function forgiveRefusals() {
  pausedTicks = 0;
}

// Every automatic attempt goes through here, whichever of them asked - the watch, or a
// page that has just been looked at again. A phone that means to keep us quiet answers
// each one with a fragment of sound, so the floor is what guarantees those fragments can
// never add up to a stutter, however often something decides to try.
const RESUME_FLOOR_MS = 5000;
let lastResumeAt = 0;

function tryResume() {
  const now = Date.now();
  if (now - lastResumeAt < RESUME_FLOOR_MS) return;
  lastResumeAt = now;
  audio.play().catch(() => {});
}

// Every moment the position legitimately jumps: a new track loading, playback picking
// up again, a listener dragging the bar.
onAudio("loadstart", resetStallWatch);
onAudio("playing", resetStallWatch);
onAudio("seeked", resetStallWatch);

function reloadCurrentStream() {
  if (!audio.src) return;
  const at = audio.currentTime;
  const resume = () => {
    audio.removeEventListener("loadedmetadata", resume);
    // Bandcamp serves ranges, so the same stream can be picked up where it died.
    try {
      audio.currentTime = at;
    } catch (e) {
      // no seeking on this response - starting the track over still beats silence
    }
    startPlayback();
  };
  audio.addEventListener("loadedmetadata", resume);
  audio.load();
}

setInterval(() => {
  if (!wantsToPlay || !audio.src || audio.ended) return;
  if (audio.paused) {
    // Paused with nobody asking: the background did it. Ask again - but not on every
    // tick. When a phone has decided to keep us quiet, each attempt buys a fragment of
    // sound before it is stopped again, and a fragment every eight seconds is worse
    // than silence: it is audible, it is nobody's idea of playback, and it tells the
    // listener the player is broken rather than paused. So the gaps double, and after
    // the third refusal the watch stops asking. visibilitychange still picks it up the
    // moment anyone looks at the page again, and the lock screen's own play button is
    // wired to startPlayback().
    pausedTicks++;
    if (pausedTicks === 1 || pausedTicks === 3 || pausedTicks === 7) {
      logPlayback("watch:resume", { try: pausedTicks });
      tryResume();
    }
    return;
  }
  pausedTicks = 0;
  if (Math.abs(audio.currentTime - clockWasAt) > 0.25) {
    clockWasAt = audio.currentTime;
    stallStrikes = 0;
    // Still going a whole tick later: whatever refused us before has let go.
    pausedTicks = 0;
    return;
  }
  // The clock has not moved since the last tick. Nudge it, then re-request the stream
  // from where it died, then give this track up rather than sit in silence.
  stallStrikes++;
  logPlayback("watch:stalled", { strike: stallStrikes });
  if (stallStrikes === 1) {
    audio.play().catch(() => {});
  } else if (stallStrikes === 2) {
    tally("error/stall");
    reloadCurrentStream();
  } else {
    stallStrikes = 0;
    nextTrack();
  }
}, STALL_TICK_MS);

// Coming back to the page is the one moment a frozen tab is certain to be running
// again, so it is also the moment to notice the music stopped while we were away.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!wantsToPlay || !audio.src || audio.ended) return;
  resetStallWatch();
  if (audio.paused) tryResume();
});

prevBtn?.addEventListener("click", () => {
  tally("btn/prev");
  prevTrack();
});
nextBtn?.addEventListener("click", () => {
  tally("btn/next");
  nextTrack();
});

function updateModeButtons() {
  // A stale index.html may not have this button. Losing a control is survivable;
  // throwing here is not, because this runs before anything gets rendered.
  if (!radioBtn) return;

  radioBtn.classList.toggle("active", radioMode);
  radioBtn.title = radioMode
    ? "Боги Хаоса выбирают — нажми, чтобы остановить"
    : "Боги Хаоса определят очередность треков";
}

// A different one of these in the empty artwork slot every visit - the player should
// look like it was waiting for you, not like it failed to load a picture.
// Icons by Lorc, Delapouite and Skoll (game-icons.net), CC BY 3.0.
// Faces, all of them: the empty player is somebody waiting for you to press play,
// and the line beside them (HAILS) is that somebody talking. Icons from
// game-icons.net by Delapouite, Lorc and Cathelineau, CC BY 3.0.
const PLACEHOLDER_ICONS = [
  // vampire-dracula
  "M256 19c-47.103.059-104.37 1.514-134.777 35.078-19.272 22.051-22.113 59.34-22.141 91.55-.013 15.25.89 29.319 1.84 40.03 3.42 2.125 6.765 3.998 10.168 5.508 1.906-6.213 4.188-12.19 6.889-17.853a411.19 411.19 0 0 1-.897-27.668c.004-4.162.11-8.397.309-12.645H128v-18h-9.143a200.21 200.21 0 0 1 2.141-14H144V83h-18.324c2.45-7.015 5.462-12.914 9.101-17.078 30.825-28.62 70.834-28.757 108.229-28.904L256 76l12.994-38.982c36.423.166 84.794 3.054 108.229 28.904 3.639 4.164 6.652 10.063 9.101 17.078H368v18h23.002c.862 4.51 1.573 9.203 2.14 14H384v18h10.61c.197 4.248.304 8.483.308 12.645a411.356 411.356 0 0 1-.897 27.667c2.701 5.664 4.983 11.64 6.89 17.854 3.402-1.51 6.748-3.383 10.167-5.508.95-10.711 1.853-24.78 1.84-40.03-.028-32.21-2.869-69.499-22.14-91.55C352.365 17.425 303.361 18.985 256 19zm-91.682 128.897C132.974 165.035 121 205.545 121 252v48c2.884 29.924 30.052 42.574 48 60.271V444c0 4.935 2.352 9.45 7.75 14.36 20.432 15.936 53.229 24.47 79.21 24.64h.04c28.357-3.426 58.33-5.59 79.395-24.613C340.683 453.505 343 449 343 444v-83.729c18.205-18.5 47.537-34.698 48-60.271v-48c0-46.455-11.974-86.965-43.318-104.104-11.741-6.42-25.102-6.616-40.256-2.98-19.464 5.613-35.334 13.104-51.426 21.147-17.188-7.926-35.068-17.077-51.426-21.147-13.699-3.296-28.23-3.457-40.256 2.98zm-106.84 34.318c1.809 22.782 8.967 56.005 18.95 82.625 5.798 15.461 12.661 28.809 18.986 36.398 3.162 3.795 6.131 6.012 6.967 5.13.835-.883.619-3.576.619-6.368v-48c0-14.72 1.138-29.342 3.768-43.207-9.004-3.482-16.74-8.624-23.76-13.305-8.927-5.95-16.756-11.044-25.53-13.273zm397.043 0c-8.773 2.23-16.602 7.322-25.529 13.273-7.02 4.68-14.756 9.823-23.76 13.305C407.862 222.658 409 237.281 409 252v48c0 2.792-.216 5.485.62 6.367.835.883 3.804-1.334 6.966-5.129 6.325-7.59 13.188-20.937 18.986-36.398 9.983-26.62 17.141-59.842 18.95-82.625zM176 207.27l70.363 70.366-10.32 10.32C238.517 292.391 240 296.565 240 300h-96c0-16 16-48 48-48 1.182 0 2.46.194 3.797.523L176 232.727l-25.637 25.636-12.726-12.726zM192 300c8.837 0 16-7.163 16-16s-7.163-16-16-16-16 7.163-16 16 7.163 16 16 16zm144-92.729 38.363 38.366-12.726 12.726L336 232.727l-19.797 19.796c1.337-.33 2.615-.523 3.797-.523 32 0 48 32 48 48h-96c0-3.435 1.483-7.609 3.957-12.043l-10.32-10.32zM320 300c8.837 0 16-7.163 16-16s-7.163-16-16-16-16 7.163-16 16 7.163 16 16 16zm-203.393 36.496c-28.117 11.146-58.94 25.26-93.828 42.373 39.48 16.026 70 37.572 90.092 61.317 14.463 17.092 23.58 35.612 26.248 53.814h70.611c-16.114-4.813-33.438-11.931-45.091-22.324C156.82 464.566 151 455.065 151 444v-76.002c-12.82-11.535-24.674-19.302-34.393-31.502zm278.786 0c-9.543 12.279-23.267 21.558-34.393 31.502V444c0 11-5.683 20.495-13.395 27.613-14.023 11.575-28.946 17.825-44.95 22.387h70.226c2.667-18.202 11.785-36.722 26.248-53.814 20.092-23.745 50.613-45.29 90.092-61.317-34.889-17.114-65.71-31.227-93.828-42.373zm-165.784 4.467c7.613 4.7 16.541 13.529 26.391 14.037 10.283-2.687 17.928-7.524 26.39-14.037l11.22 14.074C282.997 362.708 267.95 372.778 256 373c-14.83-1.544-26.226-9.059-37.61-17.963zm-31.293 48.625L211.93 403h88.433l13.25-13.342 12.774 12.684L307.855 421H301l-13 39-13-39h-38l-13 39-13-39h-6.447l-18.87-18.588z",
  // witch-face
  "M228.9 19.9c-4.9.43-15.1 4.46-26.5 11.06-25.6 15.53-47.9 32.91-70.1 50.7 8.1-2.06 16.1-4.11 24.7-6.64 26.2-7.79 50.2-15.16 76.7-19.46l-2.8 12.88c-7.5 35.06-24.6 70.56-37.7 103.76 18.2 8.8 43.3 12.9 66.5 12.8 22.3-.1 43.1-4.8 52.8-9.2-4.7-50.2 1.2-101.67-23.9-139.54-14.4-16.7-40.5-17.98-59.7-16.36zm-44.4 125.7c-40.1 3.6-82.3 5.4-117.98 22.9-11.22 5.7-16.88 11.7-18.44 15.6-1.55 3.9-1.19 6.8 4.08 12.5 5.27 5.6 15.87 12.3 31.76 18.4 31.78 12.2 84.28 22.3 157.48 25.8 32 1.6 79.6-2.1 123.6-12.8 43-10.3 82.2-27.9 100.5-50.8-41.4-19.6-94.9-23.7-136.6-27.6.5 12.9 1.2 23.4 2.5 35.3l-4 3.1c-14.3 10.7-39.2 14.8-67.6 15-28.4.1-59.5-4.8-82.7-19-12.8-6.7 3.3-28.5 7.4-38.4zM389 240.3c-3.1.9-6.2 1.7-9.3 2.6 2 4.1 3.1 8.6 3.1 13.2 0 7.4-2.7 13.9-7 19.3 10.3 1.1 20.3 2.2 30.2 3.4-6.2-13.5-12.2-27-17-38.5zm-272.2 3.2C98.34 310.6 63.15 371 24.15 439.6c19.27-9.2 34.68-24.2 47.91-42.1 20.77-29 34.34-60.1 50.14-91.2l16.3 7.7c-17.8 33.3-31.3 65.9-50.61 92.4-18.43 28.1-39.59 55.5-63.16 79.3 6.87-.9 13.71-2 20.52-3.2 27.94-27.9 57.95-55.3 65.45-79.9l17.2 5.3c-7.5 24.5-27.4 45.8-48.43 66.4 11.28-3.4 21.63-7.4 29.73-11.5 15.4-12.5 23.7-28.3 29.1-45.4 7-21.8 8.4-45.6 12.4-65.6l17.7 3.6c-3.6 17.9-5.1 42.8-12.9 67.5-4 12.7-10 25.4-18.8 36.9 13.6 11.2 28.9 21.4 39.6 32.8 11.9-54 13.5-106.6 14-164.4l18 .1c-.3 35.4-1 69.3-4.2 103 6.9 15.7 11.9 28 16.2 39.8l10.6-212.8c-46.2-2.6-84.1-7.8-114.1-14.8zm244.3 3.9c-4.7 1.1-9.5 2-14.2 2.9 2.6 7.1-4.9 13.1-10.1 13.2-5 0-9.3-3-10.6-7.2.1 7.5 7.9 14.8 19.3 14.8 11.5 0 19.3-7.4 19.3-15-.4-3.4-1.8-6.6-3.7-8.7zm-52.9 8.7c-3.8.5-7.6.8-11.3 1.2.6 2.3.9 4.8.9 7.3 0 19.4-18.4 33.4-38.9 33.4-4.1 0-8.1-.6-11.9-1.6l-1.7 35.8c7.2 13.1 12.5 21.7 18.3 27.1 7.7 7 17.5 10.6 39.2 13.4 6.4 1.1 11.4 8.7 12.4 13.9 1 5.2.2 10.4-2.1 15.4-18.4 26.2-48 12.2-71.4 2.1l-.8 16.1c14.7 26.8 27.7 51.5 63 68.1 11.4 4.1 25.3 5.5 37.2.9l-20.7-82.4 6-3.3c18.9-10.6 28.7-24.2 36.9-39.6-25.7-2.8-49-9.6-74-11.2-9.7-.6-16.7-7.1-20.8-14-4.1-7-6.2-14.9-4.7-22.9 1.3-13.6 38.3-10.7 44-10.6l16.6 14.9c-16.5-.4-28.2-.3-42.5 3.9 1.1 4.1 3.8 10.3 8.5 10.8 49.2 3.1 84.3 21.4 136 6.3 16.1-3.7 49.3 15.8 61.5 23.4-2.4-20.6-7.1-41-19.5-54.3-43.9-13.8-89.8-15.1-122.9-21.2-33.2-6.1-37.3-19.3-37.3-32.9zm-30.2 2.5c-3.6.2-7.1.3-10.5.4 2.8 7.1-4.8 13.2-10.1 13.3-3.7 0-7-1.7-8.9-4.2l-.5 9.5c3.1 1.5 6.8 2.4 10.9 2.4 12.5 0 20.9-7.9 20.9-15.4 0-2.1-.6-4.1-1.8-6zM243.7 364l-1 20c11.9 6.7 25.5 11.5 41.6 15.5 6.2.9 14.6-2.2 13.2-9.4-21.2-3-35.3-7.7-46.1-17.6-2.8-2.6-5.3-5.4-7.7-8.5zm154.7.5c-5.3.4-10.5.6-15.5.6-.8 1.5-1.5 3-2.3 4.6-8.4 16.3-19.7 33-39.5 45.8l7.6 30.2c11.7 11.9 23.4 24 35.4 34.5-5.3-15.5-7.2-29.9-7.7-50.5l-.6-23.2 16 16.7c6.9 7.2 19.9 13.6 34.4 17.4 7.9 2.1 16.2 3.4 24.2 4-20.3-24.9-38.7-53.5-52-80.1z",
  // goblin-head
  "M256 33c-8.5 0-21.318 5.745-35.06 16.17-13.743 10.425-28.429 25.055-42.167 40.756-19.597 22.397-37.26 47.053-48.41 64.597l49.582 37.188 49.23 12.307 2.288-6.864 17.074 5.692-14.957 44.873 22.42 56.05 22.42-56.05-14.957-44.873 17.074-5.692 2.287 6.864 49.23-12.307 49.583-37.188c-11.15-17.544-28.813-42.2-48.41-64.597-13.738-15.7-28.424-30.33-42.166-40.756C277.318 38.745 264.5 33 256 33zm-91.49 95.213 76 44-9.02 15.574-76-44zm182.98 0 9.02 15.574-76 44-9.02-15.574zM17.21 146.625c31.804 32.973 63.213 73.408 76.3 111.857 1.59-2.708 3.38-5.333 5.292-7.882 5.009-6.68 11.036-12.972 17.14-19.153-8.95-12.884-11.752-29.088-12.605-42.886-29.308-24.142-53.916-37.693-86.127-41.936zm477.582 0c-32.21 4.243-56.819 17.794-86.127 41.936-.853 13.798-3.654 30.002-12.605 42.886 6.104 6.181 12.131 12.474 17.14 19.153 1.912 2.55 3.703 5.174 5.291 7.882 13.088-38.449 44.497-78.884 76.301-111.857zm-373.645 23.484c-.023.045-.054.1-.078.145.137 16.376 2.007 44.095 13.295 55.383l6.364 6.363-6.364 6.363c-8 8-15.74 15.805-21.164 23.037-4.688 6.251-7.327 11.823-7.965 16.452l81.118 30.418c4.7-6.847 9.904-13.253 15.285-18.633l16.029-16.03-.67 22.659c-.25 8.431-.383 16.131-.232 23.41l30.84 11.564L214.707 249h-50.98l-13.364 13.363-12.726-12.726 11.312-11.313-13.531-57.512zm269.708 0-14.272 10.703-13.531 57.512 11.312 11.313-12.726 12.726L348.273 249h-50.98l-32.897 82.24 30.842-11.566c.15-7.278.018-14.978-.232-23.408l-.672-22.659 16.03 16.03c5.38 5.38 10.584 11.788 15.284 18.634l55.192-20.697 25.926-9.722c-.638-4.63-3.277-10.2-7.965-16.452-5.424-7.232-13.164-15.037-21.164-23.037L371.273 232l6.364-6.363c11.288-11.288 13.158-39.007 13.295-55.383-.024-.045-.055-.1-.078-.145zM157.867 197.65l7.848 33.35H183v-19.975l-10.945-2.736zm196.266 0-14.188 10.64L329 211.024V231h17.285zM201 215.525V231h19.18l3.287-9.857zm110 0-22.467 5.618L291.82 231H311zm-205.791 62.51a16.25 16.25 0 0 0-.117 1.256c7.79 37.424 34.985 88.461 66.066 129.256 15.682 20.582 32.34 38.649 47.582 51.271C233.983 472.441 248 479 256 479c8 0 22.017-6.559 37.26-19.182 15.242-12.622 31.9-30.689 47.582-51.271 31.081-40.795 58.277-91.832 66.066-129.256-.02-.41-.063-.83-.117-1.256l-48.027 72.043L256 435.715l-102.764-85.637zm45.756 36.188 15.799 23.699 2.968 2.474c1.753-5.409 4.259-10.906 7.176-16.445zm210.07 0-25.943 9.728c2.917 5.539 5.423 11.036 7.176 16.445l2.968-2.474zm-162.129 7.73c-1.782 2.76-3.48 5.558-5.006 8.356-4.27 7.83-7.176 15.717-8.328 21.255l19.67 13.114c-4.116-14.232-5.864-28.048-6.336-42.725zm114.188 0c-.472 14.677-2.22 28.493-6.336 42.725l19.67-13.114c-1.152-5.538-4.057-13.425-8.328-21.255-1.527-2.798-3.224-5.596-5.006-8.356zm-19.227 17.457L265 350.236v54.55l7.793-6.495 7.158-14.316c8.04-16.081 12.051-29.95 13.916-44.565zm-75.734.002c1.864 14.614 5.876 28.483 13.916 44.563l7.158 14.316 7.793 6.494v-54.549z",
  // barbute
  "M255.406 17.75C189.313 39.42 124.536 85.124 79.03 150.344c21.238 57.44 32.72 94.314 32.72 131.375 0 36.493-11.52 73.723-32.125 129.655 49.72 36.73 100.08 58.95 150.313 64.938-5.052-60.378-9.83-120.748 1.593-181.125-30.644-3.28-61.384-13.286-92.03-30.72v-71.312c80.67 42.255 158.908 41.547 242.063 0v71.313c-30.06 14.376-60.192 24.722-90.25 29.28 8.684 60.46 7.723 120.915 2.03 181.375 46.386-7.335 92.89-28.824 139.032-64.312-33.966-112.954-34.03-145.933.594-260.47C391.162 84.844 317.924 39.89 255.405 17.75zm-75.125 212c-11.16-.13-19.646 3.174-21.25 9.156-2.33 8.7 10.778 19.76 29.282 24.72 18.505 4.957 35.388 1.92 37.72-6.782 2.33-8.7-10.775-19.76-29.282-24.72-5.783-1.55-11.396-2.315-16.47-2.374zm160.69 0c-5.074.06-10.687.825-16.47 2.375-18.507 4.96-31.613 16.018-29.28 24.72 2.33 8.7 19.213 11.738 37.717 6.78 18.505-4.958 31.613-16.018 29.282-24.72-1.604-5.98-10.09-9.286-21.25-9.155z",
  // pumpkin-lantern
  "M252.5 21.156c-16.98.22-33.708 4.552-49.72 13.313l-4.593 2.5-.25 5.218c-.71 14.473-.49 33.985 3.063 52.968-45.775 2.55-84.144 20.94-113.094 48.625C48.312 181.647 25.87 236.18 22.47 291c-3.402 54.82 12.32 110.396 50.5 149.563 38.01 38.994 98.086 60.67 179.843 49.437 91.743 8.826 154.664-13.978 192-53.906 37.494-40.1 48.374-96.148 39.968-150.563-8.404-54.413-35.9-107.795-76.905-144.53-30.753-27.55-69.526-45.58-112.813-46.688-6.366-.163-12.823.077-19.375.688 1.99-18.702 8.107-36.836 18.282-54.75l5.717-10.03-11-3.5c-10.928-3.484-21.894-5.354-32.78-5.564a107.485 107.485 0 0 0-3.407 0zm.594 18.5a81.54 81.54 0 0 1 2.47.032c5.472.13 11.025.846 16.655 2.03-14.398 29.89-19.03 61.625-13.314 94.282-8.162 1.28-13.987-.206-18.844-3.25-6.315-3.958-11.562-11.503-15.406-21.594-7.026-18.446-8.592-43.953-8.125-62.625 12.073-5.82 24.17-8.79 36.564-8.874zm36.812 73.22c1.623-.017 3.238-.007 4.844.03 26.418.605 50.73 8.318 72.438 21.188-6.758 10.28-19.022 19.106-35.563 25.78-21.344 8.614-49.05 13.303-77.063 13.5-28.012.2-56.365-4.08-79.093-12.5-18.705-6.928-33.23-16.595-41.532-28.093 20.665-11.46 44.554-18.416 71.687-19.28a111.444 111.444 0 0 0 1.563 4.313c4.727 12.41 11.81 23.756 22.968 30.75 11.158 6.993 25.952 8.577 42.406 3.343l8.22-2.625-1.97-8.405c-2.15-9.21-3.372-18.236-3.718-27.125 5.003-.54 9.945-.827 14.812-.875zm-171.78 29.968c11.135 16.145 29.513 27.66 50.843 35.562 25.507 9.45 55.785 13.868 85.75 13.656 29.962-.21 59.59-5.03 83.905-14.843 18.664-7.533 34.624-18.224 44.125-32.69a188.04 188.04 0 0 1 12.656 10.376c37.356 33.467 63.165 83.352 70.906 133.47 7.742 50.116-2.365 99.87-35.156 134.937-32.79 35.067-89.1 56.757-177.656 48l-1.125-.094-1.094.155c-77.94 10.96-131.157-9.192-164.936-43.844-33.78-34.65-48.35-84.885-45.22-135.374 3.133-50.488 24.058-100.77 59.688-134.844 5.438-5.2 11.21-10.05 17.313-14.468zm55.06 59.28c-17.525 19.402-30.988 41.834-41.03 66.845l78.563 2.936c-9.76-26.926-22.16-50.34-37.532-69.78zm168.033 1.407c-19.43 0-35.19 15.756-35.19 35.19 0 19.43 15.76 35.186 35.19 35.186s35.155-15.755 35.155-35.187c0-19.436-15.726-35.19-35.156-35.19zM62.31 321.876c10.71 51.276 48.785 85.54 97.157 103.875L164.5 400l40 7.688-5.656 29.125c20.105 3.882 41.064 5.448 61.937 4.812l-3.25-29.22 47.283-5.25 3.25 29.158c24.27-4.824 47.335-12.838 67.562-23.875l-11.094-29.375 38.876-17.625 8.03 21.25c18.428-17.576 31.46-39.23 36.408-64.813-31.205 9.386-64.876 16.156-99.656 20.375l3.656 26.844L303.97 377l-4.19-30.563a777.22 777.22 0 0 1-43.81 1.125l-1.814 33.813-48.312-3.47 1.72-31.936c-14.844-.943-29.6-2.267-44.126-4.033l-8.844 35.25-40.563-6.78 8.657-34.626c-20.89-3.765-41.127-8.4-60.374-13.905z",
  // metal-golem-head
  "M256 33.85 168.2 63.1l-6.6 52.9 94.4 27 94.4-27-6.6-52.9zm-54 60.51a10 9.999 0 0 1 10 10.04 10 9.999 0 0 1-10 10 10 9.999 0 0 1-10-10 10 9.999 0 0 1 10-10.04zm108 0a10 9.999 0 0 1 10 10.04 10 9.999 0 0 1-10 10 10 9.999 0 0 1-10-10 10 9.999 0 0 1 10-10.04zM103 104.4v64h18v-23h18.8l2.1-16.2-.4-.1.5-1.7h-21v-23zm153 0a10 9.999 0 0 1 10 10 10 9.999 0 0 1-10 10 10 9.999 0 0 1-10-10 10 9.999 0 0 1 10-10zm135 0v23h-21l.5 1.7-.4.1 2.1 16.2H391v23h18v-64zm-231.7 29.8-6.5 52.2-16 48.1 20.1 26.8 16.8-50.3 48.7 81.2 24.6-61.5v-71.5zm193.4 0-87.7 25v71.5l24.6 61.5 48.7-81.2 16.8 50.3 20.1-26.8-16-48.1zm-178.7 22 57.2 23.7-3.3 17.3-65.3 1 8.7-32.2zm164 0 11.4 42-65.3-1-3.3-17.3 47.8-19.8zm-221.9 80.7-9.1 36.5 43 8.6zm279.8 0L362 282l43-8.6zm-217.6 16.9-10.5 31.8 32.6 6.5 1.1.2zm155.4 0-23.2 38.5 15-3 18.7-3.7zm-77.7 2.8-17.3 43.1 17.3 3.5 17.3-3.5zm-149 35.2 28.8 172.5L247 478.2V376.4h18v101.8l111.2-13.9L405 291.8l-149 29.8zm111 80.6a10 9.999 0 0 1 10 10 10 9.999 0 0 1-10 10 10 9.999 0 0 1-10-10 10 9.999 0 0 1 10-10zm76 0a10 9.999 0 0 1 10 10 10 9.999 0 0 1-10 10 10 9.999 0 0 1-10-10 10 9.999 0 0 1 10-10zm-76 64a10 9.999 0 0 1 10 10 10 9.999 0 0 1-10 10 10 9.999 0 0 1-10-10 10 9.999 0 0 1 10-10zm76 0a10 9.999 0 0 1 10 10 10 9.999 0 0 1-10 10 10 9.999 0 0 1-10-10 10 9.999 0 0 1 10-10z",
  // mecha-mask
  "m229.096 33-43.082 71.803 30.744 76.857 15.726 110.098L243.73 303h24.542l11.245-11.242 15.726-110.098 30.744-76.857L282.904 33H265v151h-18V33h-17.904zm-80.77 16-46.242 57.799 71.719 15.937-7.817-19.539L198.504 49h-50.178zm165.17 0 32.518 54.197-7.815 19.54 71.715-15.938L363.674 49h-50.178zM60.262 115.943l11.353 45.41 131.576 52.631-3.949-27.644-17.346-43.365-121.634-27.032zm391.476 0-121.634 27.032-17.346 43.365-3.95 27.644 131.577-52.63 11.353-45.41zM89 187.693v73.05l62 74.4v-57.268l16.055-32.111L112 232v-35.107l-23-9.2zm334 0-23 9.2V232l-55.055 13.764L361 277.875v57.268l62-74.4v-73.05zm-227.986 42.405L169 282.125V390l52-39h70l52 39V282.125l-26.014-52.027-11.115 4.445-9.387 65.7L275.73 321h-39.46l-20.755-20.758-9.387-65.699-11.115-4.445zM134.826 343.85l-13.072 91.507L167 462.504V435.5l70-52.5h38l70 52.5v27.004l45.246-27.147-13.074-91.505L361 363.258V426l-76-57h-58l-76 57v-62.742l-16.174-19.408zM243 401l-58 43.5v28.805l9.492 5.695H247v-23h18v23h52.508l9.492-5.695V444.5L269 401h-26z",
  // viking-head
  "M221.826 18.962c-19.664 21.772-25.274 46.806-22.947 72.576 3.014 33.377 20.582 67.653 40.846 92.127 4.424 4.514 8.193 5.55 11.937 5.31 3.796-.243 7.888-2.242 11.152-5.568 3.265-3.325 5.503-7.832 5.97-12.129.465-4.297-.458-8.336-4.15-12.53l-.517-.587-.406-.668c-21.633-35.426-49.926-85.506-41.885-138.531zm132.778 1.568c6.142 37.121-4.756 72.244-17.704 102.87 8.674 6.972 17.556 15.36 26.391 24.617 7.675-18.27 13.365-37.7 14.605-56.641 1.657-25.302-3.92-49.463-23.292-70.846zm-60.814 100.4a8.042 8.042 0 0 0-.846.037c-5.5.545-14.101 4.158-23.695 10.592 3.17 5.542 6.37 10.887 9.5 16.02 6.426 7.696 8.854 17.099 7.928 25.642-.956 8.81-5.083 16.749-11.02 22.797-5.936 6.047-13.88 10.347-22.844 10.921-8.964.575-18.634-3.056-26.23-10.939l-.229-.236-.209-.252a215.324 215.324 0 0 1-8.798-11.342c-8.841 12.094-16.95 25.171-23.633 38.486 5.262-.424 9.766-.787 16.596-1.342 22.344-1.815 51.953-4.235 81.502-6.656 48.432-3.968 80.82-6.632 96.662-7.935-10.957-15.193-23.235-30.317-35.579-43.52-12.34-13.198-24.754-24.498-35.595-32.025-10.164-7.057-18.988-10.223-23.51-10.248zm-15.041 26.648c-.2-.24-.393-.484-.602-.72l.924 1.255c-.106-.174-.215-.36-.322-.535zm121.473 76.238c-9.5.782-53.357 4.391-106.94 8.782a130402.1 130402.1 0 0 1-81.515 6.658c-10.86.882-19.805 1.605-26.4 2.133-2.027 5.208-3.806 10.4-5.26 15.527l229.312-18.27a365.01 365.01 0 0 0-9.197-14.83zM286.01 265.09l-108.26 9.846c-26.291 43.058-53.372 78.8-114.39 103.964-.11 10.888 2.099 20.097 6.415 28.391 18.806-3.292 36.31-7.625 53.022-12.592-12.337 10.828-25.118 21.275-39.545 30.31 4.176 4.108 8.956 8.039 14.252 11.837 26.834-13.3 63.102-33.4 78.44-43.787L115.53 448.24c5.358 3.043 11.009 6.022 16.89 8.973 10.35-4.602 19.84-9.775 27.28-16.315-2.324 8.627-5.872 16.765-10.117 24.623a2653.953 2653.953 0 0 0 16.562 7.702c23.648-15.875 48.755-35.308 65.565-49.21-8.56 16.993-25.492 40.548-42.055 60.208 5.967 2.852 11.95 5.775 17.903 8.816 27.519-23.53 43.374-38.665 61.035-48.904 16.343-9.476 34.873-14.553 64.69-19.356-31.404-51.16-50.924-97.843-47.274-159.69zm120.635 2.543a3888.277 3888.277 0 0 1-19.096 7.38 1685.056 1685.056 0 0 1-16.588 6.282c-.9.333-1.502.543-2.309.838 4.157 6.86 7.53 14.009 9.373 21.107.146.562.268 1.13.387 1.696l17.42.347c17.241.343 25.144-2.16 31.082-5.6-4.816-10.051-12.468-21.618-20.27-32.05zM303.498 278.5c-.118 12.746.828 24.747 2.762 36.275 1.76 1.73 4.288 3.736 7.492 5.72 9.65 5.972 24.873 11.841 40.826 16.095.854.228 1.718.433 2.576.652.362-1.332.724-2.703 1.075-4.14 2.306-9.448 3.49-21.04 2.375-25.336-1.878-7.226-7.762-17.516-14.608-26.791l-42.498-2.475zm75.213 28.053c1.72 10.365-.675 21.305-2.996 30.816l-.049.192c5.442-4.88 10.576-9.54 15.602-14.082l-12.557-16.926zm38.424 18.12c-20.834 18.034-48.387 46.302-81.668 68.51a466.119 466.119 0 0 0 4.654 8.221 209.86 209.86 0 0 0 23.117-5.656c28.793-8.836 55.15-24.122 68.121-42.312-.15-6.117-1.358-13.003-3.988-18.383-2.396-4.902-5.48-8.387-10.236-10.38zm-104.881 15.509c3.79 12.414 8.748 24.52 14.719 36.73 9.808-6.722 19.25-14.074 28.26-21.588a276.096 276.096 0 0 1-5.292-1.342c-13.64-3.636-26.74-8.249-37.687-13.8zm112.975 45.023c-16.015 12.276-36.042 21.41-56.71 27.752a242.181 242.181 0 0 1-18.496 4.887 882.802 882.802 0 0 0 5.559 8.845l7.512 11.774-13.826 1.976c-15.243 2.178-27.173 4.222-37.07 6.481 4.857 7.794 9.074 15.704 14.023 22.088 5.921 7.638 12.317 13.041 23.084 15.191 7.709 1.54 15.027 2.661 21.955 3.426-10.372-17.474-18.81-33.506-16.694-33.93 10.464 12.5 21.627 24.415 34.223 35.137 6.03.142 11.66-.029 16.875-.473-6.549-10.698-11.091-22.04-3.34-36.771.809 6.527 12.803 20.592 24.883 32.752 10.675-3.387 17.581-8.31 21.438-13.42-1.967-6.603-3.248-12.754-5.022-17.906-2.213-6.426-5.082-11.745-12.443-17.526l-4.088-3.21.738-5.147c1.91-13.306.04-27.297-2.601-41.926z",
  // wizard-face
  "M256.3 19.42C204 57.2 177.2 111 152.5 160.7c43.4-24.6 101.7-32.9 126.9-28.7-63.8 10.6-108 25.8-144.4 64.3-2.2 4.5-4.1 8.3-6.4 13.1 115.4-27.8 134.4-27 250.9-.7C368 158.6 343 126.6 304 65.83 345.9 118.4 428.1 208.1 424.3 190.6 401.4 85.73 324.2 23.49 256.3 19.42zM88 231.3c-31 7.4-53.9 17.5-62.8 26.7.9 11.7 6.7 22.1 17.5 32 11.8 10.8 29.6 20.4 51.3 28.1 2.69.9 5.39 1.8 8.1 2.7-8.4-11-11.2-26.3-13-41.1 0-15.4-3-33.5-1.1-48.4zm336 0c2.2 16.2.6 34.5-1.1 48.4-1.8 14.8-4.6 30.1-13 41.1 20.2-7 44.6-17.6 59.4-30.8 10.8-9.9 16.6-20.3 17.5-32-8.9-9.2-31.7-19.3-62.8-26.7zm-274.4.3-7 14h98.8l-7-14zm128 0-7 14h98.8l-7-14zM119 241c-4.7 1.3-9.4 2.6-14 4.1 1 19.9.6 47.6 11.6 64.5h2.4zm274 0v68.6h2.4c10.5-20.7 11.3-41.8 11.6-64.5-4.6-1.5-9.3-2.8-14-4.1zm-255.9 22.6c-.3 18.8 2 39.5 6.2 55.7 21.1-14.1 41.9-25.7 64.7-25.7 3.2 0 6.4.2 9.4.4l5.2-15.7c-5.6 5.7-12.9 8.9-23.2 8.5-25.2-.8-33.9-11.1-37.5-23.2zm109.4 0-12.4 37.2 21.9 27.4 21.9-27.4-12.4-37.2zm103.6 0c-3.6 12.1-12.3 22.4-37.5 23.2-10.3.4-17.6-2.8-23.2-8.5l5.2 15.7c3.1-.3 6.3-.4 9.4-.4 22.8 0 43.6 11.6 64.7 25.7 4.4-20.1 6.8-37.6 6.2-55.7zm-142.1 48c-20 0-43 14.5-68.9 32.4-19.2 13.3-39.9 28.1-63.3 38.4 28.6 6.1 65.8 4.8 98.2-2.6 21.3-4.8 40.5-12.1 53.7-20.5 8.5-5.5 14.1-11.1 17-16.4l-24.2-30.3c-3.7-.6-7.9-1-12.5-1zm96 0c-4.6 0-8.8.4-12.5 1l-24.2 30.3c2.9 5.3 8.5 10.9 17 16.4 13.2 8.4 32.4 15.7 53.7 20.5 32.4 7.4 69.6 8.7 98.2 2.6-23.4-10.3-44.1-25.1-63.3-38.4-25.9-17.9-48.9-32.4-68.9-32.4zm-48 46.7c-4.6 5.7-10.6 10.8-17.4 15.3h34.8c-6.8-4.5-12.8-9.6-17.4-15.3zm-56.7 33.3c-6.9 2.2-14 4.1-21.3 5.8-9.5 2.2-19.2 3.9-28.9 5.1 6.1 19.6 14.1 39.5 23 58.2l.1.2c4.3-6.7 9.4-13.1 13.5-19.8-2.4 13.9-3.3 27.9-2.3 41.8 1.7 3.3 3.5 6.5 5.3 9.7h134.6c3.6-6.3 7-12.7 10.3-19.2 5.4-21.9 3.9-42.8 5.4-64.2 3.1 11.5 6.1 23 8.5 34.7 5.8-13.6 11.1-27.6 15.4-41.4-9.7-1.2-19.4-2.9-28.9-5.1-7.3-1.7-14.4-3.6-21.3-5.8z",
  // woman-elf-face
  "M256 41c-28.25 0-58.36 18.25-81.166 44.857a170.359 170.359 0 0 0-8.947 11.403L208 69.184l23.127 15.418c.506-6.936 2.568-13.312 6.07-18.565C241.265 59.937 247.934 55 256 55s14.735 4.936 18.803 11.037c3.502 5.253 5.564 11.63 6.07 18.565L304 69.184l42.113 28.076a170.942 170.942 0 0 0-8.947-11.403C314.36 59.25 284.25 41 256 41zm0 32c-.77 0-2.103.436-3.826 3.02C250.45 78.608 249 82.995 249 88c0 3.83.85 7.29 2.02 9.865l4.98 3.32 4.98-3.32C262.15 95.29 263 91.83 263 88c0-5.006-1.45-9.393-3.174-11.98C258.103 73.437 256.77 73 256 73zm-48 17.816-28.623 19.08 5.336 1.067c16.922 2.09 36.528 3.426 56.605 3.867a27.798 27.798 0 0 1-3.7-4.268L208 90.817zm96 0-29.617 19.747a27.9 27.9 0 0 1-3.7 4.267c20.077-.442 39.685-1.777 56.608-3.867l5.333-1.067L304 90.816zM32 112c33.318 33.318 58.914 89.742 71.463 126.506 3.176-25.792 7.433-52.057 12.54-74.658a520.581 520.581 0 0 1 3.585-14.922C98.66 132.53 44.818 112 32 112zm448 0c-12.818 0-66.66 20.53-87.588 36.926a518.123 518.123 0 0 1 3.584 14.922c5.108 22.6 9.365 48.866 12.54 74.658C421.087 201.742 446.683 145.318 480 112zm-331.47 10.086c-4.642 8.756-10.375 25.398-14.97 45.73-5.475 24.23-10.06 53.44-13.257 81.444-2.72 23.812-4.36 46.505-4.832 64.775 6.863-23.28 15.328-51.522 26.116-79.943 14.948-39.38 33.48-78.513 59.758-101.444l-52.813-10.562zm214.94 0-52.814 10.562c26.277 22.93 44.81 62.063 59.758 101.444 10.788 28.42 19.253 56.664 26.115 79.943-.474-18.27-2.114-40.963-4.833-64.775-3.197-28.003-7.782-57.213-13.258-81.444-4.595-20.332-10.328-36.974-14.97-45.73zm-128.755 10.62-6.69 3.345c-6.37 3.187-12.575 8.02-18.574 14.118 6.667.82 12.99 2.112 18.59 3.863 8.714 2.728 16.785 5.412 20.364 14.75l-16.808 6.44c.716 1.868-2.263-1.923-8.932-4.01-6.67-2.085-15.925-3.606-25.332-3.99-.636-.025-1.273-.033-1.91-.048-3.23 4.555-6.38 9.44-9.442 14.596 4.823-1.175 9.422-1.768 14.02-1.768 12 0 24 4 40 12 0 16-16 32-32 32-9.86 0-25.784-6.078-36.563-14.484-4.653 9.97-9.01 20.393-13.023 30.964a688.828 688.828 0 0 0-6.662 18.38c9.174 24.796 21.778 46.163 35.352 63.615 13.475 17.326 27.913 30.755 40.576 39.666C240.342 371.05 251.75 375 256 375s15.658-3.95 28.32-12.86c12.663-8.91 27.1-22.34 40.576-39.665 13.574-17.452 26.178-38.82 35.352-63.614a688.828 688.828 0 0 0-6.662-18.38c-4.013-10.57-8.37-20.995-13.024-30.964C329.784 217.922 313.86 224 304 224c-16 0-32-16-32-32 16-8 28-12 40-12 4.598 0 9.197.593 14.02 1.768-3.043-5.124-6.173-9.98-9.383-14.512-9.19.424-18.187 1.915-24.707 3.955-6.67 2.087-9.648 5.878-8.932 4.01l-16.81-6.44c3.58-9.338 11.653-12.022 20.37-14.75 4.95-1.548 10.476-2.728 16.296-3.55-6.093-6.248-12.4-11.19-18.88-14.43l-6.69-3.345a765.262 765.262 0 0 1-42.569 0zM200 192a8 8 0 0 0-8 8 8 8 0 0 0 8 8 8 8 0 0 0 8-8 8 8 0 0 0-8-8zm111.648 0a8 8 0 0 0-8 8 8 8 0 0 0 8 8 8 8 0 0 0 8-8 8 8 0 0 0-8-8zM240 256l16 4.098L272 256c0 16-16 16-16 16s-16 0-16-16zm-96.836 28.87c-4.49 14.25-8.274 27.123-11.822 39.16-9.37 62.528-29.578 99.06-52.65 146.353 4.716-.48 9.643-1.316 14.462-2.922 10.293-3.43 19.87-9.632 26.795-23.485l8.05-16.1 8.05 16.1c7.835 15.668 12.134 21.143 14.272 22.773 1.07.815 1.84 1.144 3.942 1.793.25.08.683.214.984.308 12.907-29.755 25.753-81.982 27.535-123.414a244.734 244.734 0 0 1-9.887-11.91c-10.863-13.966-21.126-30.27-29.732-48.655zm225.672 0c-8.606 18.385-18.87 34.688-29.732 48.655a246.18 246.18 0 0 1-9.887 11.91c1.824 42.395 15.232 96.096 28.435 125.454.942-.053 1.702-.12 2.155-.21 1.098-.223.9-.08 1.836-1.022 1.873-1.886 6.306-9.683 14.306-25.683l8.05-16.1 8.05 16.1c6.927 13.853 16.503 20.055 26.796 23.486 5.303 1.77 10.72 2.63 15.857 3.073-17.65-45.806-38.75-79.5-50.51-134.562-4.353-14.547-9.39-32.163-15.357-51.1zM240 288s16 0 16 6.693C256 288 272 288 272 288c16 0 32 16 48 16 0 0-28.9 29.78-48 32-5.653.657-16-5.96-16-5.96s-10.347 6.617-16 5.96c-19.1-2.22-48-32-48-32 16 0 32.012-15.997 48-16zm-40.482 74.475c-.435 4.7-.954 9.44-1.58 14.207l1.55 2.326 25.91 38.865 24.24-24.236 1.048-1.05c-10.23-1.496-21.165-7.142-33.366-15.728-5.783-4.07-11.77-8.882-17.802-14.385zm112.964 0c-6.033 5.503-12.02 10.314-17.802 14.384-12.2 8.585-23.134 14.23-33.364 15.728l25.286 25.285 25.91-38.865 1.55-2.326a373.623 373.623 0 0 1-1.58-14.207zm-118.82 40.242c-4.95 25.17-12.022 49.39-19.78 68.283h70.358l-28.166-35.072-22.412-33.21zm124.676 0-22.412 33.21L267.76 471h70.36c-7.76-18.893-14.83-43.113-19.782-68.283zM256 412.727l-19.88 19.882L256 456.942l19.88-24.334L256 412.726z",
  // overlord-helm
  "M183.188 20.107c-19.58 65.304-41.643 129.72-30.362 186.127l.352 1.766-16.03 80.148 15.366 92.19L234.17 488.36l12.03-83.46L224 416c-16-32-16-64 0-80l-48-16v-64c10.394 10.394 34.29 27.534 54.146 38.273l-15.564-54.478.69-2.072-31.51-9.002-.575-208.613zM329 22.81v205.694l-32.27 9.22.688 2.07-15.564 54.48C301.71 283.533 325.606 266.393 336 256v64l-48 16c16 16 16 48 0 80l-22.21-11.104 12.048 84.32 81.644-108.86 15.37-92.208L358.822 208l.352-1.766C370.278 150.712 348.196 87.226 329 22.81zm-73 49.75-7 56v64.9l-15.582 46.745L256 319.238l22.582-79.033L263 193.46v-64.9l-7-56zm25 110.89v7.09l10.03 30.09 19.97-5.704v-17.322c-12.287-6.115-21.97-10.802-30-14.153zm-50 .005c-7.888 3.29-17.36 7.866-29.324 13.815l.05 17.863 19.243 5.498L231 190.54v-7.085zM192 288v16l32 16-32-32zm128 0-32 32 32-16v-16zM25.97 372.31c-4.88 23.452-7.363 47.226-4 72.872 10.904-5.418 22.286-8.96 33.968-10.907-12.438-17.27-22.396-38.742-29.97-61.966zm460.01 0c-7.575 23.223-17.532 44.695-29.97 61.965 11.68 1.947 23.063 5.49 33.97 10.907 3.36-25.646.877-49.42-4-72.873zm-396.01 9.833c-3.055 14.682-5.173 29.488-5.51 44.8 5.497-4.264 11.312-8.804 18.14-12.713-4.768-10.11-8.98-20.89-12.63-32.087zm332.01 0c-3.653 11.196-7.865 21.977-12.632 32.087 6.828 3.91 12.642 8.45 18.138 12.713-.336-15.312-2.453-30.118-5.507-44.8zm-290.37 41.654c-7.614.14-13.588 2.403-19.616 5.793-5.165 2.904-10.355 6.87-15.77 11.033l106.108 63.19-63.082-79.325c-2.088-.296-4.228-.656-6.094-.69-.523-.01-1.037-.01-1.545 0zm247.183 0c-1.866.035-4.007.394-6.096.69l-63.084 79.33 106.112-63.194c-5.415-4.163-10.607-8.13-15.772-11.033-6.43-3.616-12.796-5.95-21.16-5.793zm-301.2 26.69c-21.304.15-40.785 5.3-58.886 17.447l4.56 19.586 132.567 9.953-60.994-36.627.115-.03-8.922-5.312.008.058-8.448-5.074zm356.764 0-8.45 5.077.007-.06-8.922 5.312.117.03-60.997 36.63 132.57-9.956 4.557-19.586c-18.1-12.148-37.58-17.298-58.883-17.446z",
  // orc-head
  "M256 51c-1.216 1.157-3.235 3.694-5.595 7.47-4.552 7.283-10.594 19.233-18.383 34.8v9.94c6.19 4.752 14.906 7.626 23.978 7.626 9.072 0 17.787-2.874 23.978-7.627v-9.94c-7.79-15.567-13.83-27.517-18.383-34.8-2.36-3.776-4.38-6.313-5.595-7.47zm-42.743 54.286c-28.17 6.895-55.87 20.62-82.175 41.132-16.04 80.706-31.2 175.83-16.89 254.565 6.188 2.322 12.687 4.44 19.403 6.398l-3.062-12.257-4.305-6.455 7.807-5.204c6.304-4.203 13.54-7.85 21.487-10.99-5.028-6.777-8.326-15.44-11.545-24.286-5.46-15.013-9.66-31.84-13.654-44.028l-9.792-29.87 24.565 19.616c24.47 19.543 49.132 32.704 82.918 56.314l10.07 7.037c5.944-.26 11.928-.39 17.917-.39 5.99 0 11.973.13 17.916.39l10.07-7.037c33.787-23.61 58.45-36.77 82.92-56.314l24.563-19.616-9.793 29.87c-3.995 12.19-8.193 29.015-13.654 44.028-3.22 8.847-6.517 17.51-11.545 24.287 7.948 3.138 15.183 6.786 21.487 10.99l7.807 5.203-4.305 6.455-3.062 12.258c6.716-1.956 13.215-4.075 19.402-6.397 14.31-78.736-.85-173.86-16.89-254.565-26.305-20.51-54.004-34.237-82.174-41.132v6.31l-2.75 2.746c-10.55 10.552-25.398 15.26-39.993 15.26-14.595 0-29.442-4.708-39.994-15.26l-2.75-2.746v-6.31zm75.98 55.876 13.39 13.145-6.572 6.695c-12.91 13.147-27.168 19.604-41.277 18.865-14.108-.74-26.793-8.077-38.39-18.442l-6.995-6.253 12.504-13.99 6.996 6.25c9.774 8.735 18.788 13.273 26.867 13.696 8.08.423 16.495-2.67 26.905-13.272l6.573-6.694zm-149.998 3.885c19.807 0 41.364 9.12 60.852 19.946 19.487 10.826 36.416 23.397 45.862 32.843l-13.268 13.267c-7.234-7.234-23.665-19.683-41.708-29.707-18.043-10.024-38.186-17.584-51.74-17.584v-18.765zm233.52 0v18.765c-13.552 0-33.695 7.56-51.738 17.584-18.043 10.024-34.474 22.473-41.708 29.707l-13.268-13.267c9.446-9.446 26.375-22.017 45.862-32.843 19.488-10.827 41.045-19.946 60.853-19.946zm-226.887 36.11c16.68 16.68 47.577 47.29 93.447 47.29v.316l16.757-24.214 16.603 24.475v-.578c45.87 0 76.767-30.61 93.447-47.29l13.268 13.266c-8.234 8.233-21.14 21.197-38.61 32.218 4.916 4.755 7.998 11.397 7.998 18.697 0 14.283-11.78 26.063-26.063 26.063-14.282 0-26.062-11.78-26.062-26.063 0-.183.01-.364.014-.546-3.9.798-7.922 1.415-12.06 1.828l28.074 41.386-3.79 5.315c-7.152 10.026-16.657 15.68-26.033 18.204-9.376 2.525-18.523 2.41-26.863 2.41s-17.496.107-26.944-2.4-19.065-8.05-26.67-17.95l-4.17-5.425 28.773-41.58c-4-.41-7.887-1.017-11.662-1.79.004.183.014.364.014.547 0 14.283-11.78 26.063-26.062 26.063-14.283 0-26.063-11.78-26.063-26.063 0-7.3 3.082-13.942 7.998-18.696-17.47-11.02-30.376-23.984-38.61-32.217l13.268-13.267zm-128.076 16.11c2.95 6.932 8.367 15.73 16.54 27.413 12.455 17.8 29.556 41.635 46.575 75.674 1.848 3.697 4.587 6.08 8.64 7.774.07-13.807.677-27.726 1.7-41.656l-24.876-21.55 12.286-14.184 14.638 12.68a899.357 899.357 0 0 1 3.23-26.948c-7.94-6.23-17.723-10.416-28.564-13.373-16.628-4.535-34.943-5.58-50.17-5.83zm476.406 0c-15.226.25-33.54 1.295-50.17 5.83-10.84 2.957-20.623 7.142-28.562 13.373a899.29 899.29 0 0 1 3.23 26.947l14.638-12.68 12.286 14.185-24.875 21.55c1.02 13.93 1.628 27.848 1.7 41.656 4.05-1.694 6.79-4.077 8.638-7.774 17.02-34.04 34.12-57.873 46.575-75.674 8.173-11.682 13.59-20.48 16.54-27.412zm-238.28 40.48L221.81 307.04c3.74 3.347 7.608 5.175 12.06 6.356 6.265 1.663 13.79 1.772 22.13 1.772s15.874-.117 21.982-1.762c4.345-1.17 8.01-2.94 11.476-6.216l-33.535-49.442zm-66.643.292c-4.142 0-7.298 3.155-7.298 7.297 0 4.14 3.156 7.297 7.298 7.297 4.14 0 7.297-3.156 7.297-7.297 0-4.142-3.156-7.298-7.297-7.298zm133.44 0c-4.14 0-7.297 3.155-7.297 7.297 0 4.14 3.156 7.297 7.297 7.297 4.142 0 7.298-3.156 7.298-7.297 0-4.142-3.156-7.298-7.298-7.298zm-166.322 67.34c1.684 5.604 3.355 11.28 5.214 16.392 4.053 11.14 9.25 19.18 12.498 22.424l27.458-9.153c-16.38-10.857-31.114-20.08-45.17-29.662zm199.204 0c-14.056 9.583-28.79 18.806-45.17 29.663l27.458 9.153c3.247-3.245 8.445-11.283 12.498-22.424 1.86-5.112 3.53-10.788 5.214-16.39zM256 375.634c-41.212 0-82.64 7.558-105.97 20.12l13.58 54.32c61.668 14.57 123.112 14.57 184.78 0l13.58-54.32c-23.33-12.562-64.758-20.12-105.97-20.12zm-.018 10.543c23.4-.08 46.826 4.167 70.074 13.005l8.77 3.334-6.67 17.542-8.77-3.336c-42.466-16.144-84.223-15.572-126.88.04l-8.814 3.226-6.448-17.623 8.81-3.223c23.152-8.473 46.527-12.883 69.928-12.964z"
];

// The face in the empty player has something to say. One line per visit, held until
// the first track starts and then never shown again - it is a greeting, not a status.
const HAILS = [
  "ПОГНАЛИ",
  "ВРУБАЙ ДАВАЙ",
  "ДАВИ КНОПКУ",
  "ЧТО ТО СЛИШКОМ ТИХО ЖМИ КНОПКУ",
  "НЕ ВЫНОШУ ТИШИНУ А НУ ВРУБАЙ",
  "ЧАЙКУ ЗАВАРИЛ И ПОЕХАЛИ",
  "КЕЛЛЕРУХИ ДАВАЙ",
  "QUEST MASTERА ВКЛЮЧИ",
  "ВРУБАЙ GNOLL",
  "ЗА ДАНЖН СИНТ ШАРИШЬ ПОСТАВЬ ЛЮБИМЫЙ АЛЬБОМ",
  "ЕСТЬ ЧТО ПО ФРОГ КОРУ",
  "ВКЛЮЧАЙ TALES UNDER THE OAK",
  "СДЕЛАЙ ПОПОГРОМЧЕ",
  "В ДАНЖ НЕБОСЬ СОБРАЛСЯ",
  "КИДАЙ СПАС ОТ ТЕНЦЕЛЬКОРА",
  "КАКОЙ У ТЕБЯ АС",
  "КИДАЙ ИНИЦИАТИВУ",
  "YOU DIED",
  "ГНОМ КОР СТАВЬ",
  "НУ А МОЖЕТ КОМФИ СИНТА",
  "ВРУБАЙ ДИНО СИНТ",
];

// The title is ascii art - a sword - and the blade hangs below the lettering, because
// =, the guard and the chevron are drawn around the math axis while capitals are centred
// higher. How far below depends entirely on the font, and the font depends on the device:
// the css lift was measured on one and overshot on a phone, which renders those glyphs
// from a fallback face. So measure the actual ink here and line the centres up.
function alignBlades() {
  const h1 = document.querySelector("h1");
  const blades = h1 ? h1.querySelectorAll(".blade") : [];
  if (!blades.length) return;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  const cs = getComputedStyle(h1);
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

  // Middle of the drawn ink, measured from the baseline, up positive.
  const inkMiddle = (text) => {
    const m = ctx.measureText(text);
    if (typeof m.actualBoundingBoxAscent !== "number") return null;
    return (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  };

  const letters = inkMiddle("RADIO DUNGEON");
  if (letters === null) return; // old engine: the css fallback keeps its guess
  blades.forEach((el) => {
    const middle = inkMiddle(el.textContent);
    if (middle === null) return;
    // Negative moves it up, which is the direction the blade always needs.
    el.style.top = `${(middle - letters).toFixed(2)}px`;
  });
}

// Web fonts and fallback resolution both settle after first paint; measuring before that
// measures the wrong face.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(alignBlades);
else window.addEventListener("load", alignBlades);
window.addEventListener("resize", alignBlades);

function rollHail() {
  if (!hailEl || !hailLineEl) return;
  hailLineEl.textContent = HAILS[Math.floor(Math.random() * HAILS.length)];
  hailEl.hidden = false;
}

function silenceHail() {
  if (hailEl) hailEl.hidden = true;
}

function rollPlaceholderIcon() {
  const d = PLACEHOLDER_ICONS[Math.floor(Math.random() * PLACEHOLDER_ICONS.length)];
  const hue =
    getComputedStyle(document.documentElement).getPropertyValue("--h").trim() || "18";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
    '<path fill="hsl(' + hue + ', 20%, 54%)" d="' + d + '"/></svg>';
  // Kept around: a track with no cover of its own falls back to it too.
  placeholderIcon = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  if (artwork) artwork.style.backgroundImage = placeholderIcon;
  // The balloon carries the same face: on a phone the thumbnail beside the controls is
  // gone, and without it the line has nobody saying it.
  if (hailFaceEl) hailFaceEl.style.backgroundImage = placeholderIcon;
}

rollRadioColour();
rollPlaceholderIcon();
rollHail();

// A different colour every visit and every roll - the moon is not the same moon twice.
// Hue only: saturation and lightness stay put so it is always bright enough to read
// white text on, whichever colour comes up.
function rollRadioColour() {
  // On the root, not the button: the play icon takes the same hue, so the two turn
  // together. One writer, and css decides who listens.
  document.documentElement.style.setProperty("--h", String(Math.floor(Math.random() * 360)));
}

lightTheFire();
syncFire();

radioBtn?.addEventListener("click", () => {
  tally("btn/radio");
  rollRadioColour();
  // The bag is about to be reshuffled, so whatever was planned came from a bag that no
  // longer exists.
  forgetPlannedNext();
  // Always a roll of the dice, never a switch you have to find your way back out of:
  // pressing it again reshuffles and throws you somewhere else in the channel. The way
  // out is to pick a track yourself - see stopRadio().
  radioMode = true;
  radioBag = [];
  const ref = pickRandomFromChannel();
  if (ref) playNewRef(ref);
  updateModeButtons();
});

// Choosing a specific track or post is the listener overruling chaos, so the radio
// steps aside rather than hijacking whatever they picked once it ends.
function stopRadio() {
  forgetPlannedNext();
  if (!radioMode) return;
  radioMode = false;
  radioBag = [];
  updateModeButtons();
}

// --- rendering ------------------------------------------------------------------

function renderPostList() {
  if (preciousMode) {
    renderPreciousList();
    return;
  }
  const active = computeActiveList();
  if (shownCount < PAGE_SIZE) shownCount = PAGE_SIZE;
  shownCount = Math.min(shownCount, Math.max(active.length, PAGE_SIZE));

  postListEl.innerHTML = "";
  if (!active.length) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "Ничего не найдено";
    postListEl.appendChild(hint);
  } else {
    appendCards(active, 0, shownCount);
  }
  renderViewBar();
  topUpFeed();
}

function renderPreciousList() {
  const tracks = likedTracks();
  postListEl.innerHTML = "";
  if (!tracks.length) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "Пока пусто — жми на сердце у трека";
    postListEl.appendChild(hint);
  } else {
    const post = preciousPost();
    tracks.forEach((track) => postListEl.appendChild(renderTrackRow(post, track, null)));
  }
  renderViewBar();
}

// --- endless feed -------------------------------------------------------------------
// Paging through fifty pages to reach an album is not how anyone browses a channel, so
// the list just keeps going. Two rules keep it from bogging down: new posts are appended
// to what is already on screen rather than rebuilt from scratch (rebuilding every time
// made scrolling slower the further down you got), and the dom never holds the whole
// channel - only as far as the reader has actually gone.

function appendCards(active, from, to) {
  const batch = document.createDocumentFragment();
  active.slice(from, to).forEach((post) => batch.appendChild(renderPostCard(post)));
  postListEl.appendChild(batch);
}

function backButton(onClick, title) {
  const back = document.createElement("button");
  back.type = "button";
  back.id = "view-back";
  back.textContent = "← Назад";
  back.title = title;
  back.addEventListener("click", onClick);
  return back;
}

// One control at a time in this row: inside an album or the collection the way out is
// what matters, and the search box - which only ever searches the channel - would be
// offering to leave by a different door.
function renderViewBar() {
  if (!listInfoEl) return;
  listInfoEl.textContent = "";
  if (albumMode) {
    listInfoEl.appendChild(
      backButton(leaveAlbumView, "Вернуться и отдать очередь обратно каналу"),
    );
  } else if (preciousMode) {
    listInfoEl.appendChild(backButton(() => setPreciousMode(false), "Вернуться в канал"));
  }
  if (searchWrapEl) searchWrapEl.hidden = albumMode || preciousMode;
}

function appendMorePosts() {
  const active = computeActiveList();
  if (shownCount >= active.length) return false;
  const from = shownCount;
  shownCount = Math.min(shownCount + PAGE_SIZE, active.length);
  appendCards(active, from, shownCount);
  renderViewBar();
  return true;
}

// Start loading while LOAD_AHEAD posts are still below the fold, so the next batch is
// usually there by the time the reader reaches it.
function feedWantsMore() {
  const cards = postListEl.children;
  if (!cards.length) return false;
  const trigger = cards[Math.max(0, cards.length - LOAD_AHEAD)];
  return trigger.getBoundingClientRect().top <= window.innerHeight;
}

function topUpFeed() {
  // A tall window can swallow a whole batch at once; guard so this cannot run away.
  for (let i = 0; i < 5 && feedWantsMore(); i++) {
    if (!appendMorePosts()) break;
  }
}

// --- the player on a phone ------------------------------------------------------
// Scrolled past, the player goes to the bottom of the screen instead of off the top of
// it. Going fixed takes it out of the flow, so its slot is pinned to the height it had
// while still in it - otherwise the whole feed jumps up at the moment of docking.

const phone = window.matchMedia("(max-width: 640px)");
let playerDocked = false;

function syncPlayerDock() {
  if (!playerSlot) return;
  const past = playerSlot.getBoundingClientRect().bottom < 0;
  const shouldDock = phone.matches && past;
  if (shouldDock === playerDocked) return;
  // Measured before the class lands, while the player is still filling the slot.
  if (shouldDock) playerSlot.style.minHeight = `${playerSlot.offsetHeight}px`;
  playerDocked = shouldDock;
  document.body.classList.toggle("player-docked", shouldDock);
  if (!shouldDock) playerSlot.style.minHeight = "";
  // Read after the class lands, so this is the bar's real height. A number in the
  // stylesheet cannot know it: the bar grew a line and the credits went under it.
  document.body.style.paddingBottom = shouldDock
    ? `${playerEl.offsetHeight + 40}px`
    : "";
  // The disco has no room of its own in a bar this short, so it joins the transport
  // beside the heart. Moving the node keeps its listeners and its state; a css-only
  // version would need a second button and two things to keep in step.
  if (radioBtn && transportEl && playerEl) {
    if (shouldDock) transportEl.appendChild(radioBtn);
    else playerEl.appendChild(radioBtn);
  }
}

let feedTickScheduled = false;
function onFeedScroll() {
  // Ahead of the throttle guard below, which would otherwise swallow the dock update
  // on every scroll event that arrives while a feed tick is already pending.
  syncPlayerDock();
  // A short timer rather than requestAnimationFrame: rAF stops firing when the tab is
  // not painting, and the feed would then quietly refuse to grow.
  if (feedTickScheduled) return;
  feedTickScheduled = true;
  setTimeout(() => {
    feedTickScheduled = false;
    topUpFeed();
  }, 80);
}

window.addEventListener("scroll", onFeedScroll, { passive: true });
window.addEventListener("resize", onFeedScroll);
// Turning the phone sideways can cross the breakpoint without any scrolling at all.
phone.addEventListener("change", syncPlayerDock);


function renderPostCard(post) {
  const card = document.createElement("div");
  card.className = "post-card" + (current && String(current.messageId) === String(post.message_id) ? " playing" : "");

  const header = document.createElement("div");
  header.className = "post-card-header";

  const dateEl = document.createElement("div");
  dateEl.className = "post-date";
  const dateText = document.createElement("span");
  dateText.textContent = post.message_date ? new Date(post.message_date).toLocaleString("ru-RU") : "";
  dateEl.appendChild(dateText);
  if (post.telegram_url) {
    const link = document.createElement("a");
    link.className = "post-link";
    link.href = post.telegram_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Открыть пост в Telegram";
    link.textContent = "↗";
    link.addEventListener("click", (e) => {
      e.stopPropagation();
      tally("out/telegram");
    });
    dateEl.appendChild(link);
  }
  header.appendChild(dateEl);

  card.appendChild(header);

  if (post.message_text) {
    const textEl = document.createElement("div");
    textEl.className = "post-text";
    writeMarked(textEl, post.message_text);
    card.appendChild(textEl);
  }

  // The post says why to listen; the album line says what you are listening to. Usually
  // one album per post, but a post can carry several - so the heading repeats whenever
  // the album changes rather than being printed once at the top.
  let currentAlbum = null;
  let headingArtist = null;
  post.tracks.forEach((track) => {
    const albumKey = track.album_url || track.album || null;
    if (albumKey && albumKey !== currentAlbum) {
      currentAlbum = albumKey;
      headingArtist = track.artist || null;
      card.appendChild(renderAlbumHeading(track));
    }
    card.appendChild(renderTrackRow(post, track, headingArtist));
  });

  return card;
}

function renderAlbumHeading(track) {
  const heading = document.createElement("div");
  heading.className = "album-heading";

  if (track.album) {
    const name = document.createElement(track.album_url ? "a" : "div");
    name.className = "album-name";
    writeMarked(name, track.album);
    if (track.album_url) {
      name.href = track.album_url;
      name.target = "_blank";
      name.rel = "noopener";
      name.title = "Открыть альбом на bandcamp";
    }
    heading.appendChild(name);
  }
  if (track.artist) {
    const by = document.createElement("div");
    by.className = "album-artist";
    by.appendChild(Object.assign(document.createElement("span"), {
      className: "album-by",
      textContent: "by ",
    }));
    const who = document.createElement("span");
    writeMarked(who, track.artist);
    by.appendChild(who);
    heading.appendChild(by);
  }
  return heading;
}

function setLikeButtonState(btn, liked) {
  btn.classList.toggle("liked", liked);
  btn.title = liked ? "Убрать лайк" : "Лайк";
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", String(liked));
}

// The player's own heart likes whatever is playing. It stays dead until something is,
// because there is nothing to like about an empty player.
function updateNowLike() {
  if (!nowLikeBtn) return;
  const track = current ? findTrack(current.trackId) : null;
  nowLikeBtn.disabled = !track;
  if (!track) {
    setLikeButtonState(nowLikeBtn, false);
    nowLikeBtn.title = "Лайк";
    nowLikeBtn.setAttribute("aria-label", nowLikeBtn.title);
    return;
  }
  setLikeButtonState(nowLikeBtn, likedIds.has(track.id));
}

nowLikeBtn?.addEventListener("click", () => {
  const track = current ? findTrack(current.trackId) : null;
  if (track) toggleTrackLike(track);
});

function renderTrackRow(post, track, headingArtist) {
  const row = document.createElement("div");
  const isPlaying = current && current.trackId === track.id;
  row.className = "track-row" + (isPlaying ? " playing" : "");
  row.dataset.trackId = track.id;

  // The cover doubles as the row's play/pause control - a row used to be one command,
  // "play this from the start", with no way to pause without reaching for the player.
  const thumb = document.createElement("span");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.src = coverUrl(track.thumbnail, ART_ROW) || "";
  // Nothing below the fold needs decoding until it gets there.
  img.loading = "lazy";
  img.decoding = "async";
  thumb.appendChild(img);

  const rowPlay = document.createElement("button");
  rowPlay.type = "button";
  rowPlay.className = "row-play";
  // Pause is two bars drawn in css, so the row carries one icon instead of two.
  rowPlay.innerHTML =
    `<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path d="${PLAY_PATH}" /></svg>` +
    '<span class="bars"><span></span><span></span></span>';
  setRowPlayState(rowPlay, isPlaying && !audio.paused);
  rowPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    if (current && current.trackId === track.id) {
      // Already the one playing: pause or pick it back up, never start it over.
      if (audio.paused) startPlayback();
      else stopPlayback();
      return;
    }
    tally("row/play");
    stopRadio();
    playNewRef({ messageId: post.message_id, trackId: track.id });
  });
  thumb.appendChild(rowPlay);
  row.appendChild(thumb);

  const meta = document.createElement("div");
  meta.className = "meta";
  const titleEl = document.createElement("div");
  titleEl.className = "title";
  writeMarked(titleEl, track.title);
  meta.appendChild(titleEl);
  // Repeating the album's artist on every one of its tracks is just noise; on a
  // compilation, where the per-track artist differs, it is the whole point.
  if (track.artist && track.artist !== headingArtist && !artistLeadsTitle(track)) {
    const artistEl = document.createElement("div");
    artistEl.className = "artist";
    writeMarked(artistEl, track.artist);
    meta.appendChild(artistEl);
  }

  row.appendChild(meta);

  // Bandcamp's model is listen-then-buy. A player that takes the plays and hides the
  // purchase link gives the artist nothing back, so the link rides along with the track.
  const buy = document.createElement("a");
  buy.className = "buy-link";
  buy.href = track.webpage_url;
  buy.target = "_blank";
  buy.rel = "noopener";
  buy.textContent = "купить";
  buy.title = "Открыть на bandcamp";
  buy.addEventListener("click", (e) => {
    e.stopPropagation();
    // Bandcamp is where the money reaches the artist; how often the player sends
    // someone there is worth more than any of the presses above.
    tally("out/bandcamp");
  });
  row.appendChild(buy);

  // The heart is a css mask (see .like-btn in style.css), not an svg element. Inline,
  // its path is 3KB, and a feed grown to a thousand rows was carrying three and a half
  // megabytes of vector data in the dom for one icon repeated.
  const like = document.createElement("button");
  like.type = "button";
  like.className = "like-btn";
  like.dataset.trackId = track.id;
  setLikeButtonState(like, likedIds.has(track.id));
  like.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTrackLike(track);
  });
  row.appendChild(like);

  row.addEventListener("click", () => {
    tally("row/play");
    stopRadio();
    playNewRef({ messageId: post.message_id, trackId: track.id });
  });

  return row;
}

// --- sort / filter toolbar ------------------------------------------------------

// Two dropdowns for five states was more form than the page needed; these say the same
// thing in the same visual language as the rest of the controls.
// --- keeping the baked links alive -------------------------------------------------
// Bandcamp stamps every stream url with a 24h expiry, and a scheduled rebuild bakes
// fresh ones into posts.json. A tab left open across a rebuild would be holding dead
// links, so playback failures re-read the file once instead of skipping the track.

let refreshingData = false;

function dataLooksStale() {
  return dataExpiresAt > 0 && Date.now() / 1000 > dataExpiresAt - 60;
}

async function refreshDataAndRetry(ref) {
  if (refreshingData) return false;
  refreshingData = true;
  try {
    await loadPosts({ force: true });
    renderPostList();
    const track = findTrack(ref.trackId);
    if (!track) return false;
    audio.src = track.stream_url;
    await audio.play();
    return true;
  } catch (e) {
    return false;
  } finally {
    refreshingData = false;
  }
}

// --- init --------------------------------------------------------------------

(async function init() {
  try {
    loadUiPrefs();
    updateModeButtons();

    loadUserData();
  } catch (e) {
    // Usually a stale index.html paired with a fresh app.js: the markup no longer has
    // an element this script expects. Whatever it is, a blank page tells the listener
    // nothing, so say something they can act on.
    console.error(e);
    showFailure(
      "Плеер не запустился",
      "Скорее всего браузер держит старую версию страницы. Обнови её принудительно: " +
        "Ctrl+Shift+R на компьютере, потянуть страницу вниз на телефоне."
    );
    return;
  }

  showLoading();

  try {
    await loadPosts();
  } catch (e) {
    // Without the data file there is no player at all, so say so plainly instead of
    // leaving an empty shell that looks like the channel simply has no music in it.
    console.error(e);
    showFailure(
      "Не удалось загрузить список треков",
      "Похоже, сайт сейчас обновляется — попробуй перезагрузить страницу через пару минут."
    );
    return;
  }

  try {
    updatePreciousButton();
    renderPostList();
  } catch (e) {
    console.error(e);
    showFailure(
      "Список не отрисовался",
      "Обнови страницу принудительно: Ctrl+Shift+R на компьютере, потянуть вниз на телефоне."
    );
  }

  try {
    // After the list, because the track has to be found in it first - and last, because
    // a place that cannot be found again is no reason for the page not to open.
    takeUpResumePoint();
  } catch (e) {
    console.error(e);
  }
})();

// The markup renders instantly; the channel list is a megabyte behind it. Without this
// the player just sits there looking like a channel with nothing in it.
function showLoading() {
  if (!postListEl) return;
  postListEl.textContent = "";
  const box = document.createElement("div");
  box.className = "feed-loading";
  box.appendChild(
    Object.assign(document.createElement("div"), {
      className: "feed-loading-spinner",
      ariaHidden: "true",
    })
  );
  box.appendChild(
    Object.assign(document.createElement("div"), { textContent: "Загружаю список канала" })
  );
  box.appendChild(
    Object.assign(document.createElement("div"), {
      className: "feed-loading-note",
      textContent: "в первый раз это около мегабайта",
    })
  );
  postListEl.appendChild(box);
  if (listInfoEl) listInfoEl.textContent = "";
}

function showFailure(title, hint) {
  // The container itself may be what went missing, so fall back to the page body -
  // this is the last thing standing between a listener and a blank screen.
  const host = postListEl || document.body;
  if (host === postListEl) host.textContent = "";
  const box = document.createElement("div");
  box.className = "load-failure";
  box.appendChild(
    Object.assign(document.createElement("div"), {
      className: "load-failure-title",
      textContent: title,
    })
  );
  box.appendChild(Object.assign(document.createElement("div"), { textContent: hint }));
  host.appendChild(box);
}
