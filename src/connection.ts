// Keep in sync with electron/key-path.cjs; this check runs before any IPC or
// disconnect so a pasted key never leaves the connection form.
export const containsKeyMaterial = (value: string | undefined) => !!value && /\b(?:BEGIN|END)\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY\b|PuTTY-User-Key-File-\d+:|b3BlbnNzaC1rZXktdjE/i.test(value);
export const privateKeyPathHelp = '这里需要私钥文件路径，不能粘贴私钥正文。请点击“选择”，选中本机私钥文件（不要选 .pub 公钥）。';
