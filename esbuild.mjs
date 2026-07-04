import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** Extension host bundle (Node.js). */
const extensionCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
});

/** Webview bundles (browser). */
const webviewCtx = await esbuild.context({
  entryPoints: {
    board: "src/webview/board/main.tsx",
    assistant: "src/webview/assistant/main.tsx",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outdir: "dist/webview",
  sourcemap: !production,
  minify: production,
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log("[sobek] watching...");
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log("[sobek] build complete");
}
