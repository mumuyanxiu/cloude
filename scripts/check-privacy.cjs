const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const rules = [
  ['private network address', /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['Windows user path', /[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|example\b|fixture\b|test\b)[^\\/\s"']+/i],
  ['private key material', /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['access credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/],
];
// Personal names belong only in this ignored local list, never in the scanner.
const localPatternFile = path.join(root, '.privacy-patterns.local');
if (fs.existsSync(localPatternFile)) {
  const terms = JSON.parse(fs.readFileSync(localPatternFile, 'utf8'));
  if (!Array.isArray(terms) || terms.some(term => typeof term !== 'string' || !term)) throw new Error('Local privacy patterns must be an array of nonempty strings.');
  for (const term of terms) rules.push(['local privacy term', new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]);
}
const forbiddenFile = /(?:^|\/)(?:\.env(?!\.example$)|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$|workspace\.json$|credentials\.json$|known-hosts\.json$)|\.(?:pem|key|pfx|p12|log)$/i;
function publicFiles() {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
    .filter(name => fs.existsSync(path.join(root, name)));
}
function checkPrivacy(files = publicFiles()) {
  const violations = [];
  for (const name of files) {
    if (forbiddenFile.test(name)) violations.push(`${name}: private file`);
    if (/\.(?:png|ico|jpg|woff2?)$/.test(name)) continue;
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    content.split(/\r?\n/).forEach((line, index) => {
      for (const [label, pattern] of rules) if (pattern.test(line)) violations.push(`${name}:${index + 1}: ${label}`);
    });
  }
  return violations;
}
if (require.main === module) {
  const violations = checkPrivacy();
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('Privacy scan passed for tracked and unignored source files.');
}
module.exports = { checkPrivacy, publicFiles };
