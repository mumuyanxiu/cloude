'use strict';

function patchPaseoEditorClose(source, replace) {
  const file = 'packages/app/src/file-panels/source/editor/model.ts';
  replace(source, file,
    'const AUTOSAVE_DELAY_MS = 800;',
    `const AUTOSAVE_DELAY_MS = 800;

// Cloude keeps unsaved source buffers protected during window and mode changes.
const closeProtectedSourceEditors = new Set<FileEditorModel>();

export function hasUnsavedSourceEdits(): boolean {
  return [...closeProtectedSourceEditors].some((editor) => {
    const snapshot = editor.getSnapshot();
    return snapshot.modified || snapshot.status === "saving";
  });
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedSourceEdits()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}`);
  replace(source, file,
    '    if (this.disposed || this.unwatch) return;\n    this.unwatch = this.file.watch',
    '    if (this.disposed || this.unwatch) return;\n    closeProtectedSourceEditors.add(this);\n    this.unwatch = this.file.watch');
  replace(source, file,
    '      void this.file.writeText(this.snapshot.content).catch(() => undefined);\n    }\n    this.disposed = true;',
    '      void this.file.writeText(this.snapshot.content).catch(() => undefined)\n        .finally(() => closeProtectedSourceEditors.delete(this));\n    } else {\n      closeProtectedSourceEditors.delete(this);\n    }\n    this.disposed = true;');
}

module.exports = { patchPaseoEditorClose };
