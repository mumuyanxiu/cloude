'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const SCHEME = 'windows-dpapi-current-user-v1';
const MAX_PLAINTEXT_BYTES = 128 * 1024;
const MAX_CIPHERTEXT_BYTES = 256 * 1024;

// Only this fixed program goes in argv. The credential travels through stdin
// and stdout pipes, never a command argument, a temporary file, or a log.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.operation -eq 'encrypt') {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$request.value)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    $value = [Convert]::ToBase64String($protected)
  } elseif ($request.operation -eq 'decrypt') {
    $bytes = [Convert]::FromBase64String([string]$request.value)
    $unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    $value = [System.Text.Encoding]::UTF8.GetString($unprotected)
  } else { throw 'Unsupported operation' }
  [Console]::Out.Write((@{ value = $value } | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.WriteLine('DPAPI operation failed.')
  exit 1
}
`;
const encodedScript = Buffer.from(script, 'utf16le').toString('base64');

class WindowsDpapiProvider {
  constructor({ spawnProcess = spawn, platform = process.platform, timeout = 10000 } = {}) {
    this.scheme = SCHEME;
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.timeout = timeout;
  }

  run(operation, value) {
    if (this.platform !== 'win32') return Promise.reject(new Error('此登录凭据功能需要 Windows 安全存储。'));
    const payload = JSON.stringify({ operation, value });
    if (Buffer.byteLength(payload, 'utf8') > 512 * 1024) return Promise.reject(new Error('登录凭据数据过大，未处理。'));
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-EncodedCommand', encodedScript], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { reject(new Error('无法启动 Windows 安全存储，请稍后重试。')); return; }
      let settled = false;
      let size = 0;
      const chunks = [];
      const fail = message => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        child.kill(); reject(new Error(message));
      };
      const timer = setTimeout(() => fail('Windows 安全存储响应超时，请稍后重试。'), this.timeout);
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024) { fail('Windows 安全存储返回的数据过大，已取消。'); return; }
        chunks.push(chunk);
      });
      // Consume diagnostic output without copying it into user-facing errors.
      child.stderr.on('data', chunk => { size += chunk.length; if (size > 512 * 1024) fail('Windows 安全存储返回的数据过大，已取消。'); });
      child.once('error', () => fail('无法启动 Windows 安全存储，请稍后重试。'));
      child.stdin.once('error', () => fail('Windows 安全存储连接中断，请稍后重试。'));
      child.once('close', code => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (code !== 0) { reject(new Error('Windows 无法处理此登录凭据，请重新输入一次。')); return; }
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
          if (!response || typeof response.value !== 'string') throw new Error();
          resolve(response.value);
        } catch { reject(new Error('Windows 安全存储返回了无效结果。')); }
      });
      child.stdin.end(payload, 'utf8');
    });
  }

  async encrypt(plaintext) {
    if (typeof plaintext !== 'string' || !plaintext || Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error('登录凭据无效或过大，未保存。');
    const value = await this.run('encrypt', plaintext);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Windows 未返回有效密文。');
    const encrypted = Buffer.from(value, 'base64');
    if (!encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw new Error('Windows 未返回有效密文。');
    return encrypted;
  }

  async decrypt(encrypted) {
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw new Error('已保存的登录凭据格式无效。');
    const value = await this.run('decrypt', encrypted.toString('base64'));
    if (Buffer.byteLength(value, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error('已保存的登录凭据过大。');
    return value;
  }
}

module.exports = { WindowsDpapiProvider, SCHEME };
