const audio = document.getElementById("audio");
const dataNote = document.getElementById("data-note");
const nowTitle = document.getElementById("now-title");
const nowArtist = document.getElementById("now-artist");
const artwork = document.getElementById("artwork");
const prevPostBtn = document.getElementById("prev-post-btn");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const nextPostBtn = document.getElementById("next-post-btn");
const radioBtn = document.getElementById("radio-btn");
const repeatBtn = document.getElementById("repeat-btn");
const sortSelect = document.getElementById("sort-select");
const filterSelect = document.getElementById("filter-select");
const categoryFilterEl = document.getElementById("category-filter");
const categoryManagerToggle = document.getElementById("category-manager-toggle");
const categoryManagerBody = document.getElementById("category-manager-body");
const categoryManageListEl = document.getElementById("category-manage-list");
const categoryCreateForm = document.getElementById("category-create-form");
const categoryNameInput = document.getElementById("category-name-input");
const postListEl = document.getElementById("post-list");
const pagePrevBtns = [document.getElementById("page-prev"), document.getElementById("page-prev-bottom")];
const pageNextBtns = [document.getElementById("page-next"), document.getElementById("page-next-bottom")];
const pageInfos = [document.getElementById("page-info"), document.getElementById("page-info-bottom")];

const UI_PREFS_KEY = "rd_player_prefs_v1";
const PAGE_SIZE = 20; // posts per page - the channel has thousands of tracks, so
// rendering the whole filtered list at once would make the page unusably heavy.

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

let currentPage = 0;

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
  updateDataNote();
}

function loadCategories() {
  categories = userData.categories;
}

function updateDataNote() {
  if (!dataNote || !dataGeneratedAt) return;
  const hours = (Date.now() / 1000 - dataGeneratedAt) / 3600;
  const when =
    hours < 1 ? "только что" : hours < 24 ? `${Math.round(hours)} ч назад` : `${Math.round(hours / 24)} дн назад`;
  dataNote.textContent = `список обновлён ${when}`;
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
  audio.play();
  updateNowPlaying(track);
  revealCurrentPage();
  renderPostList();
}

function revealCurrentPage() {
  if (!current) return;
  const active = computeActiveList();
  const idx = active.findIndex((p) => String(p.message_id) === String(current.messageId));
  if (idx !== -1) currentPage = Math.floor(idx / PAGE_SIZE);
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
  const post = neighborPost(delta);
  if (!post || !post.tracks.length) return;
  playNewRef({ messageId: post.message_id, trackId: post.tracks[0].id });
}

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
  radioMode = !radioMode;
  if (radioMode) {
    repeatMode = "none";
    saveUiPrefs();
    // Starting the radio is an action, not a setting: it plays something at once
    // rather than waiting for the listener to also pick a track.
    radioBag = [];
    const ref = pickRandomFromChannel();
    if (ref) playNewRef(ref);
  }
  updateModeButtons();
});

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
      currentPage = 0;
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
  const pageCount = Math.max(1, Math.ceil(active.length / PAGE_SIZE));
  if (currentPage >= pageCount) currentPage = pageCount - 1;
  if (currentPage < 0) currentPage = 0;

  const start = currentPage * PAGE_SIZE;
  const pageItems = active.slice(start, start + PAGE_SIZE);

  postListEl.innerHTML = "";
  if (!active.length) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "Ничего не найдено";
    postListEl.appendChild(hint);
  } else {
    pageItems.forEach((post) => postListEl.appendChild(renderPostCard(post)));
  }

  const infoText = active.length
    ? `Стр. ${currentPage + 1} из ${pageCount} (${active.length} постов)`
    : "Постов пока нет";
  pageInfos.forEach((el) => (el.textContent = infoText));
  pagePrevBtns.forEach((el) => (el.disabled = currentPage <= 0));
  pageNextBtns.forEach((el) => (el.disabled = currentPage >= pageCount - 1));
}

function goToPage(delta) {
  currentPage += delta;
  renderPostList();
}

pagePrevBtns.forEach((el) => el.addEventListener("click", () => goToPage(-1)));
pageNextBtns.forEach((el) => el.addEventListener("click", () => goToPage(1)));

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

  row.addEventListener("click", () => playNewRef({ messageId: post.message_id, trackId: track.id }));

  return row;
}

// --- sort / filter toolbar ------------------------------------------------------

sortSelect?.addEventListener("change", () => {
  sortOrder = sortSelect.value;
  saveUiPrefs();
  currentPage = 0;
  renderPostList();
});

filterSelect?.addEventListener("change", () => {
  filterMode = filterSelect.value;
  saveUiPrefs();
  currentPage = 0;
  renderCategoryFilterChips();
  renderPostList();
});

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
    sortSelect.value = sortOrder;
    filterSelect.value = filterMode;
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
  if (dataNote) dataNote.textContent = "плеер недоступен";
}
