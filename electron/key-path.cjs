'use strict';

// Also checked in the renderer before connecting or saving. Detect before any
// path operations: filesystem errors include their input verbatim.
function containsKeyMaterial(value) {
  return typeof value === 'string' && /\b(?:BEGIN|END)\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY\b|PuTTY-User-Key-File-\d+:|b3BlbnNzaC1rZXktdjE/i.test(value);
}

function assertPrivateKeyPath(value) {
  if (containsKeyMaterial(value)) throw new Error('这里需要私钥文件路径，不能粘贴私钥正文。请点击“选择”，选中本机私钥文件（不要选 .pub 公钥）。');
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error('请选择有效的本机私钥文件。');
  }
  return value;
}

module.exports = { containsKeyMaterial, assertPrivateKeyPath };
