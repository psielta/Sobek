import * as vscode from "vscode";
import * as path from "node:path";
import { rankPaths } from "./fuzzy";

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".sobek",
  "bin",
  "obj",
  "dist",
  "build",
  ".next",
  ".venv",
  "target",
  "coverage",
  "out",
]);

const FIND_EXCLUDE = `{${[...IGNORED_DIRECTORIES].map((dir) => `**/${dir}/**`).join(",")}}`;

/**
 * In-memory index of workspace file paths, kept fresh by a filesystem
 * watcher — the same approach VS Code's own pickers use, so searches never
 * hit the disk per keystroke and results are stable while typing/deleting.
 */
export class WorkspaceFileIndex {
  private files = new Set<string>();
  private loading: Promise<void> | undefined;
  private sortedCache: string[] | undefined;
  private arrayCache: string[] | undefined;

  constructor(private readonly workspaceRoot: string) {}

  register(context: vscode.ExtensionContext): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => void this.addCreated(uri)),
      watcher.onDidDelete((uri) => this.remove(uri))
    );
  }

  /**
   * Create events also fire for directories; only real files enter `files`
   * (directories are derived from file paths when the search cache rebuilds).
   */
  private async addCreated(uri: vscode.Uri): Promise<void> {
    try {
      const stats = await vscode.workspace.fs.stat(uri);
      if (stats.type === vscode.FileType.File) {
        this.add(uri);
      }
    } catch {
      // Gone before we could stat it — the delete event will follow.
    }
  }

  private toRelative(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const relative = path.relative(this.workspaceRoot, uri.fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    const normalized = relative.replace(/\\/g, "/");
    const ignored = normalized
      .split("/")
      .some((segment) => IGNORED_DIRECTORIES.has(segment));
    return ignored ? undefined : normalized;
  }

  private add(uri: vscode.Uri): void {
    const relative = this.toRelative(uri);
    if (relative) {
      this.files.add(relative);
      this.sortedCache = undefined;
      this.arrayCache = undefined;
    }
  }

  private remove(uri: vscode.Uri): void {
    const relative = this.toRelative(uri);
    if (!relative) {
      return;
    }
    // A deleted directory arrives as a single event: drop its subtree too.
    this.files.delete(relative);
    const prefix = `${relative}/`;
    for (const file of [...this.files]) {
      if (file.startsWith(prefix)) {
        this.files.delete(file);
      }
    }
    this.sortedCache = undefined;
    this.arrayCache = undefined;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loading) {
      this.loading = Promise.resolve(
        vscode.workspace.findFiles("**/*", FIND_EXCLUDE, 50_000)
      ).then((uris) => {
        for (const uri of uris) {
          this.add(uri);
        }
      });
    }
    return this.loading;
  }

  /** Forces a rescan on the next search (wired to "Recarregar prompts"). */
  refresh(): void {
    this.files.clear();
    this.loading = undefined;
    this.sortedCache = undefined;
    this.arrayCache = undefined;
  }

  /** Parent chains of every file, as trailing-slash paths ("a/", "a/b/"). */
  private deriveDirectories(): Set<string> {
    const directories = new Set<string>();
    for (const file of this.files) {
      let slash = file.lastIndexOf("/");
      while (slash > 0) {
        const dir = `${file.slice(0, slash)}/`;
        if (directories.has(dir)) {
          break;
        }
        directories.add(dir);
        slash = file.lastIndexOf("/", slash - 1);
      }
    }
    return directories;
  }

  async search(query: string, limit: number): Promise<string[]> {
    await this.ensureLoaded();
    if (!this.arrayCache) {
      this.arrayCache = [...this.files, ...this.deriveDirectories()];
    }
    // After drill-down the query is the directory itself ("src/") — ranking
    // it first is noise, so fetch one extra and drop the exact match.
    const normalizedQuery = query.trim().replace(/\\/g, "/").toLowerCase();
    return rankPaths(query, this.arrayCache, limit + 1)
      .filter((entry) => !(entry.endsWith("/") && entry.toLowerCase() === normalizedQuery))
      .slice(0, limit);
  }

  /** Every indexed FILE path, shallow-first then alphabetical (cached). */
  async all(): Promise<string[]> {
    await this.ensureLoaded();
    if (!this.sortedCache) {
      this.sortedCache = rankPaths("", [...this.files], this.files.size);
    }
    return this.sortedCache;
  }
}
