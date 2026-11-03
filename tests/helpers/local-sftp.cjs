'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

class LocalSftp {
  constructor(root) { this.root = root; this.links = new Map(); this.failReads = false; }
  canonical(remote) {
    let value = path.posix.resolve('/home/tester', remote);
    for (let attempt = 0; attempt < 10; attempt++) {
      const match = [...this.links.keys()].find(link => value === link || value.startsWith(link + '/'));
      if (!match) return value;
      value = this.links.get(match) + value.slice(match.length);
    }
    throw new Error('Symlink loop');
  }
  native(remote) { return path.join(this.root, ...this.canonical(remote).split('/').filter(Boolean)); }
  callback(operation, callback) { Promise.resolve().then(operation).then(value => callback(null, value), error => { if (error.code === 'ENOENT') error.code = 2; callback(error); }); }
  attrs(stats) { return { mode: stats.mode, uid: 1000, gid: 1000, size: stats.size, atime: Math.floor(stats.atimeMs / 1000), mtime: Math.floor(stats.mtimeMs / 1000), isFile: () => stats.isFile(), isDirectory: () => stats.isDirectory(), isSymbolicLink: () => false }; }
  realpath(remote, callback) { this.callback(async () => { await fsp.stat(this.native(remote)); return this.canonical(remote); }, callback); }
  stat(remote, callback) { this.callback(async () => this.attrs(await fsp.stat(this.native(remote))), callback); }
  lstat(remote, callback) {
    if (this.links.has(remote)) return queueMicrotask(() => callback(null, { mode: 0o120777, isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }));
    this.stat(remote, callback);
  }
  mkdir(remote, attrs, callback) { this.callback(() => fsp.mkdir(this.native(remote), { mode: attrs.mode }), callback); }
  readdir(remote, callback) { this.callback(async () => Promise.all((await fsp.readdir(this.native(remote))).map(async filename => ({ filename, attrs: this.attrs(await fsp.stat(path.join(this.native(remote), filename))) }))), callback); }
  writeFile(remote, data, options, callback) { this.callback(() => fsp.writeFile(this.native(remote), data, options), callback); }
  unlink(remote, callback) { this.callback(() => fsp.unlink(this.native(remote)), callback); }
  ext_openssh_rename(from, to, callback) { this.callback(() => fsp.rename(this.native(from), this.native(to)), callback); }
  rename(from, to, callback) {
    this.callback(async () => {
      try { await fsp.lstat(this.native(to)); throw new Error('Destination exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fsp.rename(this.native(from), this.native(to));
    }, callback);
  }
  createReadStream(remote) {
    if (this.failReads) return Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('simulated transport failure'); })());
    return fs.createReadStream(this.native(remote), { highWaterMark: 16384 });
  }
  createWriteStream(remote, options) { return fs.createWriteStream(this.native(remote), options); }
}

module.exports = { LocalSftp };
