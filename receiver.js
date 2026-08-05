// --- On-page debug log ---
// Visit the page with ?debug=1 to see everything below directly on screen —
// no DevTools/console required, same as draft-receiver. e.g.
// http://localhost:8000/?debug=1
const DEBUG = new URLSearchParams(location.search).has("debug");
const debugPanel = document.getElementById("debug-panel");
if (DEBUG) debugPanel.classList.remove("hidden");

function log(...args) {
  console.log(...args);
  if (DEBUG) {
    const line = document.createElement("div");
    line.textContent = args
      .map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
      .join(" ");
    debugPanel.appendChild(line);
    debugPanel.scrollTop = debugPanel.scrollHeight;
  }
}

log("Booting receiver…");

// ============================================================================
// CONFIG — fill in with your new Supabase project's values (Settings -> API).
// Served publicly from GitHub Pages, same as your other custom receivers.
// ============================================================================
const CONFIG = {
  SUPABASE_URL: "https://njmhtzlarzxghldpnkct.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Malyz9S1E2VvxZD98T69tg_jjDSb8Ea",
};

if (CONFIG.SUPABASE_URL.includes("YOUR-PROJECT") || CONFIG.SUPABASE_ANON_KEY.includes("YOUR-ANON")) {
  log("⚠️ CONFIG still has placeholder values — update SUPABASE_URL / SUPABASE_ANON_KEY at the top of receiver.js");
}

const app = document.getElementById("app");
const audioEl = document.getElementById("plex-audio");
const debugPlayBtn = document.getElementById("debug-play-btn");

let lastKnownStreamUrl = null; // used by the manual test-play button below

if (DEBUG) {
  debugPlayBtn.classList.remove("hidden");
  debugPlayBtn.addEventListener("click", () => {
    if (!lastKnownStreamUrl) {
      log("No stream URL known yet.");
      return;
    }
    log("Manual test play:", lastKnownStreamUrl);
    audioEl.src = lastKnownStreamUrl;
    audioEl.currentTime = 0;
    audioEl.play()
      .then(() => log("▶️ Manual playback started."))
      .catch((err) => log("❌ Manual playback failed:", err.message));
  });
}

// ============================================================================
// CAST RECEIVER INIT
// disableIdleTimeout matters here: there's no cast.framework media session
// playing (audio is driven manually via <audio>), so without this the
// receiver would think nothing is happening and idle out — the exact issue
// you fixed on draft-receiver by registering this in the Cast Developer Console.
// ============================================================================
try {
  const castContext = cast.framework.CastReceiverContext.getInstance();
  castContext.start({ disableIdleTimeout: true });
  castContext.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, () => {
    log("📱 Sender (re)connected.");
    // The page persists across disconnect/reconnect, so nothing else
    // naturally re-triggers playback here. Nudge whatever playlist should be
    // running for the current section.
    resumePlaylistForCurrentSection();
  });
  log("Cast receiver context started.");
} catch (e) {
  log("Cast SDK not available (expected when testing in a plain browser tab):", e.message);
}

// ============================================================================
// SUPABASE
// ============================================================================
const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
log("Supabase client created for", CONFIG.SUPABASE_URL);

// ============================================================================
// AUDIO — plays pre-resolved Plex stream URLs stored in the DB. No Plex API
// calls happen here at all; the sender app resolved everything at
// configuration time (same division of labor as draft-sender/draft-receiver).
// ============================================================================
let playlistTracks = []; // [{ title, streamUrl }]
let playlistIndex = 0;
let currentSectionKey = null; // dedupe so unrelated row updates don't restart audio
let musicStopped = false; // set from live_state.music_stopped, independent of section

function playTrack(index) {
  if (!playlistTracks.length) return;
  playlistIndex = ((index % playlistTracks.length) + playlistTracks.length) % playlistTracks.length;
  const track = playlistTracks[playlistIndex];
  lastKnownStreamUrl = track.streamUrl;
  audioEl.src = track.streamUrl;
  audioEl.currentTime = 0;
  audioEl.play()
    .then(() => log("▶️ Playing:", track.title))
    .catch((err) => log("❌ Playback failed:", err.message, "(often needs one click on the page first when testing in a plain browser tab)"));
}

audioEl.addEventListener("ended", () => {
  if (playlistTracks.length > 1) playTrack(playlistIndex + 1);
});

// Starts a playlist only if it's not already the one playing, so an
// unrelated Realtime update doesn't restart the song from the beginning.
// If music has been stopped from the Live tab, this no-ops (and pauses)
// regardless of section, until it's resumed.
function startPlaylist(sectionKey, tracks) {
  if (musicStopped) {
    audioEl.pause();
    currentSectionKey = null; // so playback picks back up correctly once resumed
    return;
  }
  if (currentSectionKey === sectionKey) return;
  currentSectionKey = sectionKey;
  playlistTracks = tracks || [];
  playlistIndex = 0;
  if (playlistTracks.length > 0) playTrack(0);
  else audioEl.pause();
}

function resumePlaylistForCurrentSection() {
  if (!latestLiveState) return;
  if (!playlistTracks.length) return;
  if (audioEl.paused) playTrack(playlistIndex);
}

// ============================================================================
// RENDER HELPERS
// ============================================================================
function escapeHtml(str) {
  return (str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Nominee cards scale down automatically as the count grows, so a big award
// with all 12 owners nominated doesn't try to cram 12 full-size cards on
// screen — no pagination/carousel needed, just responsive sizing.
function nomineeSizeClass(count) {
  if (count > 8) return "nominee-stage--compact";
  if (count > 4) return "nominee-stage--medium";
  return "";
}

function renderIntro(introConfig) {
  const images = introConfig?.image_urls || [];
  app.innerHTML = `
    ${introConfig?.intro_text ? `<div class="intro-text" style="color:${escapeHtml(introConfig.intro_text_color)}">${escapeHtml(introConfig.intro_text)}</div>` : ""}
    ${images.length ? `<img class="intro-image visible" id="intro-img" src="${escapeHtml(images[0])}" />` : ""}
    ${introConfig?.jumbotron_text ? `<div class="jumbotron-text" style="color:${escapeHtml(introConfig.jumbotron_text_color)}; text-shadow: 0 0 20px ${escapeHtml(introConfig.jumbotron_text_color)}, 0 0 40px ${escapeHtml(introConfig.jumbotron_text_color)};">${escapeHtml(introConfig.jumbotron_text)}</div>` : ""}
  `;
  if (images.length > 1) {
    let idx = 0;
    setInterval(() => {
      idx = (idx + 1) % images.length;
      const el = document.getElementById("intro-img");
      if (!el) return;
      el.classList.remove("visible");
      setTimeout(() => {
        el.src = images[idx];
        el.classList.add("visible");
      }, 600);
    }, 8000);
  }
  startPlaylist(`intro:${introConfig?.playlist_label ?? ""}`, introConfig?.playlist_tracks);
}

function renderAward(award, nominees, phase) {
  const winners = nominees.filter((n) => n.is_winner);

  if (phase === "winner" && winners.length > 0) {
    app.innerHTML = `
      ${award.reveal_label ? `<div class="eyebrow">${escapeHtml(award.reveal_label)}</div>` : ""}
      <h1 class="heading" style="color:${escapeHtml(award.award_name_color)}">${escapeHtml(award.award_name)}</h1>
      <div class="divider"></div>
      <div class="winner-stage">
        ${winners
          .map(
            (w) => `
          <div class="winner-card">
            ${w.owner?.logo_url ? `<img class="winner-logo" src="${escapeHtml(w.owner.logo_url)}" />` : `<div class="winner-logo"></div>`}
            <div class="winner-name">${escapeHtml(w.owner?.team_name)}</div>
            ${w.stat_text ? `<div class="winner-stat">${escapeHtml(w.stat_text)}</div>` : ""}
          </div>`
          )
          .join("")}
      </div>
    `;
    // Walk-up songs, back to back if there's more than one co-winner —
    // these are per-owner stream URLs, resolved ahead of time in the app.
    const tracks = winners
      .filter((w) => w.owner?.walkup_song_stream_url)
      .map((w) => ({ title: w.owner.walkup_song_label || w.owner.team_name, streamUrl: w.owner.walkup_song_stream_url }));
    startPlaylist(`winner:${award.id}`, tracks);
    return;
  }

  // Pre-reveal phase. Most awards have show_nominees = false — a single
  // clear winner (or tied co-winners) with nothing shown until Reveal Winner
  // is pressed, so this renders just the heading with no grid at all.
  if (!award.show_nominees) {
    app.innerHTML = `
      ${award.image_url ? `<img class="award-image" src="${escapeHtml(award.image_url)}" />` : ""}
      <h1 class="heading" style="color:${escapeHtml(award.award_name_color)}">${escapeHtml(award.award_name)}</h1>
      <div class="divider"></div>
    `;
    startPlaylist(`nominees:${award.id}`, []);
    return;
  }

  app.innerHTML = `
    ${award.image_url ? `<img class="award-image" src="${escapeHtml(award.image_url)}" />` : ""}
    <h1 class="heading" style="color:${escapeHtml(award.award_name_color)}">${escapeHtml(award.award_name)}</h1>
    <div class="divider"></div>
    <div class="nominee-stage ${nomineeSizeClass(nominees.length)}">
      ${nominees
        .map(
          (n) => `
        <div class="nominee-card">
          ${n.owner?.logo_url ? `<img class="nominee-logo" src="${escapeHtml(n.owner.logo_url)}" />` : `<div class="nominee-logo"></div>`}
          <div class="nominee-name">${escapeHtml(n.owner?.team_name)}</div>
          ${n.stat_text ? `<div class="nominee-stat">${escapeHtml(n.stat_text)}</div>` : ""}
        </div>`
        )
        .join("")}
    </div>
  `;
  // No audio during nominees — silence between the reveal moments.
  startPlaylist(`nominees:${award.id}`, []);
}

function renderOutro(category, entries, outroConfig) {
  app.innerHTML = `
    <div class="eyebrow">All-Time Award</div>
    ${category.image_url ? `<img class="award-image" src="${escapeHtml(category.image_url)}" />` : ""}
    <h1 class="heading" style="color:${escapeHtml(category.category_name_color)}">${escapeHtml(category.category_name)}</h1>
    <div class="divider"></div>
    <div class="ledger">
      ${entries
        .map(
          (e) => `
        <div class="ledger-row">
          <span class="ledger-label" style="color:${escapeHtml(e.label_color)}">${escapeHtml(e.label_text)}</span>
          ${e.value_text ? `<span class="ledger-value" style="color:${escapeHtml(e.value_color)}">${escapeHtml(e.value_text)}</span>` : ""}
        </div>`
        )
        .join("")}
    </div>
  `;
  // One continuous playlist for the whole Outro section, not per-category —
  // key on the playlist itself so switching categories doesn't restart it.
  startPlaylist(`outro:${outroConfig?.playlist_label ?? ""}`, outroConfig?.playlist_tracks);
}

function renderEnd(outroConfig) {
  const text = outroConfig?.end_text || "That's a Wrap!";
  const color = outroConfig?.end_text_color || "#F2D675";
  app.innerHTML = `<div class="end-text" style="color:${escapeHtml(color)}">${escapeHtml(text)}</div>`;
}

// ============================================================================
// MAIN LOOP
// ============================================================================
let latestLiveState = null;
let renderGeneration = 0; // guards against a slower, older render finishing after a newer one

async function fetchCore() {
  const [{ data: liveState }, { data: awards }, { data: outroCategories }, { data: introConfig }, { data: outroConfig }] =
    await Promise.all([
      sb.from("live_state").select("*").eq("id", 1).single(),
      sb.from("awards").select("*").order("sequence"),
      sb.from("outro_categories").select("*").order("sequence"),
      sb.from("intro_config").select("*").eq("id", 1).single(),
      sb.from("outro_config").select("*").eq("id", 1).single(),
    ]);
  return { liveState, awards: awards || [], outroCategories: outroCategories || [], introConfig, outroConfig };
}

async function fetchAwardNominees(awardId) {
  const { data } = await sb
    .from("award_nominees")
    .select("*, owner:owners(*)")
    .eq("award_id", awardId)
    .order("position");
  return data || [];
}

async function fetchOutroEntries(categoryId) {
  const { data } = await sb.from("outro_entries").select("*").eq("category_id", categoryId).order("position");
  return data || [];
}

async function renderCurrentState() {
  const myGeneration = ++renderGeneration;
  log("Rendering current state…");
  const { liveState, awards, outroCategories, introConfig, outroConfig } = await fetchCore();
  if (myGeneration !== renderGeneration) return; // a newer render started while this one was fetching
  if (!liveState) {
    log("⚠️ No live_state row found.");
    return;
  }
  latestLiveState = liveState;
  musicStopped = !!liveState.music_stopped;
  log("section =", liveState.section, "| music stopped =", musicStopped);

  if (liveState.section === "intro") {
    renderIntro(introConfig);
  } else if (liveState.section === "award") {
    const award = awards.find((a) => a.id === liveState.current_award_id);
    if (!award) return;
    const nominees = await fetchAwardNominees(award.id);
    if (myGeneration !== renderGeneration) return;
    renderAward(award, nominees, liveState.award_phase);
  } else if (liveState.section === "outro") {
    const category = outroCategories.find((c) => c.id === liveState.current_outro_category_id);
    if (!category) return;
    const entries = await fetchOutroEntries(category.id);
    if (myGeneration !== renderGeneration) return;
    renderOutro(category, entries, outroConfig);
  } else if (liveState.section === "end") {
    renderEnd(outroConfig);
    // Deliberately not touching the playlist here — the Outro music keeps
    // playing through the closing screen until Stop Music is pressed or the
    // Cast session ends, per how the banquet should close out.
  }
}

renderCurrentState();

sb.channel("receiver-sync")
  .on("postgres_changes", { event: "*", schema: "public", table: "live_state" }, () => {
    log("📡 live_state changed.");
    renderCurrentState();
  })
  .on("postgres_changes", { event: "*", schema: "public", table: "award_nominees" }, renderCurrentState)
  .on("postgres_changes", { event: "*", schema: "public", table: "owners" }, renderCurrentState)
  .on("postgres_changes", { event: "*", schema: "public", table: "outro_entries" }, renderCurrentState)
  .subscribe((status) => log("Realtime subscription status:", status));
