import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  buildWorkspaceContextBlock,
  MAX_CONTEXT_FILE_BYTES,
  MAX_TOTAL_CONTEXT_CHARS,
  WORKSPACE_CONTEXT_FILES,
  type WorkspaceContextFile,
} from "./instructions";

/**
 * Reads the known Markdown files from the workspace root, applying the same
 * limits as Thoth's WorkspaceFileService: 64 KB per file, 48k chars total,
 * empty/oversized/unreadable files skipped without failing the AI call.
 */
export async function readWorkspaceContext(workspaceRoot: string): Promise<string | undefined> {
  const files: WorkspaceContextFile[] = [];
  let totalChars = 0;

  for (const name of WORKSPACE_CONTEXT_FILES) {
    const filePath = path.join(workspaceRoot, name);
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_CONTEXT_FILE_BYTES) {
        continue;
      }
      const content = (await fs.readFile(filePath, "utf8")).trim();
      if (content.length === 0) {
        continue;
      }
      if (totalChars + content.length > MAX_TOTAL_CONTEXT_CHARS) {
        continue;
      }
      totalChars += content.length;
      files.push({ name, content });
    } catch {
      // Missing or unreadable files never fail the AI call.
    }
  }

  return buildWorkspaceContextBlock(files);
}
