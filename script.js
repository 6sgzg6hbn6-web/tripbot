// ============================================================
//  SCRIPT.JS — The chatbot's brain. You don't need to edit this.
//  All the settings you can change are in config.js.
// ============================================================

const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const startersEl = $("starters");
const chatForm = $("chatForm");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const keyModal = $("keyModal");
const keyInput = $("keyInput");
const rememberBox = $("rememberBox");
const statusEl = $("kbStatus");

let history = [];      // the conversation sent to Gemini (plain questions only)
let isLoading = false;

// ---------- Setup from config.js ----------
function setupBot() {
  document.title = BOT_CONFIG.name;
  $("botName").textContent = BOT_CONFIG.name;
  $("botEmoji").textContent = BOT_CONFIG.emoji;
  $("botTagline").textContent = BOT_CONFIG.tagline;
  document.documentElement.style.setProperty("--theme", BOT_CONFIG.themeColor);
  startNewChat();
}

// ---------- API key storage ----------
function getKey() {
  try {
    return sessionStorage.getItem("gemini_key") || localStorage.getItem("gemini_key") || "";
  } catch (e) {
    return "";
  }
}

function saveKey(key, remember) {
  try {
    sessionStorage.setItem("gemini_key", key);
    if (remember) {
      localStorage.setItem("gemini_key", key);
    } else {
      localStorage.removeItem("gemini_key");
    }
  } catch (e) {
    // Storage may be blocked; the key just won't be remembered.
  }
}

function openKeyModal() {
  keyInput.value = getKey();
  try {
    rememberBox.checked = !!localStorage.getItem("gemini_key");
  } catch (e) {
    rememberBox.checked = false;
  }
  keyModal.hidden = false;
  keyInput.focus();
}

function closeKeyModal() {
  keyModal.hidden = true;
}

// ============================================================
//  KNOWLEDGE (RAG): find notes that match the question
// ============================================================

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const CACHE_KEY = "tripbot_embeddings";

const kb = {
  notes: [],          // each: { title, label, text }
  vectors: null,      // one list of numbers per note (when meaning search is ready)
  mode: "keywords",   // "meaning" or "keywords" (what is actually being used)
  fingerprint: "",    // identifies the current version of knowledge.md
  fileProblem: "",    // message shown if knowledge.md is missing or empty
  embedFailed: false, // true if meaning search failed
  busy: false,        // true while vectors are being made
  promise: null       // lets sendMessage wait until notes are ready
};

// ----- Status line under the header -----
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

function refreshStatus() {
  if (!BOT_CONFIG.useKnowledge) { setStatus(""); return; }
  if (kb.fileProblem) { setStatus("📚 " + kb.fileProblem); return; }
  if (!kb.notes.length) { setStatus("📚 Loading notes…"); return; }

  let how;
  if (kb.busy) {
    how = "preparing meaning search…";
  } else if (kb.mode === "meaning") {
    how = "meaning search";
  } else if (BOT_CONFIG.searchMethod === "meaning" && kb.embedFailed) {
    how = "keyword search (meaning search didn't work)";
  } else if (BOT_CONFIG.searchMethod === "meaning" && !getKey()) {
    how = "keyword search (add your API key for meaning search)";
  } else {
    how = "keyword search";
  }
  setStatus("📚 " + kb.notes.length + " notes loaded · " + how);
}

// ----- Reading knowledge.md -----
// Splits a long note at blank lines so each part is about maxLen characters or less.
function splitLong(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const parts = [];
  let current = "";
  for (const p of paragraphs) {
    const para = p.trim();
    if (!para) continue;
    if (current && current.length + para.length + 2 > maxLen) {
      parts.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Every note starts with a "## Title" line. Anything above the first one is ignored.
function parseNotes(fileText) {
  const lines = fileText.replace(/\r\n/g, "\n").split("\n");
  const notes = [];
  let title = null;
  let body = [];

  function finishNote() {
    if (title === null) return;
    const text = body.join("\n").trim();
    if (!text) return;
    const parts = splitLong(text, 1500);
    parts.forEach((part, i) => {
      notes.push({
        title: title,
        label: parts.length > 1 ? title + " (part " + (i + 1) + " of " + parts.length + ")" : title,
        text: part
      });
    });
  }

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      finishNote();
      title = match[1];
      body = [];
    } else if (title !== null) {
      body.push(line);
    }
  }
  finishNote();
  return notes;
}

// A short code that changes whenever knowledge.md (or the embedding model) changes.
function fingerprintOf(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0) + "-" + str.length;
}

// ----- Saving vectors so we don't redo the work every visit -----
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeCache(fingerprint, vectors) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fingerprint: fingerprint, vectors: vectors }));
  } catch (e) {
    // Storage full or blocked: not a problem, we just redo it next time.
  }
}

// ----- Turning text into numbers (embeddings) -----
async function embedTexts(texts) {
  const model = BOT_CONFIG.embeddingModel;
  const url = API_BASE + encodeURIComponent(model) + ":batchEmbedContents";
  const vectors = [];

  // At most 50 texts per request
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getKey()
      },
      body: JSON.stringify({
        requests: batch.map((t) => ({
          model: "models/" + model,
          content: { parts: [{ text: t }] }
        }))
      })
    });
    if (!response.ok) throw new Error("Embedding error " + response.status);
    const data = await response.json();
    if (!data.embeddings || data.embeddings.length !== batch.length) {
      throw new Error("Unexpected embedding reply");
    }
    data.embeddings.forEach((e) => vectors.push(e.values));
  }
  return vectors;
}

// Makes (or loads) the vectors for every note. Needs an API key.
async function prepareMeaning() {
  if (!kb.notes.length) return;

  if (BOT_CONFIG.searchMethod !== "meaning" || !getKey()) {
    kb.mode = "keywords";
    refreshStatus();
    return;
  }
  if (kb.vectors) {
    kb.mode = "meaning";
    kb.embedFailed = false;
    refreshStatus();
    return;
  }

  const cached = readCache();
  if (
    cached &&
    cached.fingerprint === kb.fingerprint &&
    Array.isArray(cached.vectors) &&
    cached.vectors.length === kb.notes.length
  ) {
    kb.vectors = cached.vectors;
    kb.mode = "meaning";
    kb.embedFailed = false;
    refreshStatus();
    return;
  }

  kb.busy = true;
  refreshStatus();
  try {
    const texts = kb.notes.map((n) => "title: " + n.title + " | text: " + n.text);
    const raw = await embedTexts(texts);
    // Round the numbers a little so they take up less storage space
    kb.vectors = raw.map((v) => v.map((x) => Math.round(x * 1e6) / 1e6));
    kb.mode = "meaning";
    kb.embedFailed = false;
    writeCache(kb.fingerprint, kb.vectors);
  } catch (err) {
    kb.vectors = null;
    kb.mode = "keywords";
    kb.embedFailed = true;
  }
  kb.busy = false;
  refreshStatus();
}

// Loads knowledge.md, then prepares meaning search.
async function loadKnowledge() {
  if (!BOT_CONFIG.useKnowledge) { refreshStatus(); return; }
  kb.fileProblem = "";
  refreshStatus();

  try {
    const response = await fetch(BOT_CONFIG.knowledgeFile, { cache: "no-cache" });
    if (!response.ok) {
      kb.fileProblem = "Couldn't find " + BOT_CONFIG.knowledgeFile + ". Answering without notes.";
      refreshStatus();
      return;
    }
    const fileText = await response.text();
    kb.notes = parseNotes(fileText);
    if (!kb.notes.length) {
      kb.fileProblem = BOT_CONFIG.knowledgeFile + " has no notes yet (start each note with a ## line). Answering without notes.";
      refreshStatus();
      return;
    }
    kb.fingerprint = fingerprintOf(fileText + "|" + BOT_CONFIG.embeddingModel);
  } catch (err) {
    kb.notes = [];
    kb.fileProblem = "Couldn't load " + BOT_CONFIG.knowledgeFile + ". Answering without notes.";
    refreshStatus();
    return;
  }

  await prepareMeaning();
}

// ----- Meaning search: cosine similarity -----
function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ----- Keyword search -----
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "what", "when", "where", "which",
  "who", "how", "does", "did", "can", "could", "should", "would", "about", "with",
  "from", "that", "this", "have", "has", "was", "were", "there", "their", "into",
  "tell", "give", "any", "some", "right", "now", "many", "much", "our", "your",
  "its", "his", "her", "they", "them", "than", "then", "also", "just", "like", "get", "got"
]);

// Very simple word shortening so "visas" matches "visa"
function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function keywordSearch(question, k) {
  const words = Array.from(new Set(
    question
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
      .map(stem)
  ));
  if (!words.length) return [];

  const scored = kb.notes.map((note) => {
    const title = note.title.toLowerCase();
    const text = note.text.toLowerCase();
    let points = 0;
    for (const w of words) {
      if (title.includes(w)) points += 2;   // a match in the title counts more
      if (text.includes(w)) points += 1;
    }
    return { note: note, score: points / (words.length * 3) };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ----- Pick the best notes for a question -----
async function findNotes(question) {
  const k = Math.max(1, Number(BOT_CONFIG.topK) || 3);

  if (BOT_CONFIG.searchMethod === "meaning" && kb.vectors) {
    try {
      const vectors = await embedTexts(["task: search result | query: " + question]);
      const q = vectors[0];
      const scored = kb.notes.map((note, i) => ({ note: note, score: cosine(q, kb.vectors[i]) }));
      scored.sort((a, b) => b.score - a.score);
      if (kb.mode !== "meaning") {
        kb.mode = "meaning";
        kb.embedFailed = false;
        refreshStatus();
      }
      return scored.slice(0, k);
    } catch (err) {
      // Meaning search failed: switch to keyword search automatically
      kb.mode = "keywords";
      kb.embedFailed = true;
      refreshStatus();
    }
  }
  return keywordSearch(question, k);
}

// The question plus numbered notes, sent to Gemini (not saved in the history)
function buildNotesMessage(question, found) {
  let msg = "NOTES:\n";
  if (!found.length) msg += "(no matching notes found)\n\n";
  found.forEach((f, i) => {
    msg += "[" + (i + 1) + "] " + f.note.label + "\n" + f.note.text + "\n\n";
  });
  msg += "QUESTION: " + question;
  return msg;
}

// ---------- Safe text formatting ----------
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineFormat(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function formatText(text) {
  const lines = escapeHtml(text).split("\n");
  let html = "";
  let inList = false;

  for (const line of lines) {
    const bullet = line.match(/^\s*[*-]\s+(.*)/);
    if (bullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + inlineFormat(bullet[1]) + "</li>";
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim() !== "") {
        html += "<p>" + inlineFormat(line) + "</p>";
      }
    }
  }
  if (inList) html += "</ul>";
  return html;
}

// ---------- Chat display ----------
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// The small "Sources" section that opens under a reply
function buildSources(found) {
  const details = document.createElement("details");
  details.className = "sources";

  const summary = document.createElement("summary");
  summary.textContent = "Sources (" + found.length + ")";
  details.appendChild(summary);

  found.forEach((f, i) => {
    const item = document.createElement("div");
    item.className = "source-item";

    const head = document.createElement("div");
    head.className = "source-title";
    head.textContent = "[" + (i + 1) + "] " + f.note.label + " · score " + f.score.toFixed(2);

    const snippet = document.createElement("div");
    snippet.className = "source-snippet";
    const flat = f.note.text.replace(/\s+/g, " ");
    snippet.textContent = flat.length > 160 ? flat.slice(0, 160) + "…" : flat;

    item.appendChild(head);
    item.appendChild(snippet);
    details.appendChild(item);
  });

  return details;
}

function addMessage(role, text, sources) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  if (role === "bot") {
    div.innerHTML = formatText(text);
    if (sources && sources.length) {
      div.appendChild(buildSources(sources));
    }
  } else {
    div.textContent = text; // user and error text is never treated as HTML
  }
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function addThinking() {
  const div = document.createElement("div");
  div.className = "msg bot thinking";
  div.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function showStarters() {
  startersEl.innerHTML = "";
  BOT_CONFIG.starterQuestions.forEach((q) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "starter";
    btn.textContent = q;
    btn.addEventListener("click", () => sendMessage(q));
    startersEl.appendChild(btn);
  });
}

function startNewChat() {
  history = [];
  messagesEl.innerHTML = "";
  addMessage("bot", BOT_CONFIG.welcomeMessage);
  showStarters();
  inputEl.value = "";
  autoGrow();
  inputEl.focus();
}

// ---------- Talking to Gemini ----------
function friendlyError(status) {
  if (status === 400 || status === 403) {
    return "Hmm, Gemini didn't accept your API key. Click \"API key\" at the top and check that you pasted it correctly.";
  }
  if (status === 404) {
    return "Gemini couldn't find that model. Open config.js and check the modelName setting.";
  }
  if (status === 429) {
    return "Too many requests right now. Please wait a minute and try again.";
  }
  if (status >= 500) {
    return "Gemini's servers are having trouble. Please try again in a moment.";
  }
  return "Something went wrong (error " + status + "). Please try again.";
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || isLoading) return;

  const key = getKey();
  if (!key) {
    addMessage("error", "Please add your Gemini API key first. Click the \"API key\" button at the top.");
    openKeyModal();
    return;
  }

  startersEl.innerHTML = "";
  addMessage("user", text);
  history.push({ role: "user", parts: [{ text: text }] });

  inputEl.value = "";
  autoGrow();
  isLoading = true;
  sendBtn.disabled = true;
  const thinking = addThinking();

  try {
    // Wait for the notes to finish loading (usually instant)
    if (kb.promise) await kb.promise;

    const useNotes = BOT_CONFIG.useKnowledge && kb.notes.length > 0;
    let found = [];
    if (useNotes) found = await findNotes(text);

    // The history keeps your plain questions. Only this latest question gets the notes added.
    const contents = history.slice(0, -1).concat([
      { role: "user", parts: [{ text: useNotes ? buildNotesMessage(text, found) : text }] }
    ]);

    const systemText =
      BOT_CONFIG.systemInstructions + (useNotes ? " " + BOT_CONFIG.knowledgeRules : "");

    const url = API_BASE + encodeURIComponent(BOT_CONFIG.modelName) + ":generateContent";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: contents
      })
    });

    thinking.remove();

    if (!response.ok) {
      history.pop(); // remove the failed message so the chat history stays clean
      addMessage("error", friendlyError(response.status));
      return;
    }

    const data = await response.json();
    const parts =
      data.candidates && data.candidates[0] && data.candidates[0].content
        ? data.candidates[0].content.parts || []
        : [];

    const reply = parts
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");

    if (!reply) {
      history.pop();
      addMessage("error", "I couldn't come up with an answer to that. Try rephrasing your question.");
      return;
    }

    history.push({ role: "model", parts: [{ text: reply }] });
    addMessage("bot", reply, useNotes ? found : null);
  } catch (err) {
    thinking.remove();
    history.pop();
    addMessage("error", "I can't reach the internet right now. Check your connection and try again.");
  } finally {
    isLoading = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ---------- Input box behavior ----------
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
}

inputEl.addEventListener("input", autoGrow);

inputEl.addEventListener("keydown", (e) => {
  // Enter sends, Shift+Enter makes a new line
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(inputEl.value);
});

// ---------- Buttons ----------
$("newChatBtn").addEventListener("click", startNewChat);
$("keyBtn").addEventListener("click", openKeyModal);
$("keyCancel").addEventListener("click", closeKeyModal);

$("keySave").addEventListener("click", () => {
  const key = keyInput.value.trim();
  if (key) {
    saveKey(key, rememberBox.checked);
    // A new key may unlock meaning search (or let us retry loading the notes)
    if (BOT_CONFIG.useKnowledge) {
      kb.promise = kb.notes.length ? prepareMeaning() : loadKnowledge();
    }
  }
  closeKeyModal();
});

keyModal.addEventListener("click", (e) => {
  if (e.target === keyModal) closeKeyModal();
});

// ---------- Go! ----------
setupBot();
if (BOT_CONFIG.useKnowledge) {
  kb.promise = loadKnowledge();
} else {
  refreshStatus();
}
