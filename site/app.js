const audio = document.getElementById("audio");
const nowTitle = document.getElementById("now-title");
const nowArtist = document.getElementById("now-artist");
const artwork = document.getElementById("artwork");
const playerEl = document.querySelector(".player");
const playBtn = document.getElementById("play-btn");
const seekEl = document.getElementById("seek");
const timeCurrentEl = document.getElementById("time-current");
const timeTotalEl = document.getElementById("time-total");
const muteBtn = document.getElementById("mute-btn");
const postContextEl = document.getElementById("post-context");
const postContextLinkEl = document.getElementById("post-context-link");
const postContextTextEl = document.getElementById("post-context-text");
const prevPostBtn = document.getElementById("prev-post-btn");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const nextPostBtn = document.getElementById("next-post-btn");
const radioBtn = document.getElementById("radio-btn");
const repeatBtn = document.getElementById("repeat-btn");
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
const feedSentinelEl = document.getElementById("feed-sentinel");
const feedEndEl = document.getElementById("feed-end");

const UI_PREFS_KEY = "rd_player_prefs_v1";
const PAGE_SIZE = 20; // posts appended per step - the channel has thousands of tracks,
// so rendering the whole filtered list at once would make the page unusably heavy.

let posts = [];
let categories = [];

let sortOrder = "new"; // 'new' | 'old'
let filterMode = "all"; // 'all' | 'liked' | 'categories'
let selectedCategoryIds = new Set();
let repeatMode = "none"; // 'none' | 'post' | 'track'
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
    if (p.repeatMode) repeatMode = p.repeatMode;
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
        repeatMode,
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

async function loadPosts() {
  // no-store: the file is rewritten every few hours with fresh stream urls, and a
  // cached copy would hand the player links that have already expired.
  const res = await fetch("data/posts.json", { cache: "no-store" });
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
  if (timeCurrentEl) timeCurrentEl.textContent = "0:00";
  audio.play();
  updateNowPlaying(track);
  revealCurrentPage();
  renderPostList();
}

function revealCurrentPage() {
  if (!current) return;
  const active = computeActiveList();
  const idx = active.findIndex((p) => String(p.message_id) === String(current.messageId));
  // Chaos Radio happily picks a track eight hundred posts down; grow the feed far
  // enough that the row it is playing actually exists on the page.
  if (idx !== -1 && idx >= shownCount) {
    shownCount = Math.ceil((idx + 1) / PAGE_SIZE) * PAGE_SIZE;
  }
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
    artwork.src = track.thumbnail;
    artwork.classList.remove("empty");
  } else {
    artwork.removeAttribute("src");
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

  const effectiveRepeat = repeatMode === "track" ? "none" : repeatMode;

  if (effectiveRepeat === "post") {
    const postTracks = tracksOfPostFromActive(active, current.messageId);
    if (postTracks.length) {
      const idx = postTracks.findIndex((r) => r.trackId === current.trackId);
      return postTracks[(idx + 1) % postTracks.length];
    }
    return flat[0]; // current post fell out of the filtered list
  }

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

function neighborPost(delta) {
  const active = computeActiveList();
  if (!active.length) return null;
  let idx = current ? active.findIndex((p) => String(p.message_id) === String(current.messageId)) : -1;
  if (idx === -1) idx = delta > 0 ? -1 : 0;
  let newIdx = (idx + delta + active.length) % active.length;
  return active[newIdx];
}

function goToPost(delta) {
  stopRadio();
  const post = neighborPost(delta);
  if (!post || !post.tracks.length) return;
  playNewRef({ messageId: post.message_id, trackId: post.tracks[0].id });
}

// --- transport ---------------------------------------------------------------------
// The browser's own <audio controls> is a white pill that cannot be themed the same way
// twice across browsers, so the element stays as the engine and these drive it.

let seeking = false; // user is dragging: don't fight them with timeupdate

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

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
    if (timeCurrentEl) timeCurrentEl.textContent = "0:00";
    if (timeTotalEl) timeTotalEl.textContent = "0:00";
    return;
  }
  if (!seeking) paintSeek(audio.currentTime / audio.duration);
  if (timeCurrentEl) timeCurrentEl.textContent = formatTime(audio.currentTime);
  if (timeTotalEl) timeTotalEl.textContent = formatTime(audio.duration);
}

function syncPlayButton() {
  if (!playBtn) return;
  const playing = !audio.paused && !audio.ended;
  playBtn.textContent = playing ? "⏸" : "▶";
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
  if (timeCurrentEl && isFinite(audio.duration)) {
    timeCurrentEl.textContent = formatTime(fraction * audio.duration);
  }
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

audio.addEventListener("ended", () => {
  if (repeatMode === "track") {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  nextTrack();
});
audio.addEventListener("error", async () => {
  if (!current) return;
  // A link past its 24h expiry fails exactly like a dropped connection, so try one
  // data refresh before writing the track off - the rebuild may already have run.
  if (dataLooksStale() && (await refreshDataAndRetry(current))) return;
  console.warn("Playback error, skipping to next track", current);
  nextTrack();
});

prevPostBtn?.addEventListener("click", () => goToPost(-1));
nextPostBtn?.addEventListener("click", () => goToPost(1));
prevBtn?.addEventListener("click", prevTrack);
nextBtn?.addEventListener("click", nextTrack);

function updateModeButtons() {
  // A stale index.html may not have these buttons at all. Losing a control is survivable;
  // throwing here is not, because this runs before anything gets rendered.
  if (!radioBtn || !repeatBtn) return;

  radioBtn.classList.toggle("active", radioMode);
  radioBtn.title = radioMode
    ? "Боги Хаоса выбирают — нажми, чтобы остановить"
    : "Играть как боги Хаоса решат";

  repeatBtn.classList.toggle("active-post", repeatMode === "post");
  repeatBtn.classList.toggle("active-track", repeatMode === "track");
  // "Non-stop" and "repeat this" are contradictory instructions - while the radio
  // plays, the repeat button has nothing sensible to mean.
  repeatBtn.classList.toggle("inert", radioMode);
  const labels = { none: "выкл", post: "пост", track: "трек" };
  repeatBtn.title = radioMode
    ? "Повтор недоступен, пока играет Chaos Radio"
    : `Повтор: ${labels[repeatMode]}`;
}

repeatBtn?.addEventListener("click", () => {
  if (radioMode) return;
  repeatMode = repeatMode === "none" ? "post" : repeatMode === "post" ? "track" : "none";
  saveUiPrefs();
  updateModeButtons();
});

radioBtn?.addEventListener("click", () => {
  // Always a roll of the dice, never a switch you have to find your way back out of:
  // pressing it again reshuffles and throws you somewhere else in the channel. The way
  // out is to pick a track yourself - see stopRadio().
  radioMode = true;
  repeatMode = "none";
  saveUiPrefs();
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
  renderPostList();
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
  const visible = active.slice(0, shownCount);

  postListEl.innerHTML = "";
  if (!active.length) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "Ничего не найдено";
    postListEl.appendChild(hint);
  } else {
    visible.forEach((post) => postListEl.appendChild(renderPostCard(post)));
  }

  if (listInfoEl) {
    listInfoEl.textContent = active.length
      ? `${visible.length} из ${active.length} постов`
      : "Постов пока нет";
  }
  if (feedEndEl) feedEndEl.hidden = !active.length || visible.length < active.length;
  // The sentinel sits below the list; while it is on screen the feed keeps growing.
  if (feedSentinelEl) feedSentinelEl.hidden = visible.length >= active.length;
  maybeGrowFeed();
}

// --- endless feed -------------------------------------------------------------------
// Paging through 50 pages to reach an album is not how anyone browses a channel. The
// list just keeps going; it grows a screenful at a time so the dom never holds 8000
// track rows at once.

function growFeed() {
  const active = computeActiveList();
  if (shownCount >= active.length) return false;
  shownCount += PAGE_SIZE;
  renderPostList();
  return true;
}

function maybeGrowFeed() {
  if (!feedSentinelEl || feedSentinelEl.hidden) return;
  // Short lists (or a tall screen) can leave the sentinel visible after a render, and
  // an observer only fires on change - so top the feed up until it is off screen.
  const rect = feedSentinelEl.getBoundingClientRect();
  if (rect.top < window.innerHeight + 400) {
    if (growFeed()) return;
  }
}

if (feedSentinelEl && "IntersectionObserver" in window) {
  new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) growFeed();
    },
    { rootMargin: "600px 0px" }
  ).observe(feedSentinelEl);
} else {
  window.addEventListener("scroll", maybeGrowFeed, { passive: true });
}


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
    await loadPosts();
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
