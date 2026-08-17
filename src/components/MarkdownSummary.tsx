"use client";

import type { ReactNode } from "react";

interface MarkdownSummaryProps {
  text: string;
}

type Block =
  | { type: "heading"; text: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; text: string };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
      paragraphLines = [];
    }
  };
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: "list", items: listItems });
      listItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", text: headingMatch[1].trim() });
      continue;
    }
    const listMatch = /^[-*]\s+(.*)$/.exec(line) ?? /^\d+\.\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1].trim());
      continue;
    }
    flushList();
    paragraphLines.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

// The summary prompt (lib/openrouter/client.ts) only ever asks the model for
// **bold** emphasis — no italics/links/code — so that's the only inline
// syntax this needs to strip and re-render rather than show literally.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

/**
 * Renders the Markdown produced by the summary/ask prompts (## headings, -
 * lists, **bold**, plain paragraphs) as real elements matching the app's own
 * type scale — instead of dumping the raw Markdown source into a <pre>
 * block, which showed literal "##"/"-"/"**" characters and let the model's
 * own (inconsistent) blank-line spacing drive the layout.
 */
export function MarkdownSummary({ text }: MarkdownSummaryProps) {
  const blocks = parseBlocks(text);
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, i) => {
        if (block.type === "heading") {
          return (
            <h3
              key={i}
              className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted first:mt-0 mt-1"
            >
              {block.text}
            </h3>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={i} className="flex list-disc flex-col gap-1 pl-4 text-sm leading-relaxed text-foreground/90">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, `${i}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="text-sm leading-relaxed text-foreground/90">
            {renderInline(block.text, `${i}`)}
          </p>
        );
      })}
    </div>
  );
}
