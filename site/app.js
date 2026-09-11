const audio = document.getElementById("audio");
const nowTitle = document.getElementById("now-title");
const nowArtist = document.getElementById("now-artist");
const artwork = document.getElementById("artwork");
const playerEl = document.querySelector(".player");
const playBtn = document.getElementById("play-btn");
const seekEl = document.getElementById("seek");
const muteBtn = document.getElementById("mute-btn");
const postContextEl = document.getElementById("post-context");
const postContextLinkEl = document.getElementById("post-context-link");
const postContextTextEl = document.getElementById("post-context-text");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const radioBtn = document.getElementById("radio-btn");
const sortBtn = document.getElementById("sort-btn");
const filterBtns = Array.from(document.querySelectorAll("[data-filter]"));
const categoryFilterEl = document.getElementById("category-filter");
const categoryManagerToggle = document.getElementById("category-manager-toggle");
const categoryManagerBody = document.getElementById("category-manager-body");
const categoryManageListEl = document.getElementById("category-manage-list");
const categoryCreateForm = document.getElementById("category-create-form");
const categoryNameInput = document.getElementById("category-name-input");
const postListEl = document.getElementById("post-list");
const listInfoEl = document.getElementById("list-info");
const feedEndEl = document.getElementById("feed-end");

const UI_PREFS_KEY = "rd_player_prefs_v1";
const PAGE_SIZE = 30; // posts appended per step - the channel has thousands of tracks,
// so rendering the whole filtered list at once would make the page unusably heavy.
const LOAD_AHEAD = 3; // posts left below the fold when the next batch starts loading

let posts = [];
let categories = [];

let sortOrder = "new"; // 'new' | 'old'
let filterMode = "all"; // 'all' | 'liked' | 'categories'
let selectedCategoryIds = new Set();
let placeholderIcon = "none"; // set once at startup, see rollPlaceholderIcon()
let radioMode = false;
let radioBag = []; // tracks not yet played in the current radio round

let current = null; // { messageId, trackId } | null
let history = [];
let historyPos = -1;

let shownCount = PAGE_SIZE; // how far down the feed we have rendered so far

let pollTimer = null;

let openPopoverEl = null;
let openPopoverKey = null;
let popoverNeedsRerender = false;

// --- persistence of UI preferences (filter/sort/repeat) --------------------------
// Likes and category assignments already live server-side in user_data.json, kept
// separate from tracks.json so a resync can't wipe them. This only remembers small
// per-browser display preferences.

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.sortOrder) sortOrder = p.sortOrder;
    if (p.filterMode) filterMode = p.filterMode;
    if (Array.isArray(p.selectedCategoryIds)) selectedCategoryIds = new Set(p.selectedCategoryIds);
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
        filterMode,
        selectedCategoryIds: Array.from(selectedCategoryIds),
      })
    );
  } catch (e) {
    // storage unavailable - non-critical, ignore
  }
}

// --- data loading -------------------------------------------------------------

// Likes and categories used to live server-side in user_data.json. There is no
// server here, so they stay in this browser - which is the only place they were ever
// needed: nothing personal has ever left the machine.

const USER_DATA_KEY = "rd_player_user_data_v1";
let userData = { post_likes: {}, categories: [], track_categories: {} };

let dataGeneratedAt = 0;
let dataExpiresAt = 0;

function loadUserData() {
  try {
    const raw = localStorage.getItem(USER_DATA_KEY);
    if (raw) userData = Object.assign(userData, JSON.parse(raw));
  } catch (e) {
    // corrupt or blocked storage - start empty rather than break the player
  }
}

function saveUserData() {
  try {
    localStorage.setItem(USER_DATA_KEY, JSON.stringify(userData));
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
  posts = (payload.posts || []).map((post) => ({
    ...post,
    liked: Boolean(userData.post_likes[String(post.message_id)]),
    tracks: post.tracks.map((t) => ({
      ...t,
      categories: (userData.track_categories[t.id] || []).slice(),
    })),
  }));
}

function loadCategories() {
  categories = userData.categories;
}

async function refreshPosts() {
  await loadPosts();
  renderPostList();
  if (current) {
    const track = findTrack(current.trackId);
    if (track) updateNowPlaying(track);
  }
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

function computeActiveList() {
  let list = posts.map((post) => {
    let tracks = post.tracks;
    if (filterMode === "categories" && selectedCategoryIds.size) {
      const required = Array.from(selectedCategoryIds);
      tracks = tracks.filter((t) => required.every((cid) => t.categories.includes(cid)));
    }
    return { ...post, tracks };
  });

  if (filterMode === "liked") {
    list = list.filter((p) => p.liked);
  } else if (filterMode === "categories" && selectedCategoryIds.size) {
    list = list.filter((p) => p.tracks.length > 0);
  }

  list.sort((a, b) => {
    const da = a.message_date ? new Date(a.message_date).getTime() : 0;
    const db = b.message_date ? new Date(b.message_date).getTime() : 0;
    return sortOrder === "new" ? db - da : da - db;
  });

  return list;
}

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
// index, so pointers stay valid across re-renders (a like/category toggle or a resync
// rebuilds `posts` but never invalidates existing ids).

function activatePlayback(ref) {
  const track = findTrack(ref.trackId);
  if (!track) return;
  current = ref;
  audio.src = track.stream_url;
  paintSeek(0);
  audio.play();
  updateNowPlaying(track);
  highlightCurrentTrack();
}

// Moving the highlight used to rebuild every card on the page - half a second of frozen
// ui after 400 posts, and over a second once the disco had grown the feed to 800. The
// highlight is two class changes; the list has no reason to be touched.
function highlightCurrentTrack() {
  const previous = postListEl.querySelector(".track-row.playing");
  if (previous) previous.classList.remove("playing");
  if (!current) return;
  const row = postListEl.querySelector(`.track-row[data-track-id="${current.trackId}"]`);
  if (row) row.classList.add("playing");
}

function playNewRef(ref) {
  if (!ref) return;
  history = history.slice(0, historyPos + 1);
  history.push(ref);
  historyPos = history.length - 1;
  activatePlayback(ref);
}

function updateNowPlaying(track) {
  nowTitle.textContent = track.title;
  nowArtist.textContent = track.artist || "";
  // An <img> with src="" resolves to the page itself and can draw a broken-image icon,
  // so drop the attribute entirely and let the css placeholder show through.
  if (track.thumbnail) {
    artwork.style.backgroundImage = `url("${track.thumbnail}")`;
    artwork.classList.remove("empty");
  } else {
    artwork.style.backgroundImage = placeholderIcon;
    artwork.classList.add("empty");
  }
  setCover(track.thumbnail);
  showPostContext();
}

// The post text is the whole point of the channel - it is where the recommendation
// actually lives. Playing a track without it shows the music but loses the voice.
function showPostContext() {
  if (!postContextEl) return;
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
  if (e.target.closest("#post-context-link")) return;
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

function pickNext() {
  // The radio ignores the filter on purpose: it plays the channel, not the view.
  if (radioMode) return pickRandomFromChannel();

  const active = computeActiveList();
  const flat = flattenActive(active);
  if (!flat.length) return null;
  if (!current) return flat[0];

  const idx = flat.findIndex((r) => r.trackId === current.trackId);
  if (idx === -1) return flat[0];
  return idx + 1 < flat.length ? flat[idx + 1] : flat[0]; // loop back to the start
}

function nextTrack() {
  if (historyPos < history.length - 1) {
    historyPos++;
    activatePlayback(history[historyPos]);
    return;
  }
  const ref = pickNext();
  if (ref) playNewRef(ref);
}

function prevTrack() {
  if (historyPos > 0) {
    historyPos--;
    activatePlayback(history[historyPos]);
  }
}


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
    // Nothing chosen yet - treat the play button as "start something".
    radioBtn?.click();
    return;
  }
  if (audio.paused) audio.play();
  else audio.pause();
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

muteBtn?.addEventListener("click", () => {
  audio.muted = !audio.muted;
  muteBtn.textContent = audio.muted ? "🔇" : "🔊";
  muteBtn.title = audio.muted ? "Включить звук" : "Выключить звук";
  muteBtn.setAttribute("aria-label", muteBtn.title);
});

audio.addEventListener("timeupdate", syncTransport);
audio.addEventListener("durationchange", syncTransport);
audio.addEventListener("loadedmetadata", syncTransport);
audio.addEventListener("emptied", syncTransport);
audio.addEventListener("play", syncPlayButton);
audio.addEventListener("pause", syncPlayButton);
audio.addEventListener("ended", syncPlayButton);

audio.addEventListener("ended", nextTrack);
audio.addEventListener("error", async () => {
  if (!current) return;
  // A link past its 24h expiry fails exactly like a dropped connection, so try one
  // data refresh before writing the track off - the rebuild may already have run.
  if (dataLooksStale() && (await refreshDataAndRetry(current))) return;
  console.warn("Playback error, skipping to next track", current);
  nextTrack();
});

prevBtn?.addEventListener("click", prevTrack);
nextBtn?.addEventListener("click", nextTrack);

function updateModeButtons() {
  // A stale index.html may not have this button. Losing a control is survivable;
  // throwing here is not, because this runs before anything gets rendered.
  if (!radioBtn) return;

  radioBtn.classList.toggle("active", radioMode);
  radioBtn.title = radioMode
    ? "Боги Хаоса выбирают — нажми, чтобы остановить"
    : "Играть как боги Хаоса решат";
}

// A different one of these in the empty artwork slot every visit - the player should
// look like it was waiting for you, not like it failed to load a picture.
// Icons by Lorc, Delapouite and Skoll (game-icons.net), CC BY 3.0.
const PLACEHOLDER_ICONS = [
  // super-mushroom
  "M242.875 25.594c-46.25.117-92.147 12.63-130.375 39.75C68.81 96.34 35.56 146.5 23.625 217c-3.752 22.16 1.91 41.663 14.344 56.47 12.43 14.804 30.868 25.155 52.624 32.78 43.51 15.25 101.268 19.72 157.344 19.72 56.395 0 116.863-7.428 163.218-24 23.178-8.288 42.93-18.84 56.875-32.72 11.43-11.375 18.665-25.59 19.47-41.344h1.094l-1.438-10.594c-15.005-112.175-118.867-183.277-224.47-191-6.6-.482-13.204-.735-19.81-.718zm.063 18.687c6.123-.014 12.238.21 18.375.657 3.214.236 6.418.547 9.625.907-25.16 19.974 10.362 61.325 47.375 54.312 26.565-5.036 32.874-19.8 27.812-33.844 62.617 27.994 112.41 81.343 122.344 152.407l.155 1.06c1.887 14.112-2.827 25.35-13.78 36.25-2.64 2.627-5.673 5.182-9.033 7.658 3.986-14.92-.91-32.102-21.375-45.344-40.378-26.132-96.414 37.186-41.843 72.5.154.1.313.183.47.28-40.09 10.845-89.146 16.157-135.127 16.157-26.117 0-52.553-1.105-77.375-3.717 17.746-9.192 27.433-34.97 1.5-51.75-26.975-17.458-63.925 21.993-34.312 47.187-14.918-2.678-28.762-6.086-41-10.375-8.628-3.024-16.41-6.468-23.22-10.313 15.15-7.296 23.773-29.15 1.94-43.28-11.807-7.64-25.924-2.13-33 7.843-1.682-6.65-1.873-14.094-.407-22.75 3.89-22.972 10.086-43.39 18.156-61.438 2.32 19.157 15.042 34.623 35.56 31.094 62.195-10.696 55.24-98.255 9.22-90.343-1.82.314-3.578.685-5.28 1.126a182.124 182.124 0 0 1 23.593-19.97c12.744-9.04 26.488-16.332 40.906-21.937-.934 7.07 2.093 14.8 11.53 20.907 18.86 12.203 44.305-13.4 28.063-31.876 12.84-2.25 25.943-3.372 39.125-3.406zm-51.844 54.407c-4.59.115-9.263 1.438-13.656 4.282-38.004 24.593 1.004 68.694 29.125 50.5 32.066-20.753 9.32-55.4-15.47-54.782zm191.72 31.594c-24.964.418-21.014 38.305 2.81 45.564 36.154 11.015 34.472-35.725 7.72-43.875-3.954-1.206-7.466-1.74-10.53-1.69zm-116.845 27.626c-9.463.237-19.07 2.983-28.126 8.844-78.328 50.685 2.105 141.54 60.062 104.03 66.09-42.764 19.156-114.15-31.937-112.874zM335 338.594c-55.842 7.335-113.248 7.307-167.406 2.156-21.82 91.642-38.78 153.125 82.687 153.125 129.88 0 110.022-66.537 84.72-155.28z",
  // chanterelles
  "M198.5 62.04c-16.7 0-34.1.48-53.4.63 16.6 9.6 37.8 20.63 59.8 30.78 36 16.85 73.5 31.75 88.5 35.45 4 .9 18.3 2.5 36.4 3.4 18 1 40.5 1.5 63.6 1.4 38.2-.2 78.8-2.7 103-7.4-15.9-18.8-30.9-31.95-52.1-39.18-25.1-8.61-60.4-9.63-117.1-.77l-2.6.41-2.5-1.08c-45.6-20.3-81.9-23.64-123.6-23.64zm-5.7 45.76c35.9 40.5 66.2 81.5 88.1 123.8 32.9 63.6 46.6 130.7 31.2 202.6 6 9.1 12.1 13.8 18.3 15.3 6.6 1.5 14.6-.2 25-6.7 31.5-43.2 27.4-105.4 31-166.3 1.9-30.7 5.9-61.1 19.2-88 6.7-13.7 15.9-26.4 28.2-37.6-9.2.3-18.5.5-27.9.7-21.3 27-35.3 68.1-34.7 105.9-20.8-33.3 0-77.1 15.6-105.8-19.4 0-38-.4-53.9-1.2 5.6 23.9 7.2 56.3 7.6 72.8-15.7-6.8-15.3-46.7-25.5-73.8-11.4-.9-20.1-1.8-25.8-3.2-7.9-1.9-19-5.7-31.9-10.7 30.6 40.6 73.7 106.8 57.8 126-14.9-44.2-51.2-96-92.1-140.1-8.4-3.7-17.1-7.6-25.7-11.6zm-80.9 81.7c-38.51 4.3-69.01 22.1-96.28 37 16.53 3.7 34.99 8.1 53.13 11.7 28.43 5.6 55.95 7.5 66.05 3.1 32.1-14.2 65.2-23.4 88.3-36.9-32.8-6-72.4-14.4-111.2-14.9zm83.6 47.9c-8 3-16.2 5.9-24.3 8.9-4 14.5-8.6 54-11.8 54.8-3.3.8-11.5-36.8-9-46.9-2.8 1.1-5.6 2.3-8.4 3.5-9.8 4.4-21.7 5.3-34.9 4.5 7 12.5 24.3 38.4 24.9 61 0 0-34.02-47.3-56.5-65.4-3.38-.6-6.8-1.2-10.24-1.9-9.46-1.9-18.89-4-28.13-6.1C75.45 271 102.1 300.1 119.8 330c24 40.7 32.1 82.6 32.8 111 9.6 2.4 17.6 2.8 23.8 1.4 6.3-1.4 11.1-4.3 15.3-9.3-5.8-29.7-15.5-69.1-15.9-109.7-.2-29.2 4.6-59.2 19.7-86z",
  // broken-axe
  "m246.8 35.58 25.5 52.5 24.8-22.9-50.3-29.6zm109.1 13.41-10.3 9.51 52.9 57.3 10.3-9.5-52.9-57.31zm-30.3 14.37-57.3 52.94 66.5 72 57.3-53-66.5-71.94zM181.8 93.33l-19.5 49.17L196 187l-14.2-93.67zM75.81 127l-32.42 13.8 94.41 52.1L75.81 127zm186.09 8.9-16.2 15-32 44.1 62.7-18.2-33.6 70.7 32.4-17.8 39.6-36.6-52.9-57.2zm232.1 2.4c-3.1.8-6.1 1.6-9.2 2.3-25.7 5.9-51.9 8.5-74.5 2.3l-69.4 64.2c4.5 23-.2 48.9-8.1 74.1-8.7 27.5-21.6 54.1-32.9 75.4 60.6 17.3 133-11.2 187.1-61.1 2.4-2.2 4.7-4.5 7-6.7V138.3zM76.71 232.6l-18.78 37.6 72.57-21.6-53.79-16zm117.19 48-24 51.8-21-34.4-47.2 196H182l37.2-154.6-25.7 29.5.4-88.3z",
  // spiked-ball
  "M87.845 350.075a192.53 192.53 0 0 0 10.15 19.15l-24.3 2.37zm53.16-272.84 4.94 39.57a193.29 193.29 0 0 1 29.09-18.48zm336.84 265.2-28.17-23.73a191.29 191.29 0 0 1-11.24 31.38zm-384.47-154.89-59.22 11.89 39.81 33.14a191.21 191.21 0 0 1 14.35-44zm159.38-69.88c13.3-1 25.17-4.91 31.72-10.2l-37.32-65.16-27.28 70c7.26 4.23 19.57 6.35 32.88 5.36zm125.46 30.68c1.31 8.32 7.48 19.19 16.68 28.84 9.2 9.65 19.76 16.35 28 18.05l26.7-70.18zm-46.11 254.48c-11.81 6.21-21.13 14.53-25 22l60.21 44.87-2.88-75c-8.39-1.05-20.52 1.92-32.33 8.13zm-139-20.19c-12.35-5-24.72-6.81-32.94-5l4.4 75 55.58-50.5c-4.61-7.09-14.69-14.47-27.05-19.51zm-26.26-113.75a33.771 33.771 0 1 0 29-61s-37.69 2.33-57.36 10.39c6.29 20.16 28.36 50.61 28.36 50.61zm270.26.91a173.52 173.52 0 0 1-53.88 125.77l-.54-14.18-5.25-2.41c-13.5-6.21-33.73-3.51-54.12 7.22s-34.07 25.88-36.6 40.52l-1 5.69 10.92 8.14a174.29 174.29 0 0 1-85.68-4.73l31.08-28.24-1.53-5.57c-3.94-14.33-19-28.08-40.36-36.78-21.36-8.7-41.73-9.43-54.57-1.94l-5 2.91 1.69 28.69a173.49 173.49 0 0 1-53.12-125.09c0-74.34 46.87-137.93 112.61-162.8l-4 10.17 3.85 4.3c8.73 9.76 25 15.26 44.48 15.26 2.62 0 5.31-.1 8-.3 23-1.71 41.56-10.14 49.72-22.56l3.17-4.83-5.08-8.87a173.38 173.38 0 0 1 66.83 31.48l-8.37 2.73-.89 5.7c-2.28 14.68 5.85 33.41 21.74 50.09 14.7 15.43 31.47 24.3 45.6 24.3h1.23a173.29 173.29 0 0 1 9.1 55.33zm-233.15-78.88c-24.81-11.79-75.11 10.9-80.71 13.52l-7.11 3.31 2 7.59c1.56 6 15.92 58.75 40.69 70.53a52.57 52.57 0 1 0 45.13-94.95zm195.14 122.82-2.33-7.49c-1.84-5.9-18.67-57.94-44-68.54a52.583 52.583 0 0 0-40.63 97c25.33 10.62 74.46-14.41 80-17.3zm-53.56-58.68a33.764 33.764 0 1 0-26.1 62.28s37.53-4.1 56.81-13.08c-7.2-19.82-30.71-49.2-30.71-49.2z",
  // metal-bar
  "M322.248 85.684 61.432 224.717l-41.145 109.94 7.233 3.85 153.673 81.8 308.495-164.215-37.752-99.903-129.688-70.506zm119.035 95.187 25.11 66.45-102.56 54.594L430.39 186.64l10.893-5.77zm-89.576 47.417L284.957 343.9l-41.67 22.182 72.195-118.62 36.225-19.175zM72.38 248.78l28.21 14.933-54.012 54.012L72.38 248.78zm210.827 15.767L211.19 382.87l.26.16-17.208 9.16 5.795-83.618 83.17-44.025zm-165.334 8.312 16.963 8.98-60.445 60.445-16.93-9.012 60.413-60.414zM181.42 306.9l-6.174 89.07-54.1-28.798L181.42 306.9z",
  // skull-crack
  "M226.063 24.188 222 58.718l32.688 25.626 23.75-50.03c-18.145-9.142-35.272-9.715-52.375-10.127zM166.75 61.093c-24.248 2.93-42.95 15.897-58.875 33.812h.03l96.407 62.594-37.562-96.406zM300.875 88.75l18.656 85.5-91.092-23.875L269 233.938l-140.594-89.375c-3.966 4.875-7.7 9.97-11.22 15.28-28.794 43.465-42.052 101.104-42.905 156.72 40.122 19.627 63.843 40.14 74.032 61.562 9.157 19.25 5.475 39.06-6.343 54.25 25.214 23.382 68.638 37.63 113.155 38.344 44.813.717 89.973-12.083 118.625-38.783-6.033-6.937-10.412-14.346-12.5-22.437-2.8-10.85-.952-22.554 5.188-33.28 11.757-20.542 37.646-39.263 80.062-59.69-.88-52.663-13.855-110.235-42.5-154.405-23.4-36.085-56.548-63.412-103.125-73.375zm-119.28 168.844c27.75 0 50.25 22.5 50.25 50.25s-22.5 50.25-50.25 50.25c-27.752 0-50.25-22.5-50.25-50.25s22.498-50.25 50.25-50.25zm149.468 0c27.75 0 50.25 22.5 50.25 50.25s-22.5 50.25-50.25 50.25-50.25-22.5-50.25-50.25 22.5-50.25 50.25-50.25zm-74.75 86.125c13.74 29.005 24.652 58.023 30.062 87.03-14.777 12.895-41.26 14.766-60.125 0 7.315-29.007 16.12-58.025 30.063-87.03z",
  // spiked-tentacle
  "M126.21 44.816c-28.57.028-62.253 6.175-101.43 19.473v206.177c34.753-70.097 94.796-95.33 118.277-33.147.682.01 1.364.025 2.04.055 3.224.144 6.385.534 9.47 1.213 12.338 2.715 23.426 11.78 27.183 25.8 1.956 7.3 1.593 14.67-1.373 20.794-2.966 6.124-8.112 10.54-13.865 13.576-4.176 2.204-8.76 3.83-13.647 5.02.002.47.014.92.014 1.394a85.044 85.044 0 0 0 3.57 24.435c1.256-.51 2.525-.98 3.81-1.386a37.095 37.095 0 0 1 11.122-1.732c8.973-.013 18.105 3.27 25.32 10.487 5.345 5.344 8.714 11.907 9.208 18.693.494 6.786-1.756 13.183-5.22 18.69-1.63 2.588-3.532 5.05-5.653 7.41 10.645 7.775 22.837 14.108 36.008 18.71 1-2.945 2.326-5.773 4.08-8.437 5.995-9.102 17.213-14.595 30.828-14.595 14.235 0 25.768 7.644 29.588 18.42 1.417 3.995 2.053 8.125 2.118 12.352 16.59-1.707 33.3-6.156 49.358-13.756.152-8.87 4.284-18.062 12.052-25.83 6.29-6.292 13.948-9.724 21.325-10.214a26.966 26.966 0 0 1 1.654-.06c3.846-.026 7.58.763 10.967 2.376.103.05.2.107.302.157.835-.87 1.665-1.75 2.49-2.644 39.125-42.52 48.15-142.046 1.018-199.545-45.518-55.526-192.24 13.158-82.676 100.54-41.65-77.294 28.077-75.698 46.442-43.89 20.212 35.01 23.473 84.05-28.07 113.808-40.74 23.524-86.61-26.748-79.102-97.476 11.57-109.013-25.18-186.965-127.21-186.866zm167.315 47.778c-3.595 12.322-5.927 36.444-1.285 50.838 7.242-4.467 20.556-9.718 28.203-12.64-4.625-12.596-17.803-27.15-26.918-38.198zm118.914 7.746c-12 4.557-32.654 17.232-41.344 29.61 7.927 3.09 20.143 10.55 27.084 14.892 7.264-11.282 10.935-30.57 14.26-44.502zm28.753 89.523c-3.682-.066-7.177.133-10.33.66 3.792 8.808 7.462 24.518 9.465 33.526 14.805-3.092 33.197-15.397 47.016-23.747-10.684-4.902-30.192-10.152-46.15-10.44zm-299.51 66.23c-6.372.107-13.992 1.302-22.08 3.464-16.965 4.533-35.67 12.95-51.343 20.99 16.297 4.056 37.71 7.523 56.422 7.418 14.068-.08 26.53-2.266 33.107-5.736 3.287-1.737 4.947-3.5 5.767-5.193.82-1.693 1.22-3.78.14-7.81-2.193-8.187-5.76-10.762-13.146-12.387-1.846-.406-3.933-.646-6.218-.725a50.45 50.45 0 0 0-2.65-.02zm299.23 37.33c1.846 9.19-5.056 29.82-10.126 37.53 15.95 5.515 40.613 4.254 58.625 4.166-9.14-13.307-30.785-34.768-48.498-41.698zm-268.393 51.34c-.543.006-1.097.046-1.666.116-1.518.185-3.144.586-4.946 1.157-7.208 2.286-16.415 8.81-25.443 17.826-12.424 12.408-24.413 29.05-33.967 43.85 16.142-4.636 36.42-12.343 52.57-21.79 12.144-7.102 21.843-15.225 25.803-21.52 1.98-3.146 2.536-5.502 2.4-7.378-.137-1.876-.83-3.885-3.782-6.836-3.932-3.933-7.17-5.478-10.968-5.428zm208.722 31.633c-2.278-.144-4.678 1.167-8.96 5.448-6.627 6.628-7.317 10.62-6.387 15.136.93 4.517 4.95 10.543 11.79 16.743 9.61 8.715 23.68 17.07 37.524 24.96-3.23-14.377-8.502-31.08-15.27-43.492-5.04-9.243-10.957-15.676-14.965-17.586-1.002-.478-1.89-.86-2.758-1.06a5.881 5.881 0 0 0-.975-.148zm-115.29 19.74c-9.372 0-12.683 2.334-15.22 6.184-2.536 3.85-3.952 10.955-3.502 20.174.634 12.96 4.674 28.816 8.883 44.184 7.885-12.45 15.968-27.99 19.96-41.55 2.972-10.1 3.336-18.834 1.853-23.02-1.484-4.184-2.748-5.973-11.973-5.973z",
  // sea-urchin
  "m351.251 13.588-63.7 142.933c-4.476-.89-8.995-1.672-13.597-2.224L217.29 36.766l-8.268 121.093c-4.17.984-8.25 2.163-12.283 3.438L118.96 45.227l-16.168 7.351L140.14 191.17c-14.08 11.23-26.113 24.531-35.461 39.422L26.24 199.656l-9.418 14.977 68.633 63.572c-1.828 8.984-2.826 18.238-2.826 27.717 0 2.308.08 4.598.191 6.88L38.388 347.69l51.787 3.561c3.874 11.322 9.212 22.036 15.726 32.041l-54.05 97.783 13.726 11.194 79.46-67.956c21.822 16.096 48.066 27.38 76.816 32.042l23.726 42.058 15.766-39.867c31.399-1.63 60.574-11.018 85.17-26.191l125.013 50.318 9.826-14.61-83.279-86.019c3.785-5.892 7.19-12.008 10.065-18.385l52.078-1.365-41.287-34.824c1.095-7.04 1.699-14.225 1.699-21.547 0-8.113-.706-16.068-2.045-23.828l76.592-127.309-111.578 55.645c-11.308-12.776-24.843-23.837-40.024-32.772l24.79-159.021zm-11.09 69.103-32.28 207.053 17.788 2.774 14.914-95.674c37.697 24.622 62.047 64.427 62.047 109.078 0 22.655-6.277 44.063-17.371 62.88l-38.781-40.056-12.932 12.522 105.428 108.896-134.266-54.041-6.72 16.7 27.24 10.962c-17.047 8.508-36.144 14.149-56.538 16.182l7.524-19.024-16.738-6.619-16.76 42.38-31.541-55.915-15.678 8.846 14.72 26.094c-18.897-4.809-36.244-12.797-51.288-23.295l35.693-30.526-11.7-13.68-91.276 78.061 59.73-108.057-15.754-8.707-19.658 35.563c-9.793-17.905-15.334-37.976-15.334-59.166 0-4.377.289-8.692.758-12.963L122.3 312.33l12.23-13.205-70.332-65.148 90.324 35.625 6.606-16.747-39.461-15.562c6.564-9.908 14.515-18.991 23.607-27.068l6.202 23.013 17.38-4.683L134.36 100.54l75.782 113.088 14.953-10.02-17.852-26.638c14.024-3.857 28.885-6.05 44.387-6.05 9.735 0 19.24.823 28.44 2.388l-30.815 69.144 16.441 7.328zm-109.547 23.16 22.713 47.11c-.568-.005-1.128-.04-1.697-.04-8.26 0-16.382.565-24.338 1.608zm217.264 92.635-35.77 59.455c-4.274-11.718-10.057-22.8-17.158-33.058zM184.005 277.24l35.82 86.406 16.627-6.892-21.21-51.164 61.314 18.709 5.254-17.217z",
  // triceratops-head
  "M197.479 59.813c-5.975-10.707-12.128-21.381-23.147-31.17-3.266 14.104-12.787 25.802-21.957 37.634-3.49-14.265-20.643-19.598-35.787-26.244-1.483 11.404-2.6 22.726-8.158 35.035-7.585-6.947-20.79-9.806-33.328-13.15 3.502 14.433 2.293 29.338 1.242 44.227l-40.453 3.42 19.314 36.359-38.379 22.781 30.363 22.191-30.039 25.538 30.627 15.26-28.494 24.224 25.434 12.672-16.045 22.228c-3.382-.12-6.748-.194-10.088-.207C17.384 357.016 18 426.512 18 494h132.2c22.992-13.75 43.804-28.112 59.321-44.172-32.829-3.25-51.774-9.921-62.783-21.164-24.535-22.661 9.547-47.633 2.143-67.289-4.652-6.38-11.538-7.695-18.635-9.184-36.095 20.677-56.727 35.6-86.781 56.211-1.207-27.584 3.857-56.846 13.139-78.724-7.633-8.89-13.152-19.953-17.084-32.137l20.539 3.447c1.69 3.87 3.584 7.442 5.689 10.69 6.396-8.455 13.321-25.704 23.383-24.194 24.704 3.716 43.28 22.49 50.105 48.262 10.708 2.88 22.655 10.32 26.33 18.879 7.813 23.009-19.866 46.884-5.966 61.445 7.712 7.877 34.521 17.07 94.798 18.102 3.194-.38 4.02.475 6.166 2.592 21.499 17.817 42.34 34.325 67.122 42.613 1.716-24.108-23.276-41.757-40.71-52.389l9.254-15.437c26.32 17.04 56.79 46.733 56.515 79.483 32.58-21.474 32.567-61.684 29.476-92.858a42.244 42.244 0 0 1-14.202-2.53c-9.572-3.47-17.504-9.83-23.279-17.187-5.775-7.357-9.65-15.737-9.603-24.645 0-.037.005-.075.006-.113-1.19-4.784-1.603-9.773-1.41-14.773-3.96-6.207-8.067-13.32-10.633-21.903-49.9 3.927-65.214-41.983-58.28-66.865-41.662-13.957-69.213-54.133-68.21-95.09l17.986.71c2.176 31.16 16.438 59.117 42.582 72.439-34.508-45.38-6.576-103.394-13.322-147.237-3.146-20.442-7.997-42.573-15.65-58.798zm-22.807 21.335c16.791-.124 34.104 3.915 50.771 12.735l-8.418 15.91c-37.802-20.004-77.088-11.273-103.593 16.297-26.505 27.57-39.949 74.495-21.287 132.418l-17.133 5.52c-20.325-63.088-6.065-117.64 25.443-150.413 19.693-20.483 46.23-32.259 74.217-32.467zm279.623 26.79c-63.489 18.759-116.15 42.119-157.936 101.646 34.835-33.685 71.421-52.248 110.155-62.916 14.047-12.303 29.838-24.61 47.78-38.73zm35.478 43.632c-77.59 5.823-141.897 20.993-203.654 95.662-16.245 26.922 4.404 50.691 28.852 52.434 6.183.22 8.903-1.557 9.539-2.777 26.375-50.656 51.76-79.157 83.547-101.057 23.068-15.893 49.298-28.427 81.716-44.262zM91.353 306.408c-14.442 18.208-24.891 43.897-28.546 67.006 18.525-12.726 34.965-23.67 58-36.459-5.15-16.35-15.47-26.778-29.453-30.547zm181.772 19.108-14.082 11.21c-5.925-8.305-14.206-9.836-21.555-7.585l-5.412-17.168c16.261-5.246 31.306 1.66 41.049 13.543zm181.977-6.428c-28.968 16.529-59.9 32.96-99.637 30.66-6.28 18.741 20.989 35.328 36.492 28.281 26.91-15.945 52.604-31.054 63.145-58.941zm-235.498 5.488c14.446 34.744 37.707 36.327 58.095 13.608l13.49 11.918c-28.908 38.081-82.138 14.665-89.394-22.914zm91.44 55.133 15.628 8.934c-3.773 6.087 6.303 9.457 10.334 10.943l-6.094 16.937c-17.03-6.242-28.59-20.687-19.867-36.814z",
  // spiked-dragon-head
  "M188.8 20.38c-5.3 26.85 4.6 55.74 34.1 86.52 11.2-7.29 31.6-10.94 50-8.16-46-22.31-66.5-47.13-84.1-78.36zM29.19 26.62C43.56 73.08 81.09 128.8 129.6 168.3 93.51 166 49.93 153.1 18.76 143c24.96 35.2 64.17 52.9 103.34 66.3C97.13 227 66.99 245 18.66 248c54.64 19.2 107.54 8.9 131.34.7-17.9 34.9-100.72 66.2-122.31 77 53.26 4.2 121.71-11 167.01-32.9 10 24.6-1.6 53.2-10.1 77.8-1.9 4.5-3.8 8.9-5.7 13.3 5.1-3.5 10.1-7 14.9-10.6 23.6-16.2 47.8-31.9 59.5-58.8 26.1 31.2 62.7 62.1 107 85.4 17.4 22.1 28.3 49 34.2 73.8 8.3-19.1 13.8-40.2 9.7-60.3 24.5-3.6 35.6-29.7 35.5-54.4-12.6 6.2-15.1 6.3-31.2 8.2 0-10.1.6-12.5-3-28.7-10.3 8.4-21 11.2-30.8 11.8 2.1-7.6 3-19.5 3.7-27.3-13 7.1-19.2 9.7-30.1 10.8-.4-10.9-.1-20-4.1-30.4-29.6 19-48.6 1.5-68-21.3 19.8-17 96.4-21.8 95.1 7.1 14-7.3 18.8-11.2 23.6-15.9 9.1 8.5 13.4 20.9 15.1 31.4 9.3-9.4 10.3-10.5 17.1-23.8 5.7 10.1 8.8 17 10.7 30.6 8.5-6.2 15.4-13.1 19.8-21.4 7.5 15.5 8.3 16 12.4 33 17.8-13.1 21.8-31.2 22.8-47.6 2-33-.3-108.2-31-142.9 1.7 36.3-13.1 70-33.8 80.7-12.6 4.9-96.5-74.6-137.6-93.3-23.5-10.2-48.1 7.1-67.8 9.3C147 106.2 83.57 70.94 29.19 26.62zM296.1 152.8c13.3 20.9 32.2 36.9 60.1 55-19.4 2.9-65.8-6.7-77.7-24-5.5-7.9 7.1-21.3 17.6-31zM180.6 319.1c-14.4 6.2-29.2 10.9-43.8 14.3-2.4 3.6-4.6 7.1-6.7 10.5 14.8 5.3 31.5 7 44.1 2.8 3.3-9.8 5.5-19.3 6.4-27.6zm-68 19.1-10.2 1.5c-31.81 36.6-61.9 103.2-48.24 151.9h36.13c-11.12-37.7-16.53-87.1 22.31-153.4zm8.5 21.5c-5.9 11.4-10.4 22.1-13.8 32.1 12.9 6.7 29.1 8.9 44.8 8.2 4.6-10.5 9.8-21.8 14.6-33.3-15.4 1.8-31.4-1.4-45.6-7zm111.4 6.6c-12 10.5-25.2 20.3-38.9 29.6 7 34 33.4 63.4 73.9 95.7h83.3c-57.2-31.8-94.6-73.3-118.3-125.3zm-130 43.2c-2.5 11.8-3.3 22.7-3 32.9 37.3 14.2 62.5 13.5 97.5 4.1-7.2-10.3-13-21-16.9-32.3-32.7 9.4-55.4 5.7-77.6-4.7zm106.6 52.4c-38.1 10.9-68.8 13.2-107.5.3 1.8 10.4 4.5 20.1 7.5 29.4h130.1c-11.3-9.8-21.4-19.6-30.1-29.7z",
  // unicorn
  "M494 20 304.887 143.357c16.494 14.608 32.743 22.57 44.963 36.97zM298.346 93.594c-12.58.436-26.59 4.984-38.047 11.77-7.64 4.523-14.115 9.97-18.304 15.142-4.19 5.173-5.79 9.832-5.648 12.668l.283 5.73-5.075 2.676C133.713 193.16 80.945 250.727 18 310.594V494h166.047c6.145-15.424 12.724-33.898 15.086-47.535 1.728-9.977-2.783-21.807-8.23-35.244-5.444-13.436-11.85-28.706-7.63-45.423 3.49-13.827 14.375-25.752 24.096-35.656 4.45-4.534 8.71-8.463 12.075-11.445-6.558-8.577-14.065-20.315-16.51-34.894l17.75-2.978c2.68 15.976 15.203 28.533 22.8 39.24l-.323.23c10.54 14.634 18.892 28.395 30.72 37.546 13.358 10.337 31.484 16.39 66.526 11.49l6.658-.932 2.782 6.124c6.96 15.322 14.372 23.89 21.015 28.423 6.643 4.535 12.63 5.46 18.692 4.79 12.125-1.34 24.29-10.974 27.76-14.264 4.13-3.92 9.657-9.476 13.32-16.124 3.347-6.076 5.073-12.687 3.48-20.744-42.68-37.562-69.592-108.75-90.256-152.6-9.245-19.62-35.786-34.492-52.967-47.95-2.427-1.4-2.675-2.582-3.24-5.154-4.215-19.167 3.188-40.257 10.974-57.298-.096.002-.186-.01-.28-.006zM59.352 136.55c17.863 4.925 37.775 9.665 57.406 14.815 14.803 3.883 29.26 7.935 42.406 12.766 17.914-12.178 37.407-24.123 59.072-35.77-51.62-13.3-109.928-3.148-158.884 8.19zm28.738 26.126c-23.002 4.133-45.974 10.254-67.147 16.662 18.133 3.813 38.298 7.314 58.207 11.242 11.774 2.323 23.337 4.766 34.256 7.643a686.475 686.475 0 0 1 27.403-21.15c-9.044-2.932-18.71-5.698-28.62-8.298-7.952-2.086-16.043-4.098-24.1-6.1zM47.44 202.94c-9.875 2.096-19.728 4.582-29.44 7.29v18.04a2251.165 2251.165 0 0 1 20.172 3.146c10.505 1.7 20.847 3.498 30.734 5.625 8.836-8.185 17.887-16.322 27.268-24.397-6.64-1.56-13.52-3.024-20.508-4.403-9.32-1.838-18.81-3.566-28.227-5.3zM304 224c8.837 0 16 7.163 16 16s-7.163 16-16 16-16-7.163-16-16 7.163-16 16-16zM18 246.512v26.58c4.16.195 8.28.425 12.342.71 7.44-7.2 14.878-14.384 22.387-21.538a604.747 604.747 0 0 0-17.433-3.078A1501.67 1501.67 0 0 0 18 246.512z",
  // troglodyte
  "m234.2 17.22-3.5 61.22c9-2.52 18.4-4.75 28-6.67zm63 7.82 11 109.96c9.7 10.9 49-1 44.2-13.7zm-164.6 2.63 37 108.13c5.4 6.8 13.8 3 18.6-.9 7.7-6.4 14.2-18.8 13.7-32.5zm297.1 1.1L405 70.74c8.3 3.28 16.4 7.64 24 12.94zm-79.5 52.51 18.6 32.42.2.5c4 9.8.1 20.2-6.1 27-6.3 6.7-14.8 11.5-23.9 14.5-9.1 3-18.8 4.3-27.9 2.3-9.1-2-18.2-8.8-20.6-19.3l-.1-.6-5.3-52.61c-23.4 3.27-45.2 8.35-65.3 15.01 1.4 20-7.6 37.8-20.1 48.2-6.6 5.5-14.4 9.1-22.8 9.1-8.4-.1-17.1-4.5-22.6-12.4-2.2-3.5-3.1-7.7-4.4-11.6-16.6 10.9-31.1 23.1-43.5 36.4 15.8 15.1 9.8 48.2-.4 62.5-5.1 6.8-11.78 12.2-19.98 14.2-7.6 1.8-16.22-.1-23.24-5.3-22.44 64.8-7.41 138.4 51.92 199.6 1.9-15.1 3.3-32.7 5.3-50.9-13.2-12.3-24.28-26.7-30.68-45.1l16.98-6c21 41.8 58.4 61.9 91.5 83.4-20.4 29.3-51.8 50.6-76.6 68.7l179.6 3.5c-44.5-16.9-88.4-16.3-140.4-17.1l27-16.2c18.1-10.9 39.6-29.9 49.9-41.3-23.3-36.9-49.5-57.9-82.4-75.4l6.6-8.5c12.7-16.1 28.7-40.7 40.2-64.2 11.7-24.5 10.8-45.3 18.6-68.1l17 5.8c-11.1 32-10.3 57.9-1.6 88.4l48.8 45.8 13 43.4 5.2-22.8 44.5 18.5-30.7-32.6 34.5-7.9-48.7-4.8-37.3-43.5c10.6-18 10.2-38.4 7.1-54.8l17.6-3.6c1.9 9.3 3.2 19.1 2.8 29.1 22.7 8.1 45.2 20.3 65.7 26.2 21.3 6.1 40.3 6.8 52.9-4 7.2-6.2 13.6-12.4 19.3-18.6-24.2-4.1-55.3-5.1-81.1-1.7l-2.4-17.8c32.6-3.6 65.8-3.2 96.4 3.6 26.6-37.1 27.4-73 15.9-102.7-15-38.8-53.3-66.63-86.1-68.17-7.8-.36-15.4-.52-22.9-.55zM84.02 90.97l20.38 55.73c6.1-5.6 12.5-11.1 19.3-16.3zM45.74 134.5 74.72 228c21.59 7.7 25.23-31.6 22.2-41.9zM214.4 286.9c-9.8 19-21.7 37.5-32.6 52.3 33.7 24 62.9 50.6 76.5 83.9-12 15-26.7 28.4-39.5 38.3 5.5.4 10.9.9 16.1 1.5 23.3-8.3 56.9-26.6 53.1-43.2-9.1-39.4-44.5-63-74.6-79.2 6.3-21.2 4.8-34.6 1-53.6zM403 381.6l5.2-24.2 47 25.1-29.3-37.1 30.6-8.6-56.1-5.5c-2.7-6.5-5.5-8.9-10.1-17.9-11.5.8-23.4-1.1-34.8-4.2l34.8 35.1z",
  // wood-club
  "M483.424 24.638 449.83 39.98c.944.974 1.864 1.99 2.754 3.068 3.544 4.29 6.546 8.89 9.07 13.745l21.77-32.155zm-221.18 14.426 4.217 42.527c7.223-6.983 14.875-13.594 22.97-19.575l-27.186-22.95zm143.17 2.358c-2 .03-4.06.133-6.18.298-11.58.906-24.367 3.983-37.02 7.41l23.55 36.178.404.62.297.68c3.1 7.08 2.3 14.488-.006 21.41-2.308 6.924-6.405 13.565-12.487 18.53-6.082 4.962-14.756 8.037-23.813 6.118-9.056-1.92-17.6-8.213-25.506-18.803l-1.718-2.305-1.104-48.535c-25.135 12.94-47.54 34.326-66.178 57.047l17.14 9.428 2.892 1.59 1.177 3.08c4.892 12.782 5.147 26.122-1.43 37.13-6.575 11.01-18.66 18.744-35.435 24.293l-6.9 2.285-11.653-19.82c-1.71 3.762-3.41 7.56-5.093 11.43L199.126 298.11l-2.75-61.597c-10.444 24.205-21.82 48.42-36.09 70.063C119.643 368.216 28.322 462.01 28.322 462.01l-.07.072-.07.07c-3.905 3.85-3.91 5.573-3.475 7.693.29 1.418 1.348 3.368 3.168 5.43l97.166-78.713-84.007 87.3c5.778 2.305 11.906 3.587 15.895 3.495 6.885-6.482 66.713-62.5 107.11-88.644 38.117-24.67 69.79-54.084 106.32-82.045l12.213-70.723.37-2.147 1.312-1.74c6.783-8.997 15.585-14.236 24.506-15.33a31.905 31.905 0 0 1 6.588-.113c6.464.56 12.5 3.047 17.584 6.59 11.895 8.287 20.172 22.808 18.008 37.68 6.76-3 13.436-6.003 19.883-9.153 20.67-10.1 38.705-21.33 51.063-37.56-7.023-.544-13.58-3.672-19.03-7.846-7.455-5.707-13.412-13.558-17.25-22.2-3.84-8.64-5.723-18.287-2.974-27.615 2.75-9.326 11.142-17.274 22.833-20.01l.645-.153 45.662-3.797c.92-5.208 1.667-10.42 2.19-15.58 1.022-10.1 1.175-19.927.35-29.187l-28.927 31.25 19.88-64.613c-1.88-3.562-4.056-6.88-6.556-9.907-7.064-8.55-16.195-12.217-27.474-12.957a72.25 72.25 0 0 0-5.82-.134zm-65.937 5.773 1.316 57.93c5.447 6.628 10.038 9.285 13.098 9.933 3.385.717 5.85-.13 8.702-2.457 2.852-2.327 5.483-6.348 6.79-10.272 1.253-3.757 1.01-7.105.624-8.23l-30.53-46.903zm-136.057 64.69 37.62 63.984c10.068-4.252 16.137-9.108 18.94-13.802 3.017-5.05 3.41-10.74.962-18.547l-57.522-31.636zm284.063 45.76-78.336 6.513c-6.528 1.622-8.23 3.973-9.252 7.443-1.05 3.558-.457 9.338 2.156 15.218 2.614 5.88 7.085 11.648 11.745 15.217 4.102 3.14 7.867 4.322 10.924 4.105.6-.433 1.22-.876 2.16-1.576a960.486 960.486 0 0 0 10.226-7.758c8.388-6.43 19.428-14.995 30.408-23.547 10.038-7.82 12.08-9.442 19.97-15.616zM312.38 244.497c-.48.007-.957.04-1.43.097-3.424.42-7.092 2.18-11.067 6.868l-16.496 95.523 49.18-76.508c2.014-7.113-2.495-17.326-9.926-22.504-2.873-2.002-5.883-3.162-8.806-3.422a14.095 14.095 0 0 0-1.453-.054zm74.02 29.52a328.805 328.805 0 0 1-7.677 3.886c-5.127 2.505-10.308 4.887-15.488 7.232l27.76 17.047-4.594-28.166z",
  // pitchfork
  "m105.9 19 25.7 58.8c.7.1 1.9.26 3.9 0 4.7-.57 11.8-2.8 18.5-5.87 6.6-3.07 13-7.02 16.8-10.3 1.5-1.33 2.2-2.27 2.7-2.96L156.2 19h-50.3zm75.3 57.39c-5.6 4.5-12.4 8.53-19.7 11.88-7.4 3.39-15 6.05-22.2 7.16l16.3 37.47 25.8 1.3 16.4-19.7-16.6-38.11zm110.1 18.32c-19.5-.35-46.8 5.79-75.6 15.59l3.1 7.2-26.5 31.7-2.9 3.4-45.8-2.3-3.3-7.5c-44.48 23.5-78.61 50.6-74.43 69C102.8 337 168.3 448.5 226 496.7l11.5-13.8c-51-42.7-115.5-149.4-152.01-268.6L127.5 196c37.4 121.2 101 228.2 157.2 275.1l11.5-13.8C245.1 414.6 180.6 308 144 188.8l42.1-18.4c37.4 121.2 101 228.2 157.3 275.1l11.4-13.8c-51-42.7-115.6-149.3-152.1-268.5l42.1-18.4C282.2 266 345.8 373 402 419.9l11.5-13.8c-51-42.7-115.6-149.3-152.1-268.5l42.1-18.4c37.4 121.1 101 228.3 157.2 275.1l11.4-13.8C420 336.9 353.8 226.6 317.7 104.4c-4.3-6.49-13.7-9.47-26.4-9.69z",
  // vampire-dracula
  "M256 19c-47.103.059-104.37 1.514-134.777 35.078-19.272 22.051-22.113 59.34-22.141 91.55-.013 15.25.89 29.319 1.84 40.03 3.42 2.125 6.765 3.998 10.168 5.508 1.906-6.213 4.188-12.19 6.889-17.853a411.19 411.19 0 0 1-.897-27.668c.004-4.162.11-8.397.309-12.645H128v-18h-9.143a200.21 200.21 0 0 1 2.141-14H144V83h-18.324c2.45-7.015 5.462-12.914 9.101-17.078 30.825-28.62 70.834-28.757 108.229-28.904L256 76l12.994-38.982c36.423.166 84.794 3.054 108.229 28.904 3.639 4.164 6.652 10.063 9.101 17.078H368v18h23.002c.862 4.51 1.573 9.203 2.14 14H384v18h10.61c.197 4.248.304 8.483.308 12.645a411.356 411.356 0 0 1-.897 27.667c2.701 5.664 4.983 11.64 6.89 17.854 3.402-1.51 6.748-3.383 10.167-5.508.95-10.711 1.853-24.78 1.84-40.03-.028-32.21-2.869-69.499-22.14-91.55C352.365 17.425 303.361 18.985 256 19zm-91.682 128.897C132.974 165.035 121 205.545 121 252v48c2.884 29.924 30.052 42.574 48 60.271V444c0 4.935 2.352 9.45 7.75 14.36 20.432 15.936 53.229 24.47 79.21 24.64h.04c28.357-3.426 58.33-5.59 79.395-24.613C340.683 453.505 343 449 343 444v-83.729c18.205-18.5 47.537-34.698 48-60.271v-48c0-46.455-11.974-86.965-43.318-104.104-11.741-6.42-25.102-6.616-40.256-2.98-19.464 5.613-35.334 13.104-51.426 21.147-17.188-7.926-35.068-17.077-51.426-21.147-13.699-3.296-28.23-3.457-40.256 2.98zm-106.84 34.318c1.809 22.782 8.967 56.005 18.95 82.625 5.798 15.461 12.661 28.809 18.986 36.398 3.162 3.795 6.131 6.012 6.967 5.13.835-.883.619-3.576.619-6.368v-48c0-14.72 1.138-29.342 3.768-43.207-9.004-3.482-16.74-8.624-23.76-13.305-8.927-5.95-16.756-11.044-25.53-13.273zm397.043 0c-8.773 2.23-16.602 7.322-25.529 13.273-7.02 4.68-14.756 9.823-23.76 13.305C407.862 222.658 409 237.281 409 252v48c0 2.792-.216 5.485.62 6.367.835.883 3.804-1.334 6.966-5.129 6.325-7.59 13.188-20.937 18.986-36.398 9.983-26.62 17.141-59.842 18.95-82.625zM176 207.27l70.363 70.366-10.32 10.32C238.517 292.391 240 296.565 240 300h-96c0-16 16-48 48-48 1.182 0 2.46.194 3.797.523L176 232.727l-25.637 25.636-12.726-12.726zM192 300c8.837 0 16-7.163 16-16s-7.163-16-16-16-16 7.163-16 16 7.163 16 16 16zm144-92.729 38.363 38.366-12.726 12.726L336 232.727l-19.797 19.796c1.337-.33 2.615-.523 3.797-.523 32 0 48 32 48 48h-96c0-3.435 1.483-7.609 3.957-12.043l-10.32-10.32zM320 300c8.837 0 16-7.163 16-16s-7.163-16-16-16-16 7.163-16 16 7.163 16 16 16zm-203.393 36.496c-28.117 11.146-58.94 25.26-93.828 42.373 39.48 16.026 70 37.572 90.092 61.317 14.463 17.092 23.58 35.612 26.248 53.814h70.611c-16.114-4.813-33.438-11.931-45.091-22.324C156.82 464.566 151 455.065 151 444v-76.002c-12.82-11.535-24.674-19.302-34.393-31.502zm278.786 0c-9.543 12.279-23.267 21.558-34.393 31.502V444c0 11-5.683 20.495-13.395 27.613-14.023 11.575-28.946 17.825-44.95 22.387h70.226c2.667-18.202 11.785-36.722 26.248-53.814 20.092-23.745 50.613-45.29 90.092-61.317-34.889-17.114-65.71-31.227-93.828-42.373zm-165.784 4.467c7.613 4.7 16.541 13.529 26.391 14.037 10.283-2.687 17.928-7.524 26.39-14.037l11.22 14.074C282.997 362.708 267.95 372.778 256 373c-14.83-1.544-26.226-9.059-37.61-17.963zm-31.293 48.625L211.93 403h88.433l13.25-13.342 12.774 12.684L307.855 421H301l-13 39-13-39h-38l-13 39-13-39h-6.447l-18.87-18.588z",
  // overlord-helm
  "M183.188 20.107c-19.58 65.304-41.643 129.72-30.362 186.127l.352 1.766-16.03 80.148 15.366 92.19L234.17 488.36l12.03-83.46L224 416c-16-32-16-64 0-80l-48-16v-64c10.394 10.394 34.29 27.534 54.146 38.273l-15.564-54.478.69-2.072-31.51-9.002-.575-208.613zM329 22.81v205.694l-32.27 9.22.688 2.07-15.564 54.48C301.71 283.533 325.606 266.393 336 256v64l-48 16c16 16 16 48 0 80l-22.21-11.104 12.048 84.32 81.644-108.86 15.37-92.208L358.822 208l.352-1.766C370.278 150.712 348.196 87.226 329 22.81zm-73 49.75-7 56v64.9l-15.582 46.745L256 319.238l22.582-79.033L263 193.46v-64.9l-7-56zm25 110.89v7.09l10.03 30.09 19.97-5.704v-17.322c-12.287-6.115-21.97-10.802-30-14.153zm-50 .005c-7.888 3.29-17.36 7.866-29.324 13.815l.05 17.863 19.243 5.498L231 190.54v-7.085zM192 288v16l32 16-32-32zm128 0-32 32 32-16v-16zM25.97 372.31c-4.88 23.452-7.363 47.226-4 72.872 10.904-5.418 22.286-8.96 33.968-10.907-12.438-17.27-22.396-38.742-29.97-61.966zm460.01 0c-7.575 23.223-17.532 44.695-29.97 61.965 11.68 1.947 23.063 5.49 33.97 10.907 3.36-25.646.877-49.42-4-72.873zm-396.01 9.833c-3.055 14.682-5.173 29.488-5.51 44.8 5.497-4.264 11.312-8.804 18.14-12.713-4.768-10.11-8.98-20.89-12.63-32.087zm332.01 0c-3.653 11.196-7.865 21.977-12.632 32.087 6.828 3.91 12.642 8.45 18.138 12.713-.336-15.312-2.453-30.118-5.507-44.8zm-290.37 41.654c-7.614.14-13.588 2.403-19.616 5.793-5.165 2.904-10.355 6.87-15.77 11.033l106.108 63.19-63.082-79.325c-2.088-.296-4.228-.656-6.094-.69-.523-.01-1.037-.01-1.545 0zm247.183 0c-1.866.035-4.007.394-6.096.69l-63.084 79.33 106.112-63.194c-5.415-4.163-10.607-8.13-15.772-11.033-6.43-3.616-12.796-5.95-21.16-5.793zm-301.2 26.69c-21.304.15-40.785 5.3-58.886 17.447l4.56 19.586 132.567 9.953-60.994-36.627.115-.03-8.922-5.312.008.058-8.448-5.074zm356.764 0-8.45 5.077.007-.06-8.922 5.312.117.03-60.997 36.63 132.57-9.956 4.557-19.586c-18.1-12.148-37.58-17.298-58.883-17.446z"
];

function rollPlaceholderIcon() {
  const d = PLACEHOLDER_ICONS[Math.floor(Math.random() * PLACEHOLDER_ICONS.length)];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
    '<path fill="#565663" d="' + d + '"/></svg>';
  // Kept around: a track with no cover of its own falls back to it too.
  placeholderIcon = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  if (artwork) artwork.style.backgroundImage = placeholderIcon;
}

rollPlaceholderIcon();

// A different colour every visit and every roll - the moon is not the same moon twice.
// Hue only: saturation and lightness stay put so it is always bright enough to read
// white text on, whichever colour comes up.
function rollRadioColour() {
  if (radioBtn) radioBtn.style.setProperty("--h", String(Math.floor(Math.random() * 360)));
}

rollRadioColour();

radioBtn?.addEventListener("click", () => {
  rollRadioColour();
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
  if (!radioMode) return;
  radioMode = false;
  radioBag = [];
  updateModeButtons();
}

// --- likes ------------------------------------------------------------------------

function toggleLike(post) {
  const master = posts.find((p) => p.message_id === post.message_id);
  if (!master) return;
  master.liked = !master.liked;
  if (master.liked) userData.post_likes[String(post.message_id)] = true;
  else delete userData.post_likes[String(post.message_id)];
  saveUserData();
  // Under the "liked" filter the card itself appears or disappears, so the list has to
  // be rebuilt; otherwise only one button changed.
  if (filterMode === "liked") {
    renderPostList();
    return;
  }
  const btn = postListEl.querySelector(`.like-btn[data-post-id="${post.message_id}"]`);
  if (btn) {
    btn.classList.toggle("liked", master.liked);
    btn.title = master.liked
      ? "Убрать лайк (хранится только в этом браузере)"
      : "Лайкнуть пост (сохранится только в этом браузере)";
  }
}

// --- categories ---------------------------------------------------------------

function setTrackCategory(track, catId, checked) {
  // Update local state immediately (optimistic) rather than in the fetch callback -
  // otherwise a click elsewhere just after toggling a checkbox can trigger a re-render
  // before the request resolves, and the change would silently not show up yet.
  const cats = new Set(track.categories);
  if (checked) cats.add(catId);
  else cats.delete(catId);
  track.categories = Array.from(cats);
  popoverNeedsRerender = true;
  userData.track_categories[track.id] = track.categories;
  saveUserData();
}

function togglePostCategory(post, catId, checked) {
  // `post` here may be the filtered view (active list) - always bulk-apply against the
  // full, unfiltered track list of the post, not just what's currently visible.
  const master = posts.find((p) => p.message_id === post.message_id) || post;
  master.tracks.forEach((t) => {
    const cats = new Set(t.categories);
    if (checked) cats.add(catId);
    else cats.delete(catId);
    t.categories = Array.from(cats);
  });
  popoverNeedsRerender = true;
  master.tracks.forEach((t) => (userData.track_categories[t.id] = t.categories));
  saveUserData();
}

function postCategoryChecked(post, catId) {
  const master = posts.find((p) => p.message_id === post.message_id) || post;
  return master.tracks.length > 0 && master.tracks.every((t) => t.categories.includes(catId));
}

function countTracksInCategory(catId) {
  let n = 0;
  posts.forEach((p) => p.tracks.forEach((t) => { if (t.categories.includes(catId)) n++; }));
  return n;
}

function deleteCategory(catId) {
  const cat = categories.find((c) => c.id === catId);
  const usedBy = countTracksInCategory(catId);
  if (usedBy > 0) {
    const label = cat ? `«${cat.name}»` : "эта категория";
    const trackWord = usedBy === 1 ? "трек" : usedBy < 5 ? "трека" : "треков";
    const ok = confirm(`Категория ${label} назначена ${usedBy} ${trackWord}. Удалить её всё равно?`);
    if (!ok) return;
  }
  categories = categories.filter((c) => c.id !== catId);
  userData.categories = categories;
  posts.forEach((p) =>
    p.tracks.forEach((t) => {
      t.categories = t.categories.filter((c) => c !== catId);
      userData.track_categories[t.id] = t.categories;
    })
  );
  selectedCategoryIds.delete(catId);
  saveUserData();
  saveUiPrefs();
  renderCategoryManager();
  renderCategoryFilterChips();
  renderPostList();
}

categoryManagerToggle?.addEventListener("click", () => {
  categoryManagerBody.hidden = !categoryManagerBody.hidden;
  categoryManagerToggle.textContent = categoryManagerBody.hidden ? "Категории ▾" : "Категории ▴";
});

categoryCreateForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = categoryNameInput.value.trim();
  if (!name) return;
  const cat = { id: "c" + Date.now().toString(36), name };
  categories.push(cat);
  userData.categories = categories;
  saveUserData();
  categoryNameInput.value = "";
  renderCategoryManager();
  renderCategoryFilterChips();
});

function renderCategoryManager() {
  categoryManageListEl.innerHTML = "";
  if (!categories.length) {
    const hint = document.createElement("span");
    hint.className = "label";
    hint.textContent = "пока нет категорий";
    categoryManageListEl.appendChild(hint);
    return;
  }
  categories.forEach((cat) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = cat.name;
    const del = document.createElement("span");
    del.className = "del-cat";
    del.textContent = " ×";
    del.title = "Удалить категорию";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteCategory(cat.id);
    });
    chip.appendChild(del);
    categoryManageListEl.appendChild(chip);
  });
}

function renderCategoryFilterChips() {
  categoryFilterEl.hidden = filterMode !== "categories";
  categoryFilterEl.innerHTML = "";
  categories.forEach((cat) => {
    const chip = document.createElement("span");
    chip.className = "chip" + (selectedCategoryIds.has(cat.id) ? " selected" : "");
    chip.textContent = cat.name;
    chip.addEventListener("click", () => {
      if (selectedCategoryIds.has(cat.id)) selectedCategoryIds.delete(cat.id);
      else selectedCategoryIds.add(cat.id);
      saveUiPrefs();
      shownCount = PAGE_SIZE;
      renderCategoryFilterChips();
      renderPostList();
    });
    categoryFilterEl.appendChild(chip);
  });
}

// --- category picker popover ---------------------------------------------------
// Anchored via a stable data-key + re-queried by that key on open, rather than a
// captured DOM node, because a pending toggle flushes a full re-render (see
// closePopover) which would otherwise leave the reference stale/detached.

function closePopover() {
  if (openPopoverEl) openPopoverEl.remove();
  openPopoverEl = null;
  openPopoverKey = null;
  if (popoverNeedsRerender) {
    popoverNeedsRerender = false;
    renderPostList();
  }
}

function openCategoryPopover(key, handlers) {
  const wasOpenSameKey = openPopoverKey === key;
  closePopover();
  if (wasOpenSameKey) return;

  const wrap = document.querySelector(`[data-cat-wrap="${CSS.escape(key)}"]`);
  if (!wrap) return;

  const pop = document.createElement("div");
  pop.className = "cat-popover";
  if (!categories.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Сначала создайте категорию";
    pop.appendChild(empty);
  }
  categories.forEach((cat) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = handlers.isChecked(cat.id);
    cb.addEventListener("change", () => handlers.onToggle(cat.id, cb.checked));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(cat.name));
    pop.appendChild(label);
  });
  wrap.appendChild(pop);
  openPopoverEl = pop;
  openPopoverKey = key;
}

document.addEventListener("click", (e) => {
  if (openPopoverEl && !openPopoverEl.contains(e.target)) {
    closePopover();
  }
});

// --- rendering ------------------------------------------------------------------

function renderPostList() {
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
  updateFeedTail(active);
  topUpFeed();
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

function updateFeedTail(active) {
  const shown = Math.min(shownCount, active.length);
  if (listInfoEl) {
    listInfoEl.textContent = active.length
      ? `${shown} из ${active.length} постов`
      : "Постов пока нет";
  }
  if (feedEndEl) feedEndEl.hidden = !active.length || shown < active.length;
}

function appendMorePosts() {
  const active = computeActiveList();
  if (shownCount >= active.length) return false;
  const from = shownCount;
  shownCount = Math.min(shownCount + PAGE_SIZE, active.length);
  appendCards(active, from, shownCount);
  updateFeedTail(active);
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

let feedTickScheduled = false;
function onFeedScroll() {
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
    link.addEventListener("click", (e) => e.stopPropagation());
    dateEl.appendChild(link);
  }
  header.appendChild(dateEl);

  const actions = document.createElement("div");
  actions.className = "post-actions";

  if (post.message_id != null) {
    const likeBtn = document.createElement("button");
    likeBtn.className = "like-btn" + (post.liked ? " liked" : "");
    likeBtn.dataset.postId = post.message_id;
    likeBtn.textContent = "👍";
    likeBtn.title = post.liked
      ? "Убрать лайк (хранится только в этом браузере)"
      : "Лайкнуть пост (сохранится только в этом браузере)";
    likeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLike(post);
    });
    actions.appendChild(likeBtn);

    const wrap = document.createElement("span");
    wrap.className = "cat-btn-wrap";
    wrap.dataset.catWrap = `post:${post.message_id}`;
    wrap.addEventListener("click", (e) => e.stopPropagation());
    const catBtn = document.createElement("button");
    catBtn.className = "post-cat-btn";
    catBtn.type = "button";
    catBtn.textContent = "+";
    catBtn.title = "Весь пост в категорию";
    catBtn.addEventListener("click", () => {
      openCategoryPopover(`post:${post.message_id}`, {
        isChecked: (catId) => postCategoryChecked(post, catId),
        onToggle: (catId, checked) => togglePostCategory(post, catId, checked),
      });
    });
    wrap.appendChild(catBtn);
    actions.appendChild(wrap);
  }
  header.appendChild(actions);
  card.appendChild(header);

  if (post.message_text) {
    const textEl = document.createElement("div");
    textEl.className = "post-text";
    textEl.textContent = post.message_text;
    card.appendChild(textEl);
  }

  post.tracks.forEach((track) => card.appendChild(renderTrackRow(post, track)));

  return card;
}

function renderTrackRow(post, track) {
  const row = document.createElement("div");
  const isPlaying = current && current.trackId === track.id;
  row.className = "track-row" + (isPlaying ? " playing" : "");
  row.dataset.trackId = track.id;

  const img = document.createElement("img");
  img.src = track.thumbnail || "";
  row.appendChild(img);

  const meta = document.createElement("div");
  meta.className = "meta";
  const titleEl = document.createElement("div");
  titleEl.className = "title";
  titleEl.textContent = track.title;
  meta.appendChild(titleEl);
  const artistEl = document.createElement("div");
  artistEl.className = "artist";
  artistEl.textContent = track.artist || "";
  meta.appendChild(artistEl);

  if (track.categories.length) {
    const catsEl = document.createElement("div");
    catsEl.className = "cats chip-row";
    track.categories.forEach((cid) => {
      const cat = categories.find((c) => c.id === cid);
      if (!cat) return;
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = cat.name;
      chip.title = "Убрать из категории";
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        setTrackCategory(track, cid, false);
        chip.remove();
      });
      catsEl.appendChild(chip);
    });
    meta.appendChild(catsEl);
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
  buy.addEventListener("click", (e) => e.stopPropagation());
  row.appendChild(buy);

  const wrap = document.createElement("span");
  wrap.className = "cat-btn-wrap";
  wrap.dataset.catWrap = `track:${track.id}`;
  wrap.addEventListener("click", (e) => e.stopPropagation());
  const catBtn = document.createElement("button");
  catBtn.className = "track-cat-btn";
  catBtn.type = "button";
  catBtn.textContent = "+";
  catBtn.title = "Категории трека";
  catBtn.addEventListener("click", () => {
    openCategoryPopover(`track:${track.id}`, {
      isChecked: (catId) => track.categories.includes(catId),
      onToggle: (catId, checked) => setTrackCategory(track, catId, checked),
    });
  });
  wrap.appendChild(catBtn);
  row.appendChild(wrap);

  row.addEventListener("click", () => {
    stopRadio();
    playNewRef({ messageId: post.message_id, trackId: track.id });
  });

  return row;
}

// --- sort / filter toolbar ------------------------------------------------------

// Two dropdowns for five states was more form than the page needed; these say the same
// thing in the same visual language as the rest of the controls.
function syncToolbar() {
  if (sortBtn) {
    sortBtn.textContent = sortOrder === "new" ? "↓" : "↑";
    sortBtn.title = sortOrder === "new" ? "Сначала новые" : "Сначала старые";
  }
  filterBtns.forEach((b) => b.classList.toggle("active", b.dataset.filter === filterMode));
}

sortBtn?.addEventListener("click", () => {
  sortOrder = sortOrder === "new" ? "old" : "new";
  saveUiPrefs();
  shownCount = PAGE_SIZE;
  syncToolbar();
  renderPostList();
});

filterBtns.forEach((btn) =>
  btn.addEventListener("click", () => {
    filterMode = btn.dataset.filter;
    saveUiPrefs();
    shownCount = PAGE_SIZE;
    syncToolbar();
    renderCategoryFilterChips();
    renderPostList();
  })
);

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
    syncToolbar();
    updateModeButtons();

    loadUserData();
    loadCategories();
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
    renderCategoryManager();
    renderCategoryFilterChips();
    renderPostList();
  } catch (e) {
    console.error(e);
    showFailure(
      "Список не отрисовался",
      "Обнови страницу принудительно: Ctrl+Shift+R на компьютере, потянуть вниз на телефоне."
    );
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
