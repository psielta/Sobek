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

  constructor(private readonly workspaceRoot: string) {}

  register(context: vscode.ExtensionContext): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => this.add(uri)),
      watcher.onDidDelete((uri) => this.remove(uri))
    );
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
  }

  async search(query: string, limit: number): Promise<string[]> {
    await this.ensureLoaded();
    return rankPaths(query, [...this.files], limit);
  }

  /** Every indexed path, shallow-first then alphabetical (cached). */
  async all(): Promise<string[]> {
    await this.ensureLoaded();
    if (!this.sortedCache) {
      this.sortedCache = rankPaths("", [...this.files], this.files.size);
    }
    return this.sortedCache;
  }
}
