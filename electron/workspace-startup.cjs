'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StateStore } = require('./state.cjs');

const APP_ID = 'io.github.cloudclaude.desktop';
const MODES = ['paseo', 'legacy'];

function configureProfile(app, env = process.env) {
  const dataDirectory = env.CLOUDE_DATA || env.CLOUD_CLAUDE_DATA || (app.isPackaged
    ? path.join(app.getPath('appData'), 'Cloud Claude')
    : path.join(__dirname, '..', '.runtime'));
  app.setName('Cloude');
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  app.setPath('userData', dataDirectory);
  const browserDirectory = path.join(dataDirectory, 'browser-cache');
  fs.mkdirSync(browserDirectory, { recursive: true });
  app.setPath('sessionData', browserDirectory);
  return dataDirectory;
}

function loadDefaultMode(dataDirectory) {
  let preferences;
  try { preferences = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'startup.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return 'paseo';
    throw new Error(`无法读取启动设置，原文件已保留：${error.message}`);
  }
  if (preferences?.version !== 1 || !MODES.includes(preferences.mode)) {
    throw new Error('启动设置无效，请检查工作台数据目录中的 startup.json。');
  }
  return preferences.mode;
}

function resolveMode(argv, defaultMode) {
  const explicit = argv.filter(argument => argument === '--legacy' || argument === '--paseo');
  if (explicit.length) return explicit[explicit.length - 1].slice(2);
  return defaultMode;
}

function relaunchArgs(argv, mode) {
  if (!MODES.includes(mode)) throw new Error('工作台模式无效');
  return [...argv.slice(1).filter(argument => argument !== '--legacy' && argument !== '--paseo'), `--${mode}`];
}

function configurePaseoEnvironment(dataDirectory, env = process.env) {
  env.PASEO_TEST_APP_NAME = 'Cloude';
  env.PASEO_ELECTRON_USER_DATA_DIR = dataDirectory;
  env.PASEO_HOME = path.join(dataDirectory, 'paseo');
}

function saveDefaultMode(dataDirectory, mode) {
  if (!MODES.includes(mode)) throw new Error('工作台模式无效');
  return new StateStore(dataDirectory).write('startup.json', { version: 1, mode });
}

module.exports = { APP_ID, configureProfile, loadDefaultMode, resolveMode, relaunchArgs, configurePaseoEnvironment, saveDefaultMode };
