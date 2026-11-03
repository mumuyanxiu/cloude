"""Read Claude's project transcripts without starting Claude or changing files."""
import collections
import json
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MAX_MESSAGES = 200
MAX_TEXT = 8000
MAX_DISPLAY_BYTES = 512 * 1024
MAX_LINE = 8 * 1024 * 1024
ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$")


def text_content(row):
    message = row.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(block.get("text", "") for block in content
                         if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str))
    return ""


def visible(row):
    return row.get("type") in ("user", "assistant") and not row.get("isSidechain") and not row.get("isMeta")


def samples(filename):
    with open(filename, "rb") as stream:
        head = stream.read(256 * 1024)
        stream.seek(0, 2)
        size = stream.tell()
        if size > len(head):
            stream.seek(max(len(head), size - 256 * 1024))
            tail = stream.read().split(b"\n", 1)[-1]
        else:
            tail = b""
    for line in head.splitlines() + tail.splitlines():
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                yield row
        except (ValueError, UnicodeError):
            pass


def metadata(filename, project, session_id):
    title = ""
    custom = ""
    matched = False
    for row in samples(filename):
        if row.get("sessionId") not in (None, session_id):
            continue
        if isinstance(row.get("cwd"), str) and os.path.realpath(row["cwd"]) == project:
            matched = True
        if row.get("type") == "custom-title" and isinstance(row.get("customTitle"), str):
            custom = row["customTitle"]
        if not title and visible(row) and row.get("type") == "user":
            text = text_content(row)
            command = re.search(r"<command-name>(.*?)</command-name>", text)
            title = ("终端命令 " + command.group(1)) if command else " ".join(text.split())[:100]
    if not matched:
        return None
    return {"sessionId": session_id, "title": (custom or title or "未命名对话")[:100],
            "updatedAt": int(os.stat(filename).st_mtime * 1000)}


def transcript_path(directory, session_id):
    if not isinstance(session_id, str) or not ID.fullmatch(session_id):
        raise ValueError("会话 ID 无效")
    filename = os.path.join(directory, session_id + ".jsonl")
    if os.path.islink(filename) or os.path.dirname(os.path.realpath(filename)) != directory:
        raise ValueError("会话路径无效")
    return filename


def read_messages(filename, project, session_id):
    if os.stat(filename).st_size > 256 * 1024 * 1024:
        raise ValueError("这份会话超过 256 MB，请在 设备终端中打开")
    parents = {}
    messages = collections.OrderedDict()
    leaf = None
    clipped = False
    with open(filename, "rb") as stream:
        for index in range(200000):
            line = stream.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                while line and not line.endswith(b"\n"):
                    line = stream.readline(MAX_LINE + 1)
                clipped = True
                continue
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(row, dict) or row.get("isSidechain") or row.get("sessionId") not in (None, session_id):
                continue
            uid = row.get("uuid")
            if not isinstance(uid, str):
                continue
            parents[uid] = row.get("parentUuid")
            if visible(row):
                text = text_content(row)
                if text.strip():
                    clipped = clipped or len(text) > MAX_TEXT
                    messages[uid] = {"id": uid, "role": row["type"], "content": text[:MAX_TEXT]}
                    leaf = uid
                    if len(messages) > 1000:
                        messages.popitem(last=False)
                        clipped = True
        else:
            raise ValueError("会话记录条目过多，请在 设备终端中打开")
    result = []
    seen = set()
    byte_count = 0
    while isinstance(leaf, str) and leaf not in seen:
        seen.add(leaf)
        message = messages.get(leaf)
        if message:
            size = len(message["content"].encode("utf-8"))
            if len(result) >= MAX_MESSAGES or byte_count + size > MAX_DISPLAY_BYTES:
                clipped = True
                break
            result.append(message)
            byte_count += size
        leaf = parents.get(leaf)
    result.reverse()
    return result, clipped


def run():
    project = os.path.realpath(sys.argv[1])
    operation = sys.argv[2]
    config = os.path.realpath(os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude")))
    projects = os.path.join(config, "projects")
    slug = re.sub(r"[^a-zA-Z0-9]", "-", project)
    directory = os.path.join(projects, slug)
    if os.path.realpath(directory) != directory:
        raise ValueError("Claude 会话目录包含符号链接，请检查后重试")
    if operation == "list":
        if not os.path.isdir(directory):
            return {"sessions": [], "warning": "未找到这个目录对应的 Claude Code 会话记录。"}
        candidates = []
        for entry in os.scandir(directory):
            if entry.name.endswith(".jsonl") and ID.fullmatch(entry.name[:-6]) and entry.is_file(follow_symlinks=False):
                candidates.append((entry.stat().st_mtime, entry.name[:-6]))
        candidates.sort(reverse=True)
        sessions = []
        for _, session_id in candidates[:100]:
            try:
                item = metadata(transcript_path(directory, session_id), project, session_id)
                if item:
                    sessions.append(item)
            except OSError:
                continue
        return {"sessions": sessions, "warning": "仅列出最近 100 份记录。" if len(candidates) > 100 else ""}
    if operation != "read":
        raise ValueError("未知的会话读取请求")
    session_id = sys.argv[3]
    filename = transcript_path(directory, session_id)
    info = metadata(filename, project, session_id)
    if not info:
        raise ValueError("这份会话不属于当前项目")
    messages, clipped = read_messages(filename, project, session_id)
    return {**info, "messages": messages, "truncated": clipped,
            "notice": "历史预览仅显示文字消息，最多最近 200 条。发送消息时使用 远程设备上的原会话继续。"}


try:
    print(json.dumps(run(), ensure_ascii=False))
except Exception as error:
    print(json.dumps({"error": str(error)}, ensure_ascii=False))
    sys.exit(1)
