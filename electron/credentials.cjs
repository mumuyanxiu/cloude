const crypto = require('node:crypto');
const path = require('node:path');
const { WindowsDpapiProvider } = require('./dpapi.cjs');

function credentialId(config, platform = process.platform) {
  const keyPath = config.authType === 'key' && config.privateKeyPath
    ? (platform === 'win32' ? path.win32.resolve(config.privateKeyPath).toLowerCase() : path.resolve(config.privateKeyPath))
    : '';
  return crypto.createHash('sha256').update(JSON.stringify([
    String(config.host || '').trim().toLowerCase(), Number(config.port || 22),
    String(config.username || ''), config.authType, keyPath,
  ])).digest('hex');
}

const secretField = config => config.authType === 'password' ? 'password' : config.authType === 'key' ? 'passphrase' : null;

class CredentialStore {
  constructor(store, platform = process.platform, provider = new WindowsDpapiProvider({ platform })) {
    this.store = store;
    this.platform = platform;
    this.provider = provider;
    this.queue = Promise.resolve();
  }

  serialized(action) {
    const pending = this.queue.then(action, action);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async read() {
    const data = await this.store.read('credentials.json', { version: 1, entries: {} });
    if (data?.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
      throw new Error('已保存的登录凭据格式无效，请重新输入密码连接。');
    }
    return data;
  }

  has(config) {
    return this.serialized(async () => {
      if (!secretField(config)) return false;
      try {
        const data = await this.read();
        return !!await this.readSecret(config, data, credentialId(config, this.platform));
      } catch { return false; }
    });
  }

  async readSecret(config, data, identity) {
    const record = data.entries[identity];
    if (!record) return null;
    let plaintext;
    try {
      if (typeof record.encrypted !== 'string' || record.encrypted.length > 512 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.encrypted)) throw new Error();
      const encrypted = Buffer.from(record.encrypted, 'base64');
      if (record.scheme === this.provider.scheme) {
        plaintext = await this.provider.decrypt(encrypted);
      } else throw new Error();
    } catch {
      throw new Error('无法解密已保存的登录凭据，请重新输入一次密码或密钥口令连接。');
    }
    let decoded;
    try { decoded = JSON.parse(plaintext); } catch { throw new Error('已保存的登录凭据格式无效，请重新输入一次。'); }
    const field = secretField(config);
    if (!decoded || decoded.identity !== identity || decoded.field !== field || typeof decoded.value !== 'string' || !decoded.value || decoded.value.length > 16384) {
      throw new Error('已保存的登录凭据与当前设备不匹配，请重新输入。');
    }
    return decoded.value;
  }

  hydrate(config) {
    return this.serialized(async () => {
      const result = { ...config };
      const field = secretField(config);
      if (!field || (typeof config[field] === 'string' && config[field].length)) return result;
      const identity = credentialId(config, this.platform);
      const data = await this.read();
      const secret = await this.readSecret(config, data, identity);
      if (!secret) {
        if (field === 'password') throw new Error(config.autoConnect === false ? '请输入登录密码。' : '请先输入一次登录密码，连接成功后将加密保存，用于下次自动连接。');
        return result;
      }
      result[field] = secret;
      return result;
    });
  }

  remember(config) {
    return this.serialized(async () => {
      const identity = credentialId(config, this.platform);
      const field = secretField(config);
      const value = field && config[field];
      const data = await this.read();
      if (config.autoConnect === false || !field || !value) {
        if (data.entries[identity]) { delete data.entries[identity]; await this.store.write('credentials.json', data); }
        return false;
      }
      if (typeof value !== 'string' || value.length > 16384 || value.includes('\0')) throw new Error('登录凭据无效，未保存。');
      if (this.platform !== 'win32') throw new Error('此登录凭据功能需要 Windows 安全存储。');
      const encrypted = await this.provider.encrypt(JSON.stringify({ identity, field, value }));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('Windows 未返回有效的加密结果，本次登录凭据未保存。');
      data.entries[identity] = { scheme: this.provider.scheme, encrypted: encrypted.toString('base64') };
      await this.store.write('credentials.json', data);
      return true;
    });
  }

  forget(config) {
    return this.serialized(async () => {
      const data = await this.read();
      const identity = credentialId(config, this.platform);
      if (!data.entries[identity]) return;
      delete data.entries[identity];
      await this.store.write('credentials.json', data);
    });
  }
}

async function connectWithCredentials(remote, credentials, config) {
  const hydrated = await credentials.hydrate(config);
  // Authentication must succeed before a new or changed credential is retained.
  const result = await remote.connect(hydrated);
  try {
    return { ...result, credentialSaved: await credentials.remember(hydrated) };
  } catch (error) {
    return { ...result, credentialSaved: false, warning: `已连接，但无法记住登录凭据：${error.message}` };
  }
}

module.exports = { CredentialStore, credentialId, connectWithCredentials };
