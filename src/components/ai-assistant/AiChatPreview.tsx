// ----------------------------------------------------------------------------
// AiChatPreview — live preview of the chat widget inside the admin UI.
// Renders a miniature version of the widget using the current config's
// branding settings so admins can see how it will look without embedding.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { Bot, Send, X } from "lucide-react";
import { useState } from "react";
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";

interface AiChatPreviewProps {
  config: AiAssistantConfigDTO;
}

export function AiChatPreview({ config }: AiChatPreviewProps) {
  const { t } = useTranslation(["ai-assistant"]);
  const [isOpen, setIsOpen] = useState(false);

  const primaryColor = config.primaryColor || "#3b82f6";
  const secondaryColor = config.secondaryColor || "#ffffff";
  const displayName = config.displayName || "AI Assistant";
  const greeting = config.greetingMessage || "Hello! How can I help you today?";
  const position = config.position || "bottom-right";

  return (
    <div className="relative h-[420px] rounded-lg border bg-gray-100 overflow-hidden">
      {/* Label */}
      <div className="absolute top-2 left-2 z-10 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white">
        {t("ai_assistant_details")} — {t("ai_assistant:branding_section")}
      </div>

      {/* Simulated page background */}
      <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">
        Host website
      </div>

      {/* Chat FAB */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="absolute bottom-4 flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105"
          style={{
            background: primaryColor,
            color: "#fff",
            ...(position === "bottom-left" ? { left: 16 } : { right: 16 }),
          }}
        >
          <Bot className="h-5 w-5" />
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div
          className="absolute bottom-0 flex flex-col overflow-hidden rounded-t-xl shadow-xl"
          style={{
            background: secondaryColor,
            width: 320,
            height: 380,
            ...(position === "bottom-left" ? { left: 8 } : { right: 8 }),
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ background: primaryColor, color: "#fff" }}
          >
            <span className="text-sm font-semibold">{displayName}</span>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/80 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4">
            {/* Greeting bubble */}
            <div className="mb-3 flex">
              <div
                className="max-w-[80%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm"
                style={{ background: "#f1f3f5", color: "#1a1a1a" }}
              >
                {greeting}
              </div>
            </div>
          </div>

          {/* Input */}
          <div
            className="flex items-center gap-2 border-t px-3 py-2"
            style={{ borderColor: "#e9ecef", background: secondaryColor }}
          >
            <input
              readOnly
              placeholder={t("ai_assistant:translation_placeholder", "Type a message...")}
              className="flex-1 rounded-full border px-3 py-1.5 text-sm outline-none"
              style={{ borderColor: "#dee2e6" }}
            />
            <button
              className="flex h-8 w-8 items-center justify-center rounded-full"
              style={{ background: primaryColor, color: "#fff" }}
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Copyright */}
          <div className="border-t px-2 py-1 text-center text-[10px]" style={{ color: "#adb5bd", borderColor: "#f1f3f5" }}>
            Powered by{" "}
            <a href="https://zsoltberta.hu" target="_blank" rel="noopener noreferrer" style={{ color: primaryColor }}>
              Zsolt Berta
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
