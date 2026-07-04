import * as fs from "node:fs";
import { parseMentions, resolveMentionPath } from "../core/mentions";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * markdown-it plugin for VS Code's built-in Markdown preview: wraps `@file`
 * mentions in a styled span (link color; warning color when the file does
 * not resolve), matching the editor decorations. Injected via the
 * `markdown.markdownItPlugins` contribution point.
 */
export function extendMarkdownItWithMentions(
  md: any,
  getWorkspaceRoot: () => string | undefined
): any {
  md.core.ruler.push("sobek_mentions", (state: any) => {
    const root = getWorkspaceRoot();
    if (!root) {
      return;
    }
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) {
        continue;
      }
      const rebuilt: any[] = [];
      let changed = false;
      for (const child of blockToken.children) {
        if (child.type !== "text" || !child.content.includes("@")) {
          rebuilt.push(child);
          continue;
        }
        const text: string = child.content;
        const mentions = parseMentions(text);
        if (mentions.length === 0) {
          rebuilt.push(child);
          continue;
        }
        changed = true;
        let cursor = 0;
        for (const mention of mentions) {
          if (mention.start > cursor) {
            const plain = new state.Token("text", "", 0);
            plain.content = text.slice(cursor, mention.start);
            rebuilt.push(plain);
          }
          const resolved = resolveMentionPath(root, mention.raw);
          const exists = resolved ? fs.existsSync(resolved) : false;
          const span = new state.Token("html_inline", "", 0);
          span.content = `<span class="sobek-mention${exists ? "" : " sobek-mention-broken"}">@${md.utils.escapeHtml(mention.raw)}</span>`;
          rebuilt.push(span);
          cursor = mention.end;
        }
        if (cursor < text.length) {
          const plain = new state.Token("text", "", 0);
          plain.content = text.slice(cursor);
          rebuilt.push(plain);
        }
      }
      if (changed) {
        blockToken.children = rebuilt;
      }
    }
  });
  return md;
}
