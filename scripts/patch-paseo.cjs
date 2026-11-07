const fs = require('node:fs');
const path = require('node:path');

// Keep the upstream sources reviewable. Each exact replacement fails closed when
// a new pinned upstream version changes the code we integrate with.
function replace(source, relativePath, before, after) {
  const file = path.join(source, relativePath);
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes(after)) return;
  if (!content.includes(before)) throw new Error(`Paseo patch no longer matches ${relativePath}`);
  fs.writeFileSync(file, content.replaceAll(before, after));
}

function patchPaseo(source) {
  const metadataFile = path.join(source, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  // Git hooks are a contributor convenience and cannot run in a verified tarball.
  delete metadata.scripts.prepare;
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);

  replace(source, 'packages/desktop/src/main.ts',
    'function getAppDistDir(): string {\n  if (app.isPackaged) {\n    return path.join(process.resourcesPath, "app-dist");\n  }\n\n  return path.resolve(__dirname, "../../app/dist");\n}',
    'function getAppDistDir(): string {\n  return path.resolve(__dirname, "..", "app-dist");\n}');
  replace(source, 'packages/desktop/src/main.ts',
    'if (!app.isPackaged) {\n    const { loadReactDevTools }',
    'if (!app.isPackaged && process.env.EXPO_DEV_URL) {\n    const { loadReactDevTools }');
  replace(source, 'packages/desktop/src/main.ts',
    'path.join(process.resourcesPath, "icon.png")',
    'path.resolve(__dirname, "..", "icon.png")');
  replace(source, 'packages/desktop/src/daemon/package-paths.ts',
    'return path.join(process.resourcesPath, "app.asar");',
    'return path.resolve(__dirname, "..", "..");');
  replace(source, 'packages/desktop/src/daemon/runtime-paths.ts',
    'return path.join(\n    process.resourcesPath,\n    "app.asar.unpacked",\n    "dist",\n    "daemon",\n    "node-entrypoint-runner.js",\n  );',
    'return path.join(__dirname, "node-entrypoint-runner.js");');
  replace(source, 'packages/desktop/src/daemon/daemon-manager.ts',
    'function resolveDesktopAppVersion(): string {',
    'function resolveBundledEngineVersion(): string {');
  replace(source, 'packages/desktop/src/daemon/daemon-manager.ts',
    '  if (app.isPackaged) {\n    return app.getVersion();\n  }\n\n  try {',
    '  // Cloude and its bundled Paseo engine have independent release versions.\n  try {');
  replace(source, 'packages/desktop/src/daemon/daemon-manager.ts',
    'const packageJsonPath = path.join(__dirname, "..", "..", "package.json");',
    'const packageJsonPath = path.join(__dirname, "..", "..", "engine-package.json");');
  replace(source, 'packages/desktop/src/daemon/daemon-manager.ts',
    'normalizeVersion(resolveDesktopAppVersion())',
    'normalizeVersion(resolveBundledEngineVersion())');
  replace(source, 'packages/desktop/src/daemon/daemon-manager.ts',
    'function resolveBundledEngineVersion(): string {',
    'function resolveDesktopAppVersion(): string {\n  return app.getVersion();\n}\n\nfunction resolveBundledEngineVersion(): string {');
  replace(source, 'packages/desktop/src/features/editor-targets/runtime.ts',
    'return path.join(process.resourcesPath, "editor-target-icons", fileName);',
    'return path.resolve(__dirname, "..", "..", "..", "editor-target-icons", fileName);');
  replace(source, 'packages/desktop/src/features/editor-targets/runtime.ts',
    'return path.resolve(__dirname, "../../../assets/editor-targets", fileName);',
    'return path.resolve(__dirname, "..", "..", "..", "editor-target-icons", fileName);');
  replace(source, 'packages/desktop/src/integrations/cli-install/path.ts',
    '"resources", "bin", filename',
    '"resources", "paseo", "bin", filename');
  replace(source, 'packages/server/src/server/config.ts',
    'path.join(input.resourcesPath, "app-dist")',
    'path.join(input.resourcesPath, "paseo", "app-dist")');
  replace(source, 'packages/desktop/src/features/auto-updater.ts',
    'autoUpdater.autoDownload = true;',
    'autoUpdater.autoDownload = false;');
  replace(source, 'packages/desktop/src/features/auto-updater.ts',
    'return !(input.platform === "linux" && input.isAppImage);',
    'void input;\n  // Cloude installs only after the explicit update action.\n  return false;');
  replace(source, 'packages/app/src/desktop/updates/desktop-updates.ts',
    'https://github.com/getpaseo/paseo/releases/download',
    'https://github.com/mumuyanxiu/cloude/releases/download');
  replace(source, 'packages/app/src/desktop/updates/desktop-updates.ts',
    'export function isVersionMismatch(',
    `export const BUNDLED_ENGINE_VERSION = ${JSON.stringify(require('../paseo-lock.json').version)};\n\nexport function isVersionMismatch(`);
  replace(source, 'packages/app/src/desktop/updates/desktop-updates.ts',
    '  return app !== daemon;',
    '  return normalizeVersionForComparison(BUNDLED_ENGINE_VERSION) !== daemon;');
  replace(source, 'packages/app/src/utils/app-version.ts',
    'export function resolveAppVersion(): string | null {',
    `export const CLOUDE_APP_VERSION = ${JSON.stringify(require('../package.json').version)};\n\nexport function resolveAppVersion(): string | null {\n  return CLOUDE_APP_VERSION;\n}\n\nexport function resolvePaseoEngineVersion(): string | null {`);
  for (const file of ['packages/app/src/runtime/host-runtime.ts', 'packages/app/src/plugins/registry.ts']) {
    replace(source, file, 'resolveAppVersion', 'resolvePaseoEngineVersion');
  }
  replace(source, 'packages/app/src/utils/test-daemon-connection.ts',
    'import { resolveAppVersion } from "./app-version";',
    'import { resolvePaseoEngineVersion } from "./app-version";');
  replace(source, 'packages/app/src/utils/test-daemon-connection.ts',
    '\n  resolveAppVersion,\n',
    '\n  resolveAppVersion: resolvePaseoEngineVersion,\n');
  replace(source, 'packages/app/src/screens/settings-screen.tsx',
    'import { resolveAppVersion } from "@/utils/app-version";',
    'import { resolveAppVersion, resolvePaseoEngineVersion } from "@/utils/app-version";');
  replace(source, 'packages/app/src/screens/settings-screen.tsx',
    '<ConnectedHostsSection clientVersion={appVersion} />',
    '<ConnectedHostsSection clientVersion={resolvePaseoEngineVersion()} />');
  replace(source, 'packages/app/src/screens/settings-screen.tsx',
    '\n  appVersion: string | null;\n  appVersionText:',
    '\n  appVersionText:');
  replace(source, 'packages/app/src/screens/settings-screen.tsx',
    'function AboutSection({ appVersion, appVersionText, isDesktopApp }:',
    'function AboutSection({ appVersionText, isDesktopApp }:');
  replace(source, 'packages/app/src/screens/settings-screen.tsx',
    '<AboutSection\n              appVersion={appVersion}\n',
    '<AboutSection\n');
  replace(source, 'packages/app/src/desktop/updates/rosetta-callout-source.tsx',
    'https://paseo.sh/download',
    'https://github.com/mumuyanxiu/cloude/releases/latest');
  replace(source, 'packages/app/app.config.js', 'name: "Paseo",', 'name: "Cloude",');
  replace(source, 'packages/app/app.config.js', 'name: "Paseo Debug",', 'name: "Cloude Debug",');
  for (const name of fs.readdirSync(path.join(source, 'packages/app/src/i18n/resources'))) {
    if (/^(ar|en|es|fr|ja|ko|pt-BR|ru|zh-CN)\.ts$/.test(name)) {
      replace(source, `packages/app/src/i18n/resources/${name}`, 'title: "Paseo",', 'title: "Cloude",');
    }
  }
  replace(source, 'packages/app/src/screens/workspace/workspace-screen.tsx',
    'document.title = "Workspace";', 'document.title = "Cloude";');
  replace(source, 'packages/app/src/screens/workspace/workspace-screen.tsx',
    '    document.title =\n      titleState === "loading"\n        ? t("workspace.tabs.loading")\n        : resolvedLabel || t("workspace.tabs.fallback.workspace");',
    '    document.title = `${titleState === "loading" ? t("workspace.tabs.loading") : resolvedLabel || t("workspace.tabs.fallback.workspace")} · Cloude`;');
  require('./patch-paseo-editor-close.cjs').patchPaseoEditorClose(source, replace);
  require('./patch-paseo-quit.cjs').patchPaseoQuit(source, replace);
}

module.exports = { patchPaseo };
