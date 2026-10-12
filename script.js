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

let history = [];      // the conversation sent to Gemini
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

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  if (role === "bot") {
    div.innerHTML = formatText(text);
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
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(BOT_CONFIG.modelName) +
      ":generateContent";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: BOT_CONFIG.systemInstructions }] },
        contents: history
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
    addMessage("bot", reply);
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
  }
  closeKeyModal();
});

keyModal.addEventListener("click", (e) => {
  if (e.target === keyModal) closeKeyModal();
});

// ---------- Go! ----------
setupBot();
