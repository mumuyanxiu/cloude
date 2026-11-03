'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function localVersion(stats) {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, dev: stats.dev, ino: stats.ino };
}

function sameLocalVersion(left, right) {
  // Windows path-based stat can return dev=0 while handle-based stat returns
  // the volume ID. Compare the volume only when both queries supply one.
  return ['size', 'mtimeMs', 'ctimeMs', 'ino'].every(key => left[key] === right[key])
    && (!left.dev || !right.dev || left.dev === right.dev);
}

function sameRemoteVersion(left, right) {
  if (!left || !right) return left === right;
  return ['type', 'size', 'mtime', 'mode'].every(key => left[key] === right[key]);
}

async function inspectLocalPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 32768) throw new Error('上传路径无效。');
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let cursor = root;
  let stats = await fs.lstat(root);
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    stats = await fs.lstat(cursor);
    if (stats.isSymbolicLink()) throw new Error(`不支持上传符号链接或目录联接，请选择实际文件或文件夹：${cursor}`);
    if (index < segments.length - 1 && !stats.isDirectory()) throw new Error(`本地父路径不是文件夹：${cursor}`);
  }
  if (!stats.isDirectory() && !stats.isFile()) throw new Error(`不支持上传此类特殊文件：${absolute}`);
  return stats;
}

async function scanLocalSources(localPaths, kind, onProgress = () => {}) {
  if (!['files', 'folder'].includes(kind)) throw new Error('上传类型无效。');
  if (!Array.isArray(localPaths) || !localPaths.length) throw new Error('没有选择要上传的内容。');
  const roots = [];
  const entries = [];
  const names = new Set();
  let filesTotal = 0;
  let bytesTotal = 0;

  const visit = async (localPath, relative, depth) => {
    if (depth > 128 || entries.length >= 100000) throw new Error('所选目录层级过深或项目超过 100000 项，请分批上传。');
    const stats = await inspectLocalPath(localPath);
    const type = stats.isDirectory() ? 'directory' : 'file';
    entries.push({ localPath, relative, type, version: localVersion(stats) });
    if (type === 'file') { filesTotal++; bytesTotal += stats.size; }
    onProgress({ phase: 'scanning', name: relative, entriesProcessed: entries.length, filesTotal, bytesTotal });
    if (type === 'directory') {
      const children = (await fs.readdir(localPath)).sort();
      for (const name of children) {
        if (name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error(`文件名称无法用于远端路径：${name}`);
        await visit(path.join(localPath, name), path.posix.join(relative, name), depth + 1);
      }
    }
  };

  for (const selected of localPaths) {
    const localPath = path.resolve(selected);
    const name = path.basename(localPath);
    if (!name || /[\\/\0]/.test(name)) throw new Error('请选择一个具体文件夹，不能上传磁盘根目录。');
    if (names.has(name)) throw new Error(`所选内容包含多个同名项目，请分别上传：${name}`);
    names.add(name);
    const stats = await inspectLocalPath(localPath);
    if (kind === 'folder' && !stats.isDirectory()) throw new Error('请选择一个文件夹上传。');
    if (kind === 'files' && !stats.isFile()) throw new Error('请选择普通文件，文件夹请使用“上传文件夹”。');
    roots.push({ localPath, name });
    await visit(localPath, name, 0);
  }
  return { roots, entries };
}

async function createUploadPlan(remote, { directory, localPaths, kind = 'files' }, assertCurrent = () => {}, onProgress = () => {}) {
  const generation = remote.generation;
  const checkConnection = () => {
    assertCurrent();
    if (generation !== remote.generation) throw new Error('连接已变化，请重新选择上传目录。');
  };
  const sources = await scanLocalSources(localPaths, kind, onProgress);
  const fileEntries = sources.entries.filter(entry => entry.type === 'file');
  const totals = { filesTotal: fileEntries.length, bytesTotal: fileEntries.reduce((sum, entry) => sum + entry.version.size, 0), entriesTotal: sources.entries.length };
  onProgress({ phase: 'checking', ...totals, entriesProcessed: 0 });
  checkConnection();
  const destination = await remote.resolvePath(directory);
  const destinationInfo = await remote.inspectUploadPath(destination);
  if (destinationInfo?.type !== 'directory') throw new Error('请选择一个有效的远端目标文件夹。');
  const entries = [];
  const conflicts = [];
  for (const entry of sources.entries) {
    checkConnection();
    const remotePath = path.posix.join(destination, entry.relative);
    const existing = await remote.inspectUploadPath(remotePath);
    if (existing && existing.type !== entry.type) throw new Error(`远端已有不同类型的同名项目，无法上传：${remotePath}`);
    if (entry.type === 'file' && existing) conflicts.push(remotePath);
    entries.push({ ...entry, remotePath, existing });
    onProgress({ phase: 'checking', ...totals, name: entry.relative, entriesProcessed: entries.length });
  }
  checkConnection();
  return { kind, generation, directory: destination, roots: sources.roots, entries, conflicts };
}

async function assertLocalPlan(plan) {
  const current = await scanLocalSources(plan.roots.map(root => root.localPath), plan.kind);
  if (current.entries.length !== plan.entries.length) throw new Error('本地文件夹内容已变化，请重新选择并上传。');
  for (let index = 0; index < current.entries.length; index++) {
    const before = plan.entries[index];
    const after = current.entries[index];
    if (before.relative !== after.relative || before.type !== after.type || !sameLocalVersion(before.version, after.version)) {
      throw new Error(`本地上传内容已变化，请重新上传：${before.localPath}`);
    }
  }
}

async function executeUploadPlan(remote, plan, assertCurrent = () => {}, onProgress = () => {}) {
  const checkConnection = () => {
    assertCurrent();
    if (plan.generation !== remote.generation) throw new Error('连接已变化，请重新选择上传目录。');
  };
  // Recheck everything after the confirmation dialog, before the first write.
  const fileEntries = plan.entries.filter(entry => entry.type === 'file');
  const totals = { filesTotal: fileEntries.length, bytesTotal: fileEntries.reduce((sum, entry) => sum + entry.version.size, 0), entriesTotal: plan.entries.length };
  const files = [];
  let bytesCompleted = 0;
  const report = data => onProgress({ ...totals, filesCompleted: files.length, bytesTransferred: bytesCompleted, ...data });
  report({ phase: 'preparing', entriesProcessed: 0 });
  checkConnection();
  await assertLocalPlan(plan);
  let checked = 0;
  for (const entry of plan.entries) {
    checkConnection();
    const current = await remote.inspectUploadPath(entry.remotePath);
    if (entry.type === 'file' ? !sameRemoteVersion(entry.existing, current) : entry.existing?.type !== current?.type) {
      throw new Error(`远端上传目标已变化，请重新上传并确认覆盖：${entry.remotePath}`);
    }
    report({ phase: 'preparing', name: entry.relative, entriesProcessed: ++checked });
  }
  let directories = 0;
  try {
    for (const entry of plan.entries) {
      checkConnection();
      const current = await inspectLocalPath(entry.localPath);
      if (!sameLocalVersion(localVersion(current), entry.version)) throw new Error(`本地上传内容已变化：${entry.localPath}`);
      checkConnection();
      if (entry.type === 'directory') {
        report({ phase: 'preparing', name: entry.relative });
        await remote.mkdirUploadDirectory(entry.remotePath);
        directories++;
      } else {
        report({ phase: 'uploading', name: entry.relative, fileTransferred: 0, fileTotal: entry.version.size });
        files.push(await remote.upload(entry.localPath, path.posix.dirname(entry.remotePath), {
          overwrite: !!entry.existing, expectedLocal: entry.version, expectedRemote: entry.existing,
          onProgress: progress => report({ phase: progress.phase || 'uploading', name: entry.relative,
            bytesTransferred: bytesCompleted + progress.transferred, fileTransferred: progress.transferred, fileTotal: entry.version.size }),
        }));
        bytesCompleted += entry.version.size;
        report({ phase: 'uploading', name: entry.relative, fileTransferred: entry.version.size, fileTotal: entry.version.size });
      }
    }
    report({ phase: 'verifying' });
    await assertLocalPlan(plan);
    checkConnection();
  } catch (error) {
    throw new Error(`上传已中断，已完成 ${files.length} 个文件，已处理 ${directories} 个目录。已完成的内容会保留，请检查后重新上传。${error.message}`);
  }
  report({ phase: 'complete' });
  return { files, folders: plan.kind === 'folder' ? plan.roots.map(root => path.posix.join(plan.directory, root.name)) : [] };
}

module.exports = { createUploadPlan, executeUploadPlan, inspectLocalPath, localVersion, sameLocalVersion, sameRemoteVersion };
