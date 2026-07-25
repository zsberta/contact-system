/**
 * AI Assistant Widget — embeddable chat widget script.
 *
 * Served from: /api/public/ai-assistant/:secret_token/script.js
 * Placeholders {{SECRET_TOKEN}}, {{BASE_URL}}, {{DEFAULT_LANGUAGE}},
 * {{DISPLAY_NAME}}, {{PRIMARY_COLOR}}, {{SECONDARY_COLOR}},
 * {{GREETING_MESSAGE}}, {{POSITION}}, {{AVATAR_URL}},
 * {{SUPPORTED_LANGUAGES}}, {{TRANSLATIONS}} are replaced server-side.
 *
 * Language switching API:
 *   window.__aiAssistant.setLanguage('en')
 *   document.dispatchEvent(new CustomEvent('ai-assistant:language-change', { detail: { lang: 'en' } }))
 *   <script ... data-lang="hu"> (MutationObserver on attribute)
 */
(function () {
  "use strict";

  if (window.__aiAssistant) return; // prevent double-init

  var SECRET_TOKEN = "{{SECRET_TOKEN}}";
  var BASE_URL = "{{BASE_URL}}";
  var DEFAULT_LANGUAGE = "{{DEFAULT_LANGUAGE}}";
  var DISPLAY_NAME = "{{DISPLAY_NAME}}";
  var PRIMARY_COLOR = "{{PRIMARY_COLOR}}";
  var SECONDARY_COLOR = "{{SECONDARY_COLOR}}";
  var GREETING_MESSAGE = "{{GREETING_MESSAGE}}";
  var POSITION = "{{POSITION}}";
  var AVATAR_URL = "{{AVATAR_URL}}";
  var SUPPORTED_LANGUAGES = {{SUPPORTED_LANGUAGES}};
  var TRANSLATIONS = {{TRANSLATIONS}};

  var currentLang = DEFAULT_LANGUAGE;
  var sessionId = null;
  var messages = [];
  var isOpen = false;
  var isStreaming = false;
  var widgetRoot = null;
  var chatContainer = null;
  var messagesContainer = null;
  var inputEl = null;
  var greetingSent = false;

  // --- Translation helpers ---
  function getTranslation(key, lang) {
    lang = lang || currentLang;
    for (var i = 0; i < TRANSLATIONS.length; i++) {
      if (TRANSLATIONS[i].language === lang && TRANSLATIONS[i][key]) {
        return TRANSLATIONS[i][key];
      }
    }
    return null;
  }

  function getDisplayName(lang) {
    return getTranslation("displayName", lang) || DISPLAY_NAME;
  }

  function getGreeting(lang) {
    return getTranslation("greetingMessage", lang) || GREETING_MESSAGE;
  }

  function getPlaceholder(lang) {
    return getTranslation("placeholder", lang) || "Type a message...";
  }

  // --- UUID generator ---
  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // --- Shadow DOM setup ---
  function createWidget() {
    var host = document.createElement("div");
    host.id = "ai-assistant-widget-host";
    host.style.all = "initial";
    document.body.appendChild(host);

    var shadow = host.attachShadow({ mode: "open" });

    // Inject styles
    var style = document.createElement("style");
    style.textContent = getStyles();
    shadow.appendChild(style);

    // Chat container
    chatContainer = document.createElement("div");
    chatContainer.className = "ai-chat-container";
    chatContainer.style.display = "none";
    shadow.appendChild(chatContainer);

    // Chat header
    var header = document.createElement("div");
    header.className = "ai-chat-header";
    header.innerHTML =
      '<div class="ai-chat-header-info">' +
      (AVATAR_URL
        ? '<img class="ai-chat-avatar" src="' + AVATAR_URL + '" alt="" />'
        : '<div class="ai-chat-avatar-placeholder">AI</div>') +
      '<span class="ai-chat-title">' + escHtml(getDisplayName()) + "</span>" +
      "</div>" +
      '<button class="ai-chat-close" aria-label="Close">&times;</button>';
    chatContainer.appendChild(header);

    header.querySelector(".ai-chat-close").addEventListener("click", function () {
      toggleChat(false);
    });

    // Messages area
    messagesContainer = document.createElement("div");
    messagesContainer.className = "ai-chat-messages";
    chatContainer.appendChild(messagesContainer);

    // Input area
    var inputArea = document.createElement("div");
    inputArea.className = "ai-chat-input-area";
    inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "ai-chat-input";
    inputEl.placeholder = getPlaceholder();
    inputEl.maxLength = 2000;
    var sendBtn = document.createElement("button");
    sendBtn.className = "ai-chat-send";
    sendBtn.innerHTML = "&#10148;";
    sendBtn.setAttribute("aria-label", "Send");
    inputArea.appendChild(inputEl);
    inputArea.appendChild(sendBtn);
    chatContainer.appendChild(inputArea);

    // Copyright
    var copyright = document.createElement("div");
    copyright.className = "ai-chat-copyright";
    copyright.innerHTML =
      'Powered by <a href="https://zsoltberta.hu" target="_blank" rel="noopener">Zsolt Berta</a>';
    chatContainer.appendChild(copyright);

    // Send on click
    sendBtn.addEventListener("click", sendMessage);

    // Send on Enter
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Floating button
    var fab = document.createElement("button");
    fab.className = "ai-chat-fab";
    fab.setAttribute("aria-label", "Open AI Assistant");
    fab.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';
    fab.addEventListener("click", function () {
      toggleChat(!isOpen);
    });
    shadow.appendChild(fab);

    widgetRoot = shadow;

    // Send greeting after a short delay
    setTimeout(function () {
      sendGreeting();
    }, 500);
  }

  function sendGreeting() {
    if (greetingSent) return;
    greetingSent = true;
    addMessage("assistant", getGreeting());
  }

  function toggleChat(open) {
    isOpen = open;
    if (chatContainer) {
      chatContainer.style.display = open ? "flex" : "none";
    }
    if (open && inputEl) {
      inputEl.focus();
      scrollToBottom();
    }
  }

  function addMessage(role, content) {
    messages.push({ role: role, content: content, lang: currentLang });
    if (!messagesContainer) return;

    var div = document.createElement("div");
    div.className = "ai-chat-message ai-chat-message-" + role;
    var bubble = document.createElement("div");
    bubble.className = "ai-chat-bubble";
    bubble.textContent = content;
    div.appendChild(bubble);
    messagesContainer.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  function escHtml(s) {
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // --- Send message ---
  function sendMessage() {
    if (isStreaming) return;
    var text = inputEl.value.trim();
    if (!text) return;

    addMessage("user", text);
    inputEl.value = "";

    // Create assistant placeholder
    var placeholder = document.createElement("div");
    placeholder.className = "ai-chat-message ai-chat-message-assistant";
    var bubble = document.createElement("div");
    bubble.className = "ai-chat-bubble ai-chat-bubble-loading";
    bubble.textContent = "...";
    placeholder.appendChild(bubble);
    messagesContainer.appendChild(placeholder);
    scrollToBottom();

    isStreaming = true;

    var body = JSON.stringify({
      message: text,
      sessionId: sessionId,
      lang: currentLang,
    });

    fetch(BASE_URL + "/api/public/ai-assistant/" + SECRET_TOKEN + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Chat request failed");
        sessionId = res.headers.get("X-Session-Id") || sessionId;
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var fullText = "";

        function read() {
          return reader.read().then(function (result) {
            if (result.done) {
              isStreaming = false;
              bubble.classList.remove("ai-chat-bubble-loading");
              // Update the message in the array
              messages[messages.length - 1].content = fullText;
              return;
            }
            var chunk = decoder.decode(result.value, { stream: true });
            var lines = chunk.split("\n");
            for (var i = 0; i < lines.length; i++) {
              if (lines[i].startsWith("data: ")) {
                try {
                  var data = JSON.parse(lines[i].slice(6));
                  if (data.content) {
                    fullText += data.content;
                    bubble.textContent = fullText;
                    scrollToBottom();
                  }
                  if (data.sessionId) {
                    sessionId = data.sessionId;
                  }
                } catch (e) {
                  // skip malformed chunks
                }
              }
            }
            return read();
          });
        }
        return read();
      })
      .catch(function (err) {
        isStreaming = false;
        bubble.textContent = "Sorry, something went wrong. Please try again.";
        bubble.classList.remove("ai-chat-bubble-loading");
        console.error("[ai-assistant]", err);
      });
  }

  // --- Language switching ---
  function setLanguage(lang) {
    if (!lang || lang === currentLang) return;
    currentLang = lang;

    // Update UI
    if (widgetRoot) {
      var titleEl = widgetRoot.querySelector(".ai-chat-title");
      if (titleEl) titleEl.textContent = getDisplayName();
      if (inputEl) inputEl.placeholder = getPlaceholder();
    }

    // If no user messages yet, replace the greeting
    var hasUserMessages = messages.some(function (m) {
      return m.role === "user";
    });

    if (!hasUserMessages && messages.length > 0) {
      // Remove old greeting from UI
      if (messagesContainer && messagesContainer.firstChild) {
        messagesContainer.removeChild(messagesContainer.firstChild);
      }
      messages = [];
      greetingSent = false;
      sendGreeting();
    } else if (hasUserMessages) {
      // Send a system message about language switch
      addMessage("system", "The visitor switched language to " + lang + ".");
      // Also notify the server
      if (sessionId) {
        fetch(BASE_URL + "/api/public/ai-assistant/" + SECRET_TOKEN + "/language", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId, lang: lang }),
        }).catch(function () {});
      }
    }
  }

  // --- Public API ---
  window.__aiAssistant = {
    setLanguage: setLanguage,
    getVersion: function () { return "1.0.0"; },
  };

  // --- Custom event listener ---
  document.addEventListener("ai-assistant:language-change", function (e) {
    if (e.detail && e.detail.lang) {
      setLanguage(e.detail.lang);
    }
  });

  // --- MutationObserver on data-lang attribute ---
  function watchDataLang() {
    var scriptEl = document.querySelector('script[src*="ai-assistant/' + SECRET_TOKEN + '"]');
    if (!scriptEl) return;
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].attributeName === "data-lang") {
          var newLang = scriptEl.getAttribute("data-lang");
          if (newLang) setLanguage(newLang);
        }
      }
    });
    observer.observe(scriptEl, { attributes: true });
  }

  // --- Styles ---
  function getStyles() {
    return (
      ":host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }" +
      ".ai-chat-container {" +
      "  position: fixed; " + (POSITION === "bottom-left" ? "left: 20px;" : "right: 20px;") +
      "  bottom: 80px; width: 380px; max-width: calc(100vw - 40px); height: 520px; max-height: calc(100vh - 120px);" +
      "  background: " + SECONDARY_COLOR + "; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.18);" +
      "  display: flex; flex-direction: column; overflow: hidden; z-index: 2147483647;" +
      "  border: 1px solid rgba(0,0,0,0.08);" +
      "}" +
      ".ai-chat-header {" +
      "  background: " + PRIMARY_COLOR + "; color: #fff; padding: 14px 16px;" +
      "  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;" +
      "}" +
      ".ai-chat-header-info { display: flex; align-items: center; gap: 10px; }" +
      ".ai-chat-avatar, .ai-chat-avatar-placeholder {" +
      "  width: 32px; height: 32px; border-radius: 50%; object-fit: cover;" +
      "}" +
      ".ai-chat-avatar-placeholder {" +
      "  background: rgba(255,255,255,0.2); display: flex; align-items: center;" +
      "  justify-content: center; font-size: 12px; font-weight: 600; color: #fff;" +
      "}" +
      ".ai-chat-title { font-size: 15px; font-weight: 600; }" +
      ".ai-chat-close {" +
      "  background: none; border: none; color: #fff; font-size: 22px; cursor: pointer;" +
      "  padding: 0 4px; line-height: 1; opacity: 0.8;" +
      "}" +
      ".ai-chat-close:hover { opacity: 1; }" +
      ".ai-chat-messages {" +
      "  flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px;" +
      "}" +
      ".ai-chat-message { display: flex; }" +
      ".ai-chat-message-user { justify-content: flex-end; }" +
      ".ai-chat-message-assistant { justify-content: flex-start; }" +
      ".ai-chat-message-system { justify-content: center; }" +
      ".ai-chat-bubble {" +
      "  max-width: 80%; padding: 10px 14px; border-radius: 16px; font-size: 14px;" +
      "  line-height: 1.45; word-break: break-word; white-space: pre-wrap;" +
      "}" +
      ".ai-chat-message-user .ai-chat-bubble {" +
      "  background: " + PRIMARY_COLOR + "; color: #fff; border-bottom-right-radius: 4px;" +
      "}" +
      ".ai-chat-message-assistant .ai-chat-bubble {" +
      "  background: #f1f3f5; color: #1a1a1a; border-bottom-left-radius: 4px;" +
      "}" +
      ".ai-chat-message-system .ai-chat-bubble {" +
      "  background: transparent; color: #868e96; font-size: 12px; font-style: italic; padding: 4px 8px;" +
      "}" +
      ".ai-chat-bubble-loading { opacity: 0.6; }" +
      ".ai-chat-input-area {" +
      "  padding: 12px; border-top: 1px solid #e9ecef; display: flex; gap: 8px; flex-shrink: 0;" +
      "  background: " + SECONDARY_COLOR + ";" +
      "}" +
      ".ai-chat-input {" +
      "  flex: 1; border: 1px solid #dee2e6; border-radius: 20px; padding: 10px 16px;" +
      "  font-size: 14px; outline: none; background: #fff; color: #1a1a1a;" +
      "}" +
      ".ai-chat-input:focus { border-color: " + PRIMARY_COLOR + "; }" +
      ".ai-chat-send {" +
      "  width: 40px; height: 40px; border-radius: 50%; border: none; background: " + PRIMARY_COLOR + ";" +
      "  color: #fff; font-size: 16px; cursor: pointer; display: flex; align-items: center;" +
      "  justify-content: center; flex-shrink: 0;" +
      "}" +
      ".ai-chat-send:hover { opacity: 0.9; }" +
      ".ai-chat-copyright {" +
      "  text-align: center; padding: 6px; font-size: 11px; color: #adb5bd; flex-shrink: 0;" +
      "  border-top: 1px solid #f1f3f5; background: " + SECONDARY_COLOR + ";" +
      "}" +
      ".ai-chat-copyright a { color: " + PRIMARY_COLOR + "; text-decoration: none; }" +
      ".ai-chat-copyright a:hover { text-decoration: underline; }" +
      ".ai-chat-fab {" +
      "  position: fixed; " + (POSITION === "bottom-left" ? "left: 20px;" : "right: 20px;") +
      "  bottom: 20px; width: 56px; height: 56px; border-radius: 50%; border: none;" +
      "  background: " + PRIMARY_COLOR + "; color: #fff; cursor: pointer; z-index: 2147483646;" +
      "  box-shadow: 0 4px 16px rgba(0,0,0,0.2); display: flex; align-items: center;" +
      "  justify-content: center; transition: transform 0.2s;" +
      "}" +
      ".ai-chat-fab:hover { transform: scale(1.08); }" +
      "@media (max-width: 480px) {" +
      "  .ai-chat-container { width: calc(100vw - 20px); height: calc(100vh - 100px); bottom: 70px; right: 10px; left: 10px; }" +
      "}"
    );
  }

  // --- Init ---
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      createWidget();
      watchDataLang();
    });
  } else {
    createWidget();
    watchDataLang();
  }
})();
