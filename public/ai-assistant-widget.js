/**
 * AI Assistant Widget — embeddable chat widget script.
 *
 * Served from: /api/public/ai-assistant/:secret_token/script.js
 * Placeholders {{SECRET_TOKEN}}, {{BASE_URL}}, {{DEFAULT_LANGUAGE}},
 * {{DISPLAY_NAME}}, {{PRIMARY_COLOR}}, {{SECONDARY_COLOR}},
 * {{GREETING_MESSAGE}}, {{LEGAL_MESSAGE}}, {{POPUP_MESSAGE}}, {{POSITION}}, {{AVATAR_URL}},
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
  var LEGAL_MESSAGE = "{{LEGAL_MESSAGE}}";
  var POPUP_MESSAGE = "{{POPUP_MESSAGE}}";
  var POSITION = "{{POSITION}}";
  var AVATAR_URL = "{{AVATAR_URL}}";
  var SUPPORTED_LANGUAGES = {{SUPPORTED_LANGUAGES}};
  var TRANSLATIONS = {{TRANSLATIONS}};

  var currentLang = (function () {
    // Priority 1: data-lang attribute on the <script> tag (explicit override)
    var scriptEl = document.currentScript;
    if (scriptEl) {
      var dl = scriptEl.getAttribute("data-lang");
      if (dl && dl.length >= 2) return dl;
    }
    // Priority 1b: Scan existing <script> tags for the one loading this widget
    // (document.currentScript is null when loaded dynamically)
    var scripts = document.querySelectorAll("script[data-lang]");
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].getAttribute("src") || "";
      if (src.indexOf(SECRET_TOKEN) !== -1) {
        var dl2 = scripts[i].getAttribute("data-lang");
        if (dl2 && dl2.length >= 2) return dl2;
      }
    }
    // Priority 1c: Any script tag with data-lang that hasn't loaded yet
    if (scripts.length > 0) {
      var dl3 = scripts[0].getAttribute("data-lang");
      if (dl3 && dl3.length >= 2) return dl3;
    }
    // Priority 2: <html lang="..."> attribute on the host page
    var htmlLang = document.documentElement && document.documentElement.lang;
    if (htmlLang && htmlLang.length >= 2) return htmlLang.slice(0, 10);
    // Priority 3: navigator.language / navigator.languages[0]
    if (navigator.languages && navigator.languages.length > 0) {
      return navigator.languages[0];
    }
    if (navigator.language) return navigator.language;
    // Priority 4: Fallback to assistant's default_language
    return DEFAULT_LANGUAGE;
  })();
  var sessionId = null;
  var messages = [];
  var isOpen = false;
  var isStreaming = false;
  var widgetRoot = null;
  var chatContainer = null;
  var messagesContainer = null;
  var inputEl = null;
  var greetingSent = false;
  var legalSent = false;
  var popupDismissed = false;
  var isDisabled = true; // widget starts hidden; call window.__aiAssistant.enable() to show

  // --- Lightweight Markdown renderer (chat-safe, XSS-proof) ---
  function renderMarkdown(text) {
    if (!text) return "";
    // 1. HTML-escape everything
    var s = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    // 2. Inline formatting (before block processing)
    // Links: [text](url) — only http/https/mailto protocols allowed
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, linkText, url) {
      var safeUrl = url.replace(/"/g, "&quot;");
      if (/^(https?:\/\/|mailto:)/i.test(safeUrl)) {
        return '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + linkText + '</a>';
      }
      return "[" + linkText + "](" + url + ")";
    });
    // Bold
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Italic
    s = s.replace(/\*([^*]+?)\*/g, "<em>$1</em>");
    // Inline code
    s = s.replace(/`([^`]+?)`/g, "<code>$1</code>");
    // 3. Split into lines, detect bullet lists
    var lines = s.split("\n");
    var out = [];
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var bulletMatch = line.match(/^\s*[-\u2022]\s+(.*)/);
      if (bulletMatch) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + bulletMatch[1] + "</li>");
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        if (line.trim() === "") {
          out.push("<br>");
        } else {
          out.push(line + "<br>");
        }
      }
    }
    if (inList) out.push("</ul>");
    return out.join("\n");
  }

  // --- Built-in UI translations (widget chrome, not assistant content) ---
  var BUILTIN_TRANSLATIONS = {
    en: { online: "Online", placeholder: "Type a message...", poweredBy: "Powered by", send: "Send", error: "Sorry, something went wrong. Please try again." },
    hu: { online: "Azonnal elérhető", placeholder: "Írj üzenetet...", poweredBy: "Üzemelteti", send: "Küldés", error: "Elnézést, valami hiba történt. Kérlek, próbáld újra." },
    de: { online: "Online", placeholder: "Nachricht eingeben...", poweredBy: "Bereitgestellt von", send: "Senden" },
    fr: { online: "En ligne", placeholder: "Écrivez un message...", poweredBy: "Propulsé par", send: "Envoyer" },
    es: { online: "En línea", placeholder: "Escribe un mensaje...", poweredBy: "Desarrollado por", send: "Enviar" },
    it: { online: "Online", placeholder: "Scrivi un messaggio...", poweredBy: "Offerto da", send: "Invia" },
    pt: { online: "Online", placeholder: "Digite uma mensagem...", poweredBy: "Desenvolvido por", send: "Enviar" },
    nl: { online: "Online", placeholder: "Typ een bericht...", poweredBy: "Mogelijk gemaakt door", send: "Verzenden" },
    pl: { online: "Online", placeholder: "Napisz wiadomość...", poweredBy: "Na podstawie", send: "Wyślij" },
    cs: { online: "Online", placeholder: "Napište zprávu...", poweredBy: "Vytvořil", send: "Odeslat" },
    ro: { online: "Online", placeholder: "Scrie un mesaj...", poweredBy: "Oferit de", send: "Trimite" },
    sk: { online: "Online", placeholder: "Napíšte správu...", poweredBy: "Vytvoril", send: "Odoslať" },
    hr: { online: "Online", placeholder: "Napišite poruku...", poweredBy: "Omogućio", send: "Pošalji" },
    sl: { online: "Online", placeholder: "Napišite sporočilo...", poweredBy: "Omogoča", send: "Pošlji" },
    sr: { online: "У мрежи", placeholder: "Напишите поруку...", poweredBy: "Омогућио", send: "Пошаљи" },
    uk: { online: "Онлайн", placeholder: "Напишіть повідомлення...", poweredBy: "Створено", send: "Надіслати" },
    ru: { online: "Онлайн", placeholder: "Введите сообщение...", poweredBy: "При поддержке", send: "Отправить" },
    tr: { online: "Çevrimiçi", placeholder: "Bir mesaj yazın...", poweredBy: "Sunan", send: "Gönder" },
    zh: { online: "在线", placeholder: "输入消息...", poweredBy: "由", send: "发送" },
    ja: { online: "オンライン", placeholder: "メッセージを入力...", poweredBy: "提供", send: "送信" },
    ko: { online: "온라인", placeholder: "메시지를 입력하세요...", poweredBy: "제공", send: "보내기" },
  };

  // --- Translation helpers ---
  function getTranslation(key, lang) {
    lang = lang || currentLang;
    // 1. Check server-provided translations (admin-configured per-assistant)
    if (TRANSLATIONS && Array.isArray(TRANSLATIONS)) {
      for (var i = 0; i < TRANSLATIONS.length; i++) {
        if (TRANSLATIONS[i].language === lang && TRANSLATIONS[i][key]) {
          return TRANSLATIONS[i][key];
        }
      }
    }
    // 2. Fall back to built-in UI translations
    var shortLang = (lang || "").slice(0, 2).toLowerCase();
    if (BUILTIN_TRANSLATIONS[shortLang] && BUILTIN_TRANSLATIONS[shortLang][key]) {
      return BUILTIN_TRANSLATIONS[shortLang][key];
    }
    // 3. Fall back to English
    if (shortLang !== "en" && BUILTIN_TRANSLATIONS.en && BUILTIN_TRANSLATIONS.en[key]) {
      return BUILTIN_TRANSLATIONS.en[key];
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
    // Remove any existing widget host (idempotent re-init)
    var existing = document.getElementById("ai-assistant-widget-host");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    // Reset state flags so greeting/legal show again on recreation
    greetingSent = false;
    legalSent = false;
    popupDismissed = false;

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
    chatContainer.className = "ai-chat-container ai-chat-hidden";
    chatContainer.style.display = "none";
    shadow.appendChild(chatContainer);

    // Chat header
    var header = document.createElement("div");
    header.className = "ai-chat-header";
    var avatarHtml = AVATAR_URL
      ? '<img class="ai-chat-avatar" src="' + escHtml(AVATAR_URL) + '" alt="" />'
      : '<div class="ai-chat-avatar-placeholder">' + escHtml(getDisplayName().charAt(0)) + '</div>';
    header.innerHTML =
      '<div class="ai-chat-header-info">' +
      avatarHtml +
      '<div class="ai-chat-header-text">' +
      '<span class="ai-chat-title">' + escHtml(getDisplayName()) + "</span>" +
      '<span class="ai-chat-status">' + getOnlineText() + '</span>' +
      '</div>' +
      "</div>" +
      '<button class="ai-chat-close" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
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
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    sendBtn.setAttribute("aria-label", getTranslation("send") || "Send");
    inputArea.appendChild(inputEl);
    inputArea.appendChild(sendBtn);
    chatContainer.appendChild(inputArea);

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

    // Popup message bubble (shown on every page load, dismissed on open)
    if (POPUP_MESSAGE) {
      popupDismissed = false;
      var popup = document.createElement("div");
      popup.className = "ai-popup-bubble";
      popup.innerHTML = escHtml(POPUP_MESSAGE);
      popup.addEventListener("click", function () {
        toggleChat(true);
      });
      shadow.appendChild(popup);
      // Start nudge animation after a short delay
      setTimeout(function () {
        popup.classList.add("ai-popup-nudge");
      }, 1500);
    }

    widgetRoot = shadow;

    // Send greeting after a short delay
    setTimeout(function () {
      sendGreeting();
    }, 500);
  }

  function getOnlineText() {
    return getTranslation("online", currentLang) || "Online";
  }

  function sendGreeting() {
    if (greetingSent) return;
    greetingSent = true;
    // Send legal message first if present
    if (!legalSent && LEGAL_MESSAGE) {
      legalSent = true;
      addMessage("assistant", LEGAL_MESSAGE);
    }
    addMessage("assistant", getGreeting());
  }

  function toggleChat(open) {
    isOpen = open;
    // Lock body scroll on mobile so the page doesn't shift when keyboard opens
    if (window.innerWidth <= 480) {
      if (open) {
        document.body.style.overflow = "hidden";
        document.body.style.position = "fixed";
        document.body.style.width = "100%";
      } else {
        document.body.style.overflow = "";
        document.body.style.position = "";
        document.body.style.width = "";
      }
    }
    // Dismiss popup bubble on open
    if (open && !popupDismissed) {
      popupDismissed = true;
      var popup = widgetRoot && widgetRoot.querySelector(".ai-popup-bubble");
      if (popup) {
        popup.classList.add("ai-popup-hide");
        setTimeout(function () {
          if (popup.parentNode) popup.parentNode.removeChild(popup);
        }, 300);
      }
    }
    if (chatContainer) {
      if (open) {
        chatContainer.style.display = "";
        chatContainer.classList.remove("ai-chat-hidden");
        chatContainer.classList.add("ai-chat-visible");
        // Position correctly on mobile before keyboard opens
        attachKeyboardListeners();
        adjustForKeyboard();
      } else {
        chatContainer.classList.remove("ai-chat-visible");
        chatContainer.classList.add("ai-chat-hidden");
        // Reset inline positioning so desktop CSS takes over
        if (window.innerWidth <= 480) {
          chatContainer.style.position = "";
          chatContainer.style.top = "";
          chatContainer.style.bottom = "";
          chatContainer.style.left = "";
          chatContainer.style.right = "";
          chatContainer.style.height = "";
        }
        setTimeout(function () {
          if (!isOpen) chatContainer.style.display = "none";
        }, 350);
      }
    }
    // Toggle FAB icon between chat and close
    var fab = widgetRoot && widgetRoot.querySelector(".ai-chat-fab");
    if (fab) {
      if (open) {
        fab.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        fab.classList.add("ai-chat-fab-active");
      } else {
        fab.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';
        fab.classList.remove("ai-chat-fab-active");
      }
    }
    if (open && inputEl) {
      // On mobile, prevent the browser from scrolling the page to the
      // input when the keyboard opens. The body is already locked via
      // position:fixed, but some browsers still try to scroll.
      setTimeout(function () {
        inputEl.focus({ preventScroll: true });
        scrollToBottom();
      }, 300);
    }
  }

  function addMessage(role, content) {
    messages.push({ role: role, content: content, lang: currentLang });
    if (!messagesContainer) return;

    var div = document.createElement("div");
    div.className = "ai-chat-message ai-chat-message-" + role + " ai-chat-msg-enter";
    var bubble = document.createElement("div");
    bubble.className = "ai-chat-bubble";
    if (role === "assistant") {
      bubble.innerHTML = renderMarkdown(content);
    } else {
      bubble.textContent = content;
    }
    div.appendChild(bubble);
    messagesContainer.appendChild(div);
    scrollToBottom();
  }

  function createTypingIndicator() {
    var div = document.createElement("div");
    div.className = "ai-chat-message ai-chat-message-assistant ai-chat-msg-enter";
    var bubble = document.createElement("div");
    bubble.className = "ai-chat-bubble ai-chat-bubble-typing";
    bubble.innerHTML = '<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>';
    div.appendChild(bubble);
    messagesContainer.appendChild(div);
    scrollToBottom();
    return { div: div, bubble: bubble };
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

    // Create typing indicator
    var typing = createTypingIndicator();

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
        sessionId = res.headers.get("X-Session-Id") || sessionId;
        if (!res.ok) throw new Error("Chat request failed");
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var fullText = "";
        var started = false;

        function read() {
          return reader.read().then(function (result) {
            if (result.done) {
              isStreaming = false;
              typing.bubble.classList.remove("ai-chat-bubble-typing");
              typing.bubble.innerHTML = renderMarkdown(fullText);
              typing.bubble.classList.add("ai-chat-msg-enter");
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
                    if (!started) {
                      typing.bubble.innerHTML = "";
                      typing.bubble.classList.remove("ai-chat-bubble-typing");
                      started = true;
                    }
                    fullText += data.content;
                    typing.bubble.innerHTML = renderMarkdown(fullText);
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
        typing.bubble.classList.remove("ai-chat-bubble-typing");
        typing.bubble.textContent = getTranslation("error") || "Sorry, something went wrong. Please try again.";
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
      var statusEl = widgetRoot.querySelector(".ai-chat-status");
      if (statusEl) statusEl.textContent = getOnlineText();
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
      fetch(BASE_URL + "/api/public/ai-assistant/" + SECRET_TOKEN + "/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId, lang: lang }),
      }).catch(function () {});
    }
  }

  // --- Global API ---
  window.__aiAssistant = {
    setLanguage: setLanguage,
    enable: function () {
      if (!isDisabled) return;
      isDisabled = false;
      createWidget();
      watchDataLang();
    },
    disable: function () {
      isDisabled = true;
      // Stop the restore observer so it doesn't re-create the widget
      if (restoreObserver) {
        restoreObserver.disconnect();
        restoreObserver = null;
      }
      // Remove the DOM element
      var host = document.getElementById("ai-assistant-widget-host");
      if (host && host.parentNode) host.parentNode.removeChild(host);
      // Reset state
      widgetRoot = null;
      chatContainer = null;
      messagesContainer = null;
      inputEl = null;
      isOpen = false;
      isStreaming = false;
      greetingSent = false;
      legalSent = false;
      popupDismissed = false;
      messages = [];
      sessionId = null;
    },
  };

  // Listen for CustomEvent language changes
  document.addEventListener("ai-assistant:language-change", function (e) {
    if (e.detail && e.detail.lang) {
      setLanguage(e.detail.lang);
    }
  });

  // --- MutationObserver on data-lang attribute ---
  function watchDataLang() {
    var scriptEl = document.getElementById("ai-assistant-widget");
    if (!scriptEl) {
      // Try to find by src attribute
      var scripts = document.querySelectorAll('script[src*="/ai-assistant/"]');
      for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].getAttribute("data-lang") !== null) {
          scriptEl = scripts[i];
          break;
        }
      }
    }
    if (!scriptEl) return;
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].attributeName === "data-lang") {
          var newLang = scriptEl.getAttribute("data-lang");
          if (newLang) setLanguage(newLang);
        }
      }
    });
    observer.observe(scriptEl, { attributes: true, attributeFilter: ["data-lang"] });
  }

  // --- Styles ---
  function getStyles() {
    var posRight = POSITION === "bottom-left" ? "auto" : "10px";
    var posLeft = POSITION === "bottom-left" ? "10px" : "auto";
    var posStyle = "right: " + posRight + "; left: " + posLeft + ";";

    return (
      // Reset
      ":host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }" +

      // --- Keyframes ---
      "@keyframes ai-fab-ring {" +
      "  0% { transform: scale(1); opacity: 0.5; }" +
      "  100% { transform: scale(1.15); opacity: 0; }" +
      "}" +
      "@keyframes ai-popup-nudge {" +
      "  0%, 100% { transform: translateX(0); }" +
      "  15% { transform: translateX(-6px) rotate(-1deg); }" +
      "  30% { transform: translateX(5px) rotate(0.5deg); }" +
      "  45% { transform: translateX(-4px); }" +
      "  60% { transform: translateX(3px); }" +
      "  75% { transform: translateX(-1px); }" +
      "}" +
      "@keyframes ai-popup-in {" +
      "  from { opacity: 0; transform: scale(0.8) translateY(8px); }" +
      "  to { opacity: 1; transform: scale(1) translateY(0); }" +
      "}" +
      "@keyframes ai-popup-out {" +
      "  from { opacity: 1; transform: scale(1) translateY(0); }" +
      "  to { opacity: 0; transform: scale(0.8) translateY(8px); }" +
      "}" +
      "@keyframes ai-panel-in {" +
      "  from { opacity: 0; transform: translateY(16px) scale(0.96); }" +
      "  to { opacity: 1; transform: translateY(0) scale(1); }" +
      "}" +
      "@keyframes ai-panel-out {" +
      "  from { opacity: 1; transform: translateY(0) scale(1); }" +
      "  to { opacity: 0; transform: translateY(16px) scale(0.96); }" +
      "}" +
      "@keyframes ai-msg-in {" +
      "  from { opacity: 0; transform: translateY(8px); }" +
      "  to { opacity: 1; transform: translateY(0); }" +
      "}" +
      "@keyframes ai-typing-bounce {" +
      "  0%, 60%, 100% { transform: translateY(0); }" +
      "  30% { transform: translateY(-4px); }" +
      "}" +
      "@keyframes ai-fade-in {" +
      "  from { opacity: 0; }" +
      "  to { opacity: 1; }" +
      "}" +

      // --- Chat panel ---
      ".ai-chat-container {" +
      "  position: fixed; " + posStyle +
      "  bottom: 80px; width: 380px; max-width: calc(100vw - 20px); height: 520px; max-height: calc(100vh - 100px);" +
      "  background: " + SECONDARY_COLOR + "; border-radius: 16px;" +
      "  box-shadow: 0 12px 48px rgba(0,0,0,0.15), 0 2px 8px rgba(0,0,0,0.08);" +
      "  display: flex; flex-direction: column; overflow: hidden; z-index: 2147483647;" +
      "  border: 1px solid rgba(0,0,0,0.06);" +
      "  transition: opacity 0.3s cubic-bezier(0.4,0,0.2,1), transform 0.3s cubic-bezier(0.4,0,0.2,1);" +
      "}" +
      ".ai-chat-hidden {" +
      "  opacity: 0; pointer-events: none; transform: translateY(16px) scale(0.96);" +
      "}" +
      ".ai-chat-visible {" +
      "  opacity: 1; pointer-events: auto; transform: translateY(0) scale(1);" +
      "  animation: ai-panel-in 0.35s cubic-bezier(0.4,0,0.2,1) forwards;" +
      "}" +

      // --- Header ---
      ".ai-chat-header {" +
      "  background: linear-gradient(135deg, " + PRIMARY_COLOR + ", " + PRIMARY_COLOR + "dd); color: #fff; padding: 14px 16px;" +
      "  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;" +
      "}" +
      ".ai-chat-header-info { display: flex; align-items: center; gap: 10px; }" +
      ".ai-chat-header-text { display: flex; flex-direction: column; gap: 1px; }" +
      ".ai-chat-avatar, .ai-chat-avatar-placeholder {" +
      "  width: 36px; height: 36px; border-radius: 50%; object-fit: cover;" +
      "  border: 2px solid rgba(255,255,255,0.3);" +
      "}" +
      ".ai-chat-avatar-placeholder {" +
      "  background: rgba(255,255,255,0.2); display: flex; align-items: center;" +
      "  justify-content: center; font-size: 14px; font-weight: 600; color: #fff;" +
      "  backdrop-filter: blur(4px);" +
      "}" +
      ".ai-chat-title { font-size: 15px; font-weight: 600; line-height: 1.2; }" +
      ".ai-chat-status { font-size: 11px; opacity: 0.8; display: flex; align-items: center; gap: 4px; }" +
      ".ai-chat-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #4ade80; display: inline-block; animation: ai-fade-in 1s ease; }" +
      ".ai-chat-close {" +
      "  background: none; border: none; color: #fff; cursor: pointer;" +
      "  opacity: 0.7; transition: opacity 0.2s, transform 0.2s;" +
      "  border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;" +
      "  transform-origin: center center;" +
      "}" +
      ".ai-chat-close:hover { opacity: 1; transform: rotate(90deg); }" +

      // --- Messages ---
      ".ai-chat-messages {" +
      "  flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px;" +
      "  scroll-behavior: smooth;" +
      "}" +
      ".ai-chat-messages::-webkit-scrollbar { width: 4px; }" +
      ".ai-chat-messages::-webkit-scrollbar-track { background: transparent; }" +
      ".ai-chat-messages::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 2px; }" +
      ".ai-chat-message { display: flex; }" +
      ".ai-chat-message-user { justify-content: flex-end; }" +
      ".ai-chat-message-assistant { justify-content: flex-start; }" +
      ".ai-chat-message-system { justify-content: center; }" +
      ".ai-chat-msg-enter { animation: ai-msg-in 0.3s cubic-bezier(0.4,0,0.2,1) forwards; }" +
      ".ai-chat-bubble {" +
      "  max-width: 80%; padding: 10px 14px; border-radius: 18px; font-size: 14px;" +
      "  line-height: 1.45; word-break: break-word;" +
      "  box-shadow: 0 1px 2px rgba(0,0,0,0.06);" +
      "}" +
      ".ai-chat-message-user .ai-chat-bubble { white-space: pre-wrap; }" +
      ".ai-chat-message-assistant .ai-chat-bubble { white-space: normal; }" +
      ".ai-chat-bubble strong { font-weight: 600; }" +
      ".ai-chat-bubble em { font-style: italic; }" +
      ".ai-chat-bubble code { background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 4px; font-size: 13px; font-family: inherit; }" +
      ".ai-chat-bubble ul { margin: 6px 0; padding-left: 20px; }" +
      ".ai-chat-bubble li { margin: 3px 0; }" +
      ".ai-chat-bubble a { color: " + PRIMARY_COLOR + "; text-decoration: underline; text-underline-offset: 2px; }" +
      ".ai-chat-bubble a:hover { opacity: 0.8; }" +
      ".ai-chat-message-user .ai-chat-bubble {" +
      "  background: " + PRIMARY_COLOR + "; color: #fff; border-bottom-right-radius: 4px;" +
      "  box-shadow: 0 2px 8px " + PRIMARY_COLOR + "33;" +
      "}" +
      ".ai-chat-message-assistant .ai-chat-bubble {" +
      "  background: #f1f3f5; color: #1a1a1a; border-bottom-left-radius: 4px;" +
      "}" +
      ".ai-chat-message-system .ai-chat-bubble {" +
      "  background: transparent; color: #868e96; font-size: 12px; font-style: italic; padding: 4px 8px;" +
      "  box-shadow: none;" +
      "}" +

      // --- Typing indicator ---
      ".ai-chat-bubble-typing {" +
      "  display: inline-flex; align-items: center; gap: 4px; padding: 12px 16px;" +
      "  background: #f1f3f5; min-width: 48px; justify-content: center;" +
      "}" +
      ".ai-typing-dot {" +
      "  width: 7px; height: 7px; border-radius: 50%; background: #adb5bd;" +
      "  animation: ai-typing-bounce 1.2s ease-in-out infinite;" +
      "}" +
      ".ai-typing-dot:nth-child(2) { animation-delay: 0.15s; }" +
      ".ai-typing-dot:nth-child(3) { animation-delay: 0.3s; }" +

      // --- Input area ---
      ".ai-chat-input-area {" +
      "  padding: 12px; border-top: 1px solid #f0f0f0; display: flex; gap: 8px; flex-shrink: 0;" +
      "  background: " + SECONDARY_COLOR + ";" +
      "}" +
      ".ai-chat-input {" +
      "  flex: 1; border: 1.5px solid #e9ecef; border-radius: 24px; padding: 10px 16px;" +
      "  font-size: 14px; outline: none; background: #fff; color: #1a1a1a;" +
      "  transition: border-color 0.2s, box-shadow 0.2s; font-family: inherit;" +
      "}" +
      ".ai-chat-input:focus { border-color: " + PRIMARY_COLOR + "; box-shadow: 0 0 0 3px " + PRIMARY_COLOR + "15; }" +
      ".ai-chat-input::placeholder { color: #adb5bd; }" +
      ".ai-chat-send {" +
      "  width: 40px; height: 40px; border-radius: 50%; border: none; background: " + PRIMARY_COLOR + ";" +
      "  color: #fff; cursor: pointer; display: flex; align-items: center;" +
      "  justify-content: center; flex-shrink: 0; transition: transform 0.15s, box-shadow 0.15s;" +
      "  box-shadow: 0 2px 8px " + PRIMARY_COLOR + "33;" +
      "}" +
      ".ai-chat-send:hover { transform: scale(1.08); box-shadow: 0 4px 12px " + PRIMARY_COLOR + "44; }" +
      ".ai-chat-send:active { transform: scale(0.95); }" +

      // --- FAB ---
      ".ai-chat-fab {" +
      "  position: fixed; " + posStyle +
      "  bottom: 20px; width: 56px; height: 56px; border-radius: 50%; border: 2px solid " + SECONDARY_COLOR + ";" +
      "  background: " + PRIMARY_COLOR + "; color: #fff; cursor: pointer; z-index: 2147483648;" +
      "  box-shadow: 0 4px 16px rgba(0,0,0,0.2); display: flex; align-items: center;" +
      "  justify-content: center;" +
      "  transition: transform 0.15s ease;" +
      "  pointer-events: auto !important;" +
      "}" +
      ".ai-chat-fab::after {" +
      "  content: ''; position: absolute; inset: 0; border-radius: 50%;" +
      "  border: 2px solid " + PRIMARY_COLOR + "; opacity: 0;" +
      "  pointer-events: none; animation: ai-fab-ring 3s ease-out infinite;" +
      "}" +
      ".ai-chat-fab:hover { transform: scale(1.1); }" +
      ".ai-chat-fab:hover::after { animation-play-state: paused; }" +
      ".ai-chat-fab:active { transform: scale(0.95); }" +
      ".ai-chat-fab-active {" +
      "  border-radius: 16px;" +
      "  transform: rotate(0deg); transition: transform 0.3s, border-radius 0.3s;" +
      "}" +
      ".ai-chat-fab-active::after { animation: none; }" +
      ".ai-chat-fab-active:hover { transform: scale(1.08); }" +

      // --- Popup bubble ---
      ".ai-popup-bubble {" +
      "  position: fixed; " + posStyle +
      "  bottom: 90px; max-width: 260px; padding: 12px 16px;" +
      "  background: #fff; color: #1a1a1a; border-radius: 16px;" +
      "  box-shadow: 0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08);" +
      "  font-size: 14px; line-height: 1.4; cursor: pointer;" +
      "  z-index: 2147483645; animation: ai-popup-in 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards;" +
      "  transition: opacity 0.25s ease, transform 0.25s ease;" +
      "  border: 1px solid rgba(0,0,0,0.05);" +
      "}" +
      (POSITION === "bottom-left"
        ? ".ai-popup-bubble::after { content: ''; position: absolute; bottom: -10px; left: 18px; border-width: 10px 8px 0 8px; border-style: solid; border-color: #fff transparent transparent transparent; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.08)); }"
        : ".ai-popup-bubble::after { content: ''; position: absolute; bottom: -10px; right: 18px; border-width: 10px 8px 0 8px; border-style: solid; border-color: #fff transparent transparent transparent; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.08)); }") +
      ".ai-popup-nudge { animation: ai-popup-in 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards, ai-popup-nudge 0.8s ease-in-out 0.35s 1; }" +
      ".ai-popup-hide { opacity: 0; transform: scale(0.85) translateY(8px); pointer-events: none; }" +

      // --- Mobile ---
      "@media (max-width: 480px) {" +
      "  .ai-chat-container {" +
      "    width: calc(100vw - 20px) !important;" +
      "    left: 10px !important; right: 10px !important;" +
      "    border-radius: 14px;" +
      "  }" +
      "  .ai-chat-fab { bottom: 16px; width: 52px; height: 52px; right: 10px !important; left: auto !important; z-index: 2147483646; }" +
      "}"
    );
  }

  // --- Init ---
  // Widget starts disabled — call window.__aiAssistant.enable() to show it.
  // The restore observers and SPA hooks are already gated on !isDisabled,
  // so they won't fire until enable() is called.

  // --- Mobile keyboard handling ---
  // On iOS Safari, position:fixed with bottom stays at the layout viewport
  // bottom (behind the keyboard), not the visual viewport. We use
  // visualViewport to calculate top + height so the widget always sits
  // exactly in the visible area above the keyboard.
  var _kkAttached = false;
  function adjustForKeyboard() {
    if (isDisabled || !chatContainer) return;
    if (window.innerWidth > 480) return;
    if (!window.visualViewport) return;
    var vv = window.visualViewport;
    var vh = vv.height;
    var offset = vv.offsetTop || 0;
    // Position: 10px from top of visible area, fill down to 10px from bottom
    chatContainer.style.position = "fixed";
    chatContainer.style.top = (offset + 10) + "px";
    chatContainer.style.left = "10px";
    chatContainer.style.right = "10px";
    chatContainer.style.bottom = "auto";
    chatContainer.style.height = Math.max(vh - 20, 100) + "px";
  }
  function attachKeyboardListeners() {
    if (_kkAttached || !window.visualViewport) return;
    _kkAttached = true;
    window.visualViewport.addEventListener("resize", adjustForKeyboard);
    window.visualViewport.addEventListener("scroll", adjustForKeyboard);
  }

  // --- Auto-restore on DOM removal (generic SPA fallback) ---
  var restoreObserver = new MutationObserver(function () {
    if (!isDisabled && !document.getElementById("ai-assistant-widget-host")) {
      createWidget();
    }
  });
  restoreObserver.observe(document.documentElement, { childList: true, subtree: true });

  // --- Astro View Transitions support ---
  document.addEventListener("astro:page-load", function () {
    if (!isDisabled && !document.getElementById("ai-assistant-widget-host")) {
      window.__aiAssistant = undefined;
      createWidget();
    }
  });

  // --- Next.js / generic SPA (popstate) ---
  window.addEventListener("popstate", function () {
    setTimeout(function () {
      if (!isDisabled && !document.getElementById("ai-assistant-widget-host")) {
        window.__aiAssistant = undefined;
        createWidget();
      }
    }, 100);
  });
})();
