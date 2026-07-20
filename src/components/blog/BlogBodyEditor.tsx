// ----------------------------------------------------------------------------
// BlogBodyEditor — Tiptap-based rich-text editor for blog post bodies.
//
// Features:
//   - Full toolbar: headings (H1-H4), bold, italic, lists, blockquote,
//     code (inline + block with syntax highlighting), link, image,
//     horizontal rule, text alignment, undo/redo
//   - Live preview toggle — switches between WYSIWYG edit and a rendered
//     preview that shows exactly how the post will look on the landing page
//   - Syntax highlighting via lowlight (highlight.js) for code blocks
//   - Brand-color-aware — accepts a brandColor CSS var for theming
//   - Keyboard shortcuts: Ctrl+B (bold), Ctrl+I (italic), Ctrl+Z/Y (undo/redo)
//
// We bridge Tiptap's useEditor() hook with RHF via a Controller-friendly
// component. The BE re-sanitizes on write via lib/sanitize.js.
// ----------------------------------------------------------------------------

import React from "react";
import { useEditor, EditorContent, Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Highlight from "@tiptap/extension-highlight";
import Typography from "@tiptap/extension-typography";
import { common, createLowlight } from "lowlight";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  List,
  ListOrdered,
  Quote,
  Code,
  FileCode2,
  Link as LinkIcon,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Minus,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Eye,
  Pencil,
} from "lucide-react";
import "./blog-prose.css";

// Initialize lowlight with common languages
const lowlight = createLowlight(common);

export interface BlogBodyChange {
  html: string;
  json: Record<string, unknown> | null;
}

interface BlogBodyEditorProps {
  initialJson?: Record<string, unknown> | null;
  initialHtml?: string;
  placeholder?: string;
  brandColor?: string;
  onChange: (value: BlogBodyChange) => void;
}

const BlogBodyEditor: React.FC<BlogBodyEditorProps> = ({
  initialJson,
  initialHtml,
  placeholder,
  brandColor,
  onChange,
}) => {
  const { t } = useTranslation("blog");
  const [linkPromptOpen, setLinkPromptOpen] = React.useState(false);
  const [linkUrl, setLinkUrl] = React.useState("");
  const [imagePromptOpen, setImagePromptOpen] = React.useState(false);
  const [imageUrl, setImageUrl] = React.useState("");
  const [previewMode, setPreviewMode] = React.useState(false);
  const [previewHtml, setPreviewHtml] = React.useState("");
  const [codeLanguage, setCodeLanguage] = React.useState("javascript");
  const [codeLangOpen, setCodeLangOpen] = React.useState(false);

  // Initial content resolution: prefer JSON (lossless), fall back to HTML.
  const initialContent = React.useMemo(() => {
    if (initialJson && typeof initialJson === "object") {
      return initialJson;
    }
    if (initialHtml && initialHtml.trim().length > 0) {
      return initialHtml;
    }
    return "";
  }, [initialJson, initialHtml]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        link: false,
        heading: {
          levels: [1, 2, 3, 4],
        },
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: "javascript",
      }),
      Highlight.configure({
        multicolor: false,
      }),
      Typography,
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          rel: "noopener noreferrer",
        },
      }),
      Image.configure({
        inline: false,
        allowBase64: false,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? t("blog:editor_placeholder"),
      }),
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: "blog-prose min-h-[280px] p-4 focus:outline-none",
      },
    },
    onUpdate({ editor: ed }) {
      onChange({
        html: ed.getHTML(),
        json: ed.getJSON() as Record<string, unknown>,
      });
      if (previewMode) {
        setPreviewHtml(ed.getHTML());
      }
    },
    immediatelyRender: false,
  });

  // Push initial content if it arrives after mount.
  React.useEffect(() => {
    if (!editor) return;
    if (initialContent === "") return;
    const currentHtml = editor.getHTML();
    if (currentHtml === "<p></p>" || currentHtml === "") {
      editor.commands.setContent(initialContent as never);
    }
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync preview when toggling to preview mode.
  React.useEffect(() => {
    if (previewMode && editor) {
      setPreviewHtml(editor.getHTML());
    }
  }, [previewMode, editor]);

  const insertLink = () => {
    if (!editor) return;
    if (!linkUrl.trim()) {
      editor.chain().focus().unsetLink().run();
    } else {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: linkUrl.trim() })
        .run();
    }
    setLinkUrl("");
    setLinkPromptOpen(false);
  };

  const insertImage = () => {
    if (!editor || !imageUrl.trim()) {
      setImagePromptOpen(false);
      return;
    }
    editor.chain().focus().setImage({ src: imageUrl.trim() }).run();
    setImageUrl("");
    setImagePromptOpen(false);
  };

  const setCodeBlockLanguage = (lang: string) => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .toggleCodeBlock({ language: lang })
      .run();
    setCodeLanguage(lang);
    setCodeLangOpen(false);
  };

  const brandStyle = brandColor
    ? ({ "--blog-brand": brandColor } as React.CSSProperties)
    : undefined;

  if (!editor) {
    return (
      <div className="rounded-md border border-input bg-background p-4 text-sm text-muted-foreground min-h-[280px] flex items-center justify-center">
        {t("blog:editor_loading")}
      </div>
    );
  }

  const commonLangs = [
    "javascript",
    "typescript",
    "html",
    "css",
    "json",
    "python",
    "rust",
    "go",
    "bash",
    "sql",
    "markdown",
    "xml",
    "yaml",
  ];

  return (
    <div className="rounded-md border border-input bg-background overflow-hidden" style={brandStyle}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-input bg-muted/30 px-2 py-1.5">
        {/* Text formatting */}
        <ToolbarButton
          label={t("blog:editor_bold")}
          isActive={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          icon={<Bold className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_italic")}
          isActive={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          icon={<Italic className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_code")}
          isActive={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
          icon={<Code className="h-4 w-4" />}
        />
        <ToolbarButton
          label="Highlight"
          isActive={editor.isActive("highlight")}
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          icon={<span className="text-xs font-bold px-0.5 bg-yellow-200 dark:bg-yellow-800 rounded">H</span>}
        />

        <ToolbarSeparator />

        {/* Headings */}
        <ToolbarButton
          label={t("blog:editor_h1")}
          isActive={editor.isActive("heading", { level: 1 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 1 }).run()
          }
          icon={<Heading1 className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_h2")}
          isActive={editor.isActive("heading", { level: 2 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          icon={<Heading2 className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_h3")}
          isActive={editor.isActive("heading", { level: 3 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
          icon={<Heading3 className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_h4")}
          isActive={editor.isActive("heading", { level: 4 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 4 }).run()
          }
          icon={<Heading4 className="h-4 w-4" />}
        />

        <ToolbarSeparator />

        {/* Lists & blockquote */}
        <ToolbarButton
          label={t("blog:editor_bullet_list")}
          isActive={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          icon={<List className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_ordered_list")}
          isActive={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          icon={<ListOrdered className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_blockquote")}
          isActive={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          icon={<Quote className="h-4 w-4" />}
        />

        <ToolbarSeparator />

        {/* Code block with language selector */}
        <div className="relative">
          <ToolbarButton
            label={t("blog:editor_code_block")}
            isActive={editor.isActive("codeBlock")}
            onClick={() => {
              if (editor.isActive("codeBlock")) {
                editor.chain().focus().unsetCodeBlock().run();
              } else {
                editor.chain().focus().toggleCodeBlock({ language: codeLanguage }).run();
              }
            }}
            icon={<FileCode2 className="h-4 w-4" />}
          />
          {editor.isActive("codeBlock") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-1.5 text-[10px] font-mono"
              onClick={() => setCodeLangOpen(!codeLangOpen)}
            >
              {codeLanguage}
            </Button>
          )}
          {codeLangOpen && (
            <div className="absolute top-full left-0 z-50 mt-1 w-40 max-h-60 overflow-y-auto rounded-md border border-input bg-popover shadow-md">
              {commonLangs.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground font-mono ${
                    codeLanguage === lang ? "bg-accent font-bold" : ""
                  }`}
                  onClick={() => setCodeBlockLanguage(lang)}
                >
                  {lang}
                </button>
              ))}
            </div>
          )}
        </div>

        <ToolbarSeparator />

        {/* Horizontal rule */}
        <ToolbarButton
          label={t("blog:editor_horizontal_rule")}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          icon={<Minus className="h-4 w-4" />}
        />

        <ToolbarSeparator />

        {/* Text alignment */}
        <ToolbarButton
          label={t("blog:editor_text_left")}
          isActive={editor.isActive({ textAlign: "left" })}
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
          icon={<AlignLeft className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_text_center")}
          isActive={editor.isActive({ textAlign: "center" })}
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
          icon={<AlignCenter className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_text_right")}
          isActive={editor.isActive({ textAlign: "right" })}
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
          icon={<AlignRight className="h-4 w-4" />}
        />

        <ToolbarSeparator />

        {/* Link & Image */}
        <ToolbarButton
          label={t("blog:editor_link")}
          isActive={editor.isActive("link")}
          onClick={() => {
            const previous = editor.getAttributes("link").href as string | undefined;
            setLinkUrl(previous ?? "");
            setLinkPromptOpen(true);
          }}
          icon={<LinkIcon className="h-4 w-4" />}
        />
        <ToolbarButton
          label={t("blog:editor_image")}
          onClick={() => setImagePromptOpen(true)}
          icon={<ImageIcon className="h-4 w-4" />}
        />

        <ToolbarSeparator />

        {/* Undo / Redo */}
        <ToolbarButton
          label={t("blog:editor_undo")}
          onClick={() => editor.chain().focus().undo().run()}
          icon={<Undo2 className="h-4 w-4" />}
          disabled={!editor.can().undo()}
        />
        <ToolbarButton
          label={t("blog:editor_redo")}
          onClick={() => editor.chain().focus().redo().run()}
          icon={<Redo2 className="h-4 w-4" />}
          disabled={!editor.can().redo()}
        />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Preview toggle */}
        <Button
          type="button"
          variant={previewMode ? "default" : "ghost"}
          size="sm"
          className="h-8 gap-1.5 px-2"
          onClick={() => setPreviewMode(!previewMode)}
        >
          {previewMode ? (
            <>
              <Pencil className="h-3.5 w-3.5" />
              <span className="text-xs">{t("blog:editor_edit")}</span>
            </>
          ) : (
            <>
              <Eye className="h-3.5 w-3.5" />
              <span className="text-xs">{t("blog:editor_preview")}</span>
            </>
          )}
        </Button>
      </div>

      {/* Editor or Preview */}
      {previewMode ? (
        <div className="min-h-[280px] p-4">
          <article
            className="blog-prose"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      ) : (
        <EditorContent editor={editor} />
      )}

      {/* Link prompt */}
      {linkPromptOpen && (
        <div className="flex items-center gap-2 border-t border-input bg-muted/20 px-3 py-2">
          <Input
            type="url"
            placeholder="https://example.com"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                insertLink();
              } else if (e.key === "Escape") {
                setLinkPromptOpen(false);
              }
            }}
            className="h-8 text-sm"
          />
          <Button size="sm" type="button" onClick={insertLink}>
            {t("common:save")}
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => setLinkPromptOpen(false)}
          >
            {t("common:cancel")}
          </Button>
        </div>
      )}

      {imagePromptOpen && (
        <div className="flex items-center gap-2 border-t border-input bg-muted/20 px-3 py-2">
          <Input
            type="url"
            placeholder="https://example.com/image.jpg"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                insertImage();
              } else if (e.key === "Escape") {
                setImagePromptOpen(false);
              }
            }}
            className="h-8 text-sm"
          />
          <Button size="sm" type="button" onClick={insertImage}>
            {t("common:save")}
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => setImagePromptOpen(false)}
          >
            {t("common:cancel")}
          </Button>
        </div>
      )}
    </div>
  );
};

interface ToolbarButtonProps {
  label: string;
  isActive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  label,
  isActive,
  disabled,
  onClick,
  icon,
}) => {
  return (
    <Button
      type="button"
      variant={isActive ? "secondary" : "ghost"}
      size="sm"
      className="h-8 w-8 p-0"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={isActive ? true : undefined}
    >
      {icon}
    </Button>
  );
};

const ToolbarSeparator: React.FC = () => (
  <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
);

export default BlogBodyEditor;
