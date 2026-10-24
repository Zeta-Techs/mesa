"""CLI 金丝雀：九家 CLI 每次更新后，自动看 Mesa 依赖它的几层变没变、还通不通（2026-10-22 从两家扩到九家）。

各家 CLI 几乎每天一版，默认行为常常不写进更新日志就变（2026-10-21：Claude Code 新版对第三方模型藏工具搜索、
不发任务清单工具，都是用户撞上才发现）。这里把 scripts/e2e-model-routing 的假网关、Mesa 自己的旁路端到端测试、
聊天层抓屏串成一条，抽出「指纹」与基线比：

  请求    假网关收到的主对话请求：工具清单、系统提示词的小标题、开头注入的上下文标签、请求字段与关键请求头
  旁路    Mesa 的 chat_channel 端到端（真 CLI、临时 HOME）：认出会话、回合状态、审批形态
  会话    会话文件里出现的记录类型与字段；Mesa 解析器读出的对话（用户这句、工具调用与结果、回复都在）
  画面    聊天层读屏：审批菜单认不认得出、实时预览读不读得到
  Codex   本机 Codex 的默认提示词还取不取得到（Mesa 给 Codex 的 base_instructions 来源）

用法（仓库根目录）：
  python -I -X utf8 scripts/cli-canary/canary.py                 # 九家都跑（没装的跳过），和 baseline/<平台>/ 比
  python -I -X utf8 scripts/cli-canary/canary.py --accept        # 核对过、Mesa 也改好了：把这次的指纹记成新基线
  python -I -X utf8 scripts/cli-canary/canary.py --accept-unchanged  # 只有版本往前走、指纹没变：把核对版本往前挪
  可选：--agents codex,qwen  --out <目录>  --skip-screen（不抓屏，不需要 pyte）
退出码：0 = 没变化且检查全过；1 = 有变化或检查没过（看 <out>/report.md）；2 = 环境问题没跑起来。
不用任何真实密钥：请求只到本机假网关；临时 HOME 不拷本机配置（用户的 MCP / 插件会改工具清单，各台机器才可比）。
"""
import argparse, json, os, re, shutil, socket, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
E2E = os.path.join(ROOT, "scripts", "e2e-model-routing")
HERE = os.path.dirname(os.path.abspath(__file__))
PLATFORM = sys.platform if sys.platform in ("win32", "darwin") else "linux"
BIN = {"claude-code": "claude", "codex": "codex", "gemini": "gemini", "qwen": "qwen", "opencode": "opencode",
       "kimi": "kimi", "codebuddy": "codebuddy", "cursor": "cursor-agent", "grok": "grok"}
# 不在 PATH 上时的常见安装位置（Kimi 官方安装脚本装在自己的目录里）
BIN_FALLBACK = {"kimi": "~/.kimi-code/bin/kimi"}
# 有结构化旁路的家跑 Mesa 的旁路端到端（chat_channel e2e）；Gemini / Kimi 不开全局 hooks、Cursor 没有旁路，只抓屏。
# Grok 的旁路是程序状态（OSC 7501），Windows 的 ConPTY 两个方向都吞 OSC，Mesa 在 Windows 不接它（chat_channel.rs prepare），也只抓屏
CHANNEL = {"claude-code", "codebuddy", "qwen", "opencode", "codex", "grok"} - ({"grok"} if PLATFORM == "win32" else set())
# 旁路直接报会话 id 的家（Grok 的程序状态不带会话 id）
SESSION_ID = CHANNEL - {"grok"}
# 连不上假网关的家（Cursor 只走自家云端，临时 HOME 里也没登录）：只记版本，请求 / 画面都不比
NO_GATEWAY = {"cursor"}
TOOL_PROMPT = {"codex": "TRIGGER_TOOL TRIGGER_ESC 跑一下"}
DEFAULT_TOOL_PROMPT = "TRIGGER_TOOL 跑一下"
# 公开发版说明（GitHub Releases）；Claude 另取 CHANGELOG.md，没有公开说明的家不取
RELEASES = {"codex": "openai/codex", "gemini": "google-gemini/gemini-cli", "qwen": "QwenLM/qwen-code",
            "opencode": "sst/opencode"}
CHANGELOG_KEYWORDS = re.compile(
    r"env|hook|session|transcript|rollout|jsonl|tool|todo|task|config|setting|permission|approv|sandbox|app-server|"
    r"instruction|prompt|windows|stream|render|provider|gateway|base.?url|resume|/clear|third-party|model", re.I)


def log(msg):
    print(msg, flush=True)


def cargo():
    found = shutil.which("cargo")
    if found:
        return found
    for cand in (os.path.expanduser("~/.cargo/bin/cargo.exe"), os.path.expanduser("~/.cargo/bin/cargo")):
        if os.path.exists(cand):
            return cand
    sys.exit("找不到 cargo（Rust 不在 PATH，也不在 ~/.cargo/bin）")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    return port


def run(cmd, cwd=None, env=None, timeout=600):
    """跑一个子进程，返回 (退出码, 合并输出)；超时记成 'timeout'"""
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, stdin=subprocess.DEVNULL)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return "timeout", out


def bin_path(agent):
    found = shutil.which(BIN[agent])
    if found:
        return found
    fb = BIN_FALLBACK.get(agent)
    return os.path.expanduser(fb) if fb and os.path.exists(os.path.expanduser(fb)) else None


def version_of(agent):
    b = bin_path(agent)
    if not b:
        return None
    code, out = run([b, "--version"], timeout=60)
    m = re.search(r"\d+\.\d+\.\d+", out)
    return m.group(0) if m else None


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:3])


# 抓屏 / e2e 的临时工作目录每次随机（Claude 审批菜单「always allow access to <目录>」会带出来），换成占位再比
WORKDIR = re.compile(r"[^\s'\"`]*?[\\/](?:cc-[\w-]+|mesa-e2e-\w+)[\\/]work")


def normalize(v):
    if isinstance(v, str):
        return WORKDIR.sub("<工作目录>", v)
    if isinstance(v, list):
        return [normalize(x) for x in v]
    if isinstance(v, dict):
        return {k: normalize(x) for k, x in v.items()}
    return v


# ---------- 指纹 ----------

HEADING = re.compile(r"^#{1,4}\s+(.+?)\s*$", re.M)
TAG = re.compile(r"<([a-z][a-z0-9_-]{2,40})>")


def text_of(v):
    """系统提示词 / 一条输入里的全部文字"""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "\n".join(text_of(x) for x in v)
    if isinstance(v, dict):
        for k in ("text", "content"):
            if k in v:
                return text_of(v[k])
    return ""


def tool_names(body):
    out = []
    for t in body.get("tools") or []:
        if not isinstance(t, dict):
            continue
        if isinstance(t.get("function"), dict):
            out.append(t["function"].get("name", ""))
        else:
            out.append(t.get("name") or t.get("type") or "")
    return sorted(set(out))


def request_fingerprint(reqs):
    """主对话请求（带工具、带这次的提问）的形状；后台小请求（标题 / 话题判断）只记路径和有没有工具"""
    main = [r for r in reqs if r["body"].get("tools") and "TRIGGER_TOOL" in json.dumps(r["body"], ensure_ascii=False)]
    if not main:
        return {"main": None, "other": sorted({f'{r["path"]} tools={bool(r["body"].get("tools"))}' for r in reqs})}
    # 第一次发问那条（还没有工具结果）
    r = min(main, key=lambda x: x["t"])
    body = r["body"]
    system = text_of(body.get("system")) or text_of(body.get("instructions"))
    # 用户这句之前注入的上下文：Anthropic 在 messages 里，Responses 在 input 里
    items = body.get("messages") or body.get("input") or []
    before = []
    for it in items if isinstance(items, list) else []:
        t = text_of(it.get("content") if isinstance(it, dict) else it)
        if "TRIGGER_TOOL" in t:
            before.append(t.split("TRIGGER_TOOL")[0])
            break
        before.append(t)
    context = "\n".join(before)
    headers = {}
    for k, v in r["headers"].items():
        if k == "anthropic-beta":
            headers[k] = sorted(x.strip() for x in v.split(","))
        elif k in ("user-agent", "version"):
            headers[k] = "<有>"  # 带版本号，只看有没有
        else:
            headers[k] = v
    return {
        "main": {
            "path": r["path"],
            "model": body.get("model"),
            "tools": tool_names(body),
            "bodyKeys": sorted(body.keys()),
            "systemHeadings": sorted(set(HEADING.findall(system))),
            "contextTags": sorted(set(TAG.findall(context + "\n" + system))),
            "contextHeadings": sorted(set(HEADING.findall(context))),
            "headers": headers,
        },
        "other": sorted({f'{x["path"]} tools={bool(x["body"].get("tools"))}' for x in reqs if x is not r and x not in main}),
    }


def transcript_fingerprint(path):
    """会话文件：每种记录（type / subtype，Codex 是 type / payload.type）出现过哪些字段、哪些内容块"""
    if not os.path.exists(path):
        return None
    recs = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        payload = d.get("payload") if isinstance(d.get("payload"), dict) else None
        sub = d.get("subtype") or (payload or {}).get("type")
        sig = f'{d.get("type")}/{sub}' if sub else str(d.get("type"))
        e = recs.setdefault(sig, {"keys": set(), "payloadKeys": set(), "blocks": set()})
        e["keys"].update(d.keys())
        if payload:
            e["payloadKeys"].update(payload.keys())
        content = (d.get("message") or {}).get("content") if isinstance(d.get("message"), dict) else None
        if isinstance(content, list):
            e["blocks"].update(str(b.get("type")) for b in content if isinstance(b, dict))
    return {sig: {k: sorted(v) for k, v in e.items() if v} for sig, e in sorted(recs.items())}


def parsed_fingerprint(path):
    """Mesa 解析器（sessions::conversation_impl_raw）读出的对话"""
    if not os.path.exists(path):
        return None, {}
    msgs = json.load(open(path, encoding="utf-8"))
    blocks = [(m["role"], b) for m in msgs for b in m.get("blocks", [])]
    kinds = sorted({f'{role}:{b["kind"]}' for role, b in blocks})
    tools = sorted({b.get("toolName") for _, b in blocks if b["kind"] == "tool_use" and b.get("toolName")})
    checks = {
        "解析器读到用户这句": any(r == "user" and b["kind"] == "text" and "TRIGGER_TOOL" in b["text"] for r, b in blocks),
        "解析器读到工具调用": any(b["kind"] == "tool_use" for _, b in blocks),
        "解析器读到工具结果": any(b["kind"] == "tool_result" for _, b in blocks),
        "解析器读到回复": any(r == "assistant" and b["kind"] == "text" and "done" in b["text"] for r, b in blocks),
    }
    return {"blockKinds": kinds, "toolNames": tools}, checks


# ---------- 各阶段 ----------

class Gateway:
    def __init__(self, out):
        self.port = free_port()
        self.dump = os.path.join(out, "gateway-dump.jsonl")
        self.log = os.path.join(out, "gateway.log")
        env = dict(os.environ, E2E_DUMP=self.dump)
        self.proc = subprocess.Popen([sys.executable, "-I", "-X", "utf8", os.path.join(E2E, "gateway.py"), str(self.port), self.log],
                                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                return
            except OSError:
                time.sleep(0.1)
        sys.exit("假网关没起来")

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def mark(self):
        return sum(1 for _ in open(self.dump, encoding="utf-8")) if os.path.exists(self.dump) else 0

    def since(self, mark):
        if not os.path.exists(self.dump):
            return []
        lines = open(self.dump, encoding="utf-8").read().splitlines()[mark:]
        return [json.loads(l) for l in lines if l.strip()]

    def stop(self):
        self.proc.terminate()


def make_plans(gw, out):
    """Mesa 的真实启动计划（Claude 的 --settings 文件 60 秒后会被 Mesa 清理，每个阶段前重新生成）"""
    plans = os.path.join(out, "plans.json")
    env = dict(os.environ, E2E_BASE=gw.base, E2E_OUT=plans)
    code, text = run([cargo(), "test", "--lib", "e2e_dump_launch_plans", "--", "--ignored"],
                     cwd=os.path.join(ROOT, "src-tauri"), env=env, timeout=1800)
    if code != 0 or not os.path.exists(plans):
        open(os.path.join(out, "plans-error.txt"), "w", encoding="utf-8").write(text)
        sys.exit(f"生成启动计划失败，见 {out}/plans-error.txt")
    return plans


def channel_phase(agent, gw, out, adir):
    plans = make_plans(gw, out)
    keep = os.path.join(adir, "channel")
    env = dict(os.environ, MESA_E2E_REAL_CLI="1", E2E_PLANS=plans, E2E_AGENT=agent, E2E_CLEAN_HOME="1", E2E_KEEP=keep)
    mark = gw.mark()
    code, text = run([cargo(), "test", "--lib", "e2e_channel", "--", "--ignored", "--nocapture"],
                     cwd=os.path.join(ROOT, "src-tauri"), env=env, timeout=600)
    open(os.path.join(adir, "channel.log"), "w", encoding="utf-8").write(text)
    time.sleep(0.5)
    return code == 0, gw.since(mark), keep


def ensure_screen_deps(out):
    deps = os.environ.get("CANARY_DEPS") or os.path.join(tempfile.gettempdir(), "mesa-canary-deps")
    mods = ["pyte"] + (["winpty"] if PLATFORM == "win32" else [])
    probe = "import sys; sys.path.insert(0, sys.argv[1]); " + "; ".join(f"import {m}" for m in mods)
    if run([sys.executable, "-I", "-c", probe, deps], timeout=60)[0] != 0:
        pkgs = ["pyte"] + (["pywinpty"] if PLATFORM == "win32" else [])
        code, text = run([sys.executable, "-m", "pip", "install", "--quiet", "--target", deps, *pkgs], timeout=600)
        if code != 0:
            return None, f"装不上抓屏依赖（{' '.join(pkgs)}）：{text[-300:]}"
    return deps, None


def screen_phase(agent, gw, out, adir, deps):
    plans = make_plans(gw, out)
    cap = os.path.join(adir, "screen.json")
    env = dict(os.environ, PYTE_DIR=deps, PYWINPTY_DIR=deps, CLEAN_HOME="1", TOOL_PROMPT=TOOL_PROMPT.get(agent, DEFAULT_TOOL_PROMPT),
               MSYS_NO_PATHCONV="1")
    # 有「请求批准」档就按它抓（看审批菜单）；没有这一档的家（Kimi、OpenCode）按默认启动参数
    tier = "ask" if (json.load(open(plans, encoding="utf-8")).get(agent, {}).get("permission") or {}).get("ask") else "base"
    code, text = run([sys.executable, "-I", "-X", "utf8", os.path.join(E2E, "chat-capture.py"), plans, agent, tier, cap],
                     env=env, timeout=300)
    open(os.path.join(adir, "screen.log"), "w", encoding="utf-8").write(text)
    if not os.path.exists(cap):
        return None
    node = shutil.which("node") or "node"
    code, text = run([node, "--experimental-strip-types", "--no-warnings", os.path.join(E2E, "capture-check.ts"), cap],
                     cwd=ROOT, timeout=120)
    line = next((l for l in text.splitlines() if l.startswith("{")), None)
    return json.loads(line) if line else None


def codex_instructions_phase(adir):
    code, text = run([cargo(), "test", "--lib", "codex_instructions_extract_real", "--", "--ignored", "--nocapture"],
                     cwd=os.path.join(ROOT, "src-tauri"), timeout=600)
    open(os.path.join(adir, "codex-instructions.log"), "w", encoding="utf-8").write(text)
    return code == 0


def probe_agent(agent, gw, out, skip_screen, deps):
    adir = os.path.join(out, agent)
    os.makedirs(adir, exist_ok=True)
    fp = {"agent": agent, "platform": PLATFORM, "version": version_of(agent)}
    checks = {}
    if agent in CHANNEL:
        log(f"[{agent}] {fp['version']}：旁路端到端…")
        ok, reqs, keep = channel_phase(agent, gw, out, adir)
        checks["旁路端到端通过"] = ok
        fp["request"] = request_fingerprint(reqs)
        checks["假网关收到主对话请求"] = fp["request"]["main"] is not None
        ch_path = os.path.join(keep, "channel.json")
        ch = json.load(open(ch_path, encoding="utf-8")) if os.path.exists(ch_path) else {}
        if agent in SESSION_ID:
            checks["旁路认出会话"] = bool(ch.get("sessionId"))
        checks["旁路拿到会话文件"] = bool(ch.get("transcript"))
        checks["这一轮走完"] = bool(ch.get("done"))
        fp["channel"] = {k: ch.get(k) for k in ("kind", "statuses", "approvalKind", "approvalTool", "approvalReplyable")}
        fp["transcript"] = transcript_fingerprint(os.path.join(keep, "transcript.jsonl"))
        fp["parsed"], pchecks = parsed_fingerprint(os.path.join(keep, "parsed.json"))
        checks.update(pchecks or {"解析器读到用户这句": False})
    else:
        # 没有旁路的家：请求形状取抓屏那一趟假网关收到的（抓屏会发「跑命令」那一句）
        fp["request"] = None
        fp["channel"] = None
    if agent == "codex":
        log(f"[{agent}] 取本机默认提示词…")
        checks["取得到 Codex 默认提示词"] = codex_instructions_phase(adir)
    if agent in NO_GATEWAY:
        log(f"[{agent}] 连不上假网关，只记版本")
        fp["screen"] = None
    elif skip_screen or not deps:
        fp["screen"] = None
    else:
        log(f"[{agent}] 抓屏…")
        mark = gw.mark()
        s = screen_phase(agent, gw, out, adir, deps)
        if agent not in CHANNEL:
            fp["request"] = request_fingerprint(gw.since(mark))
            checks["假网关收到主对话请求"] = fp["request"]["main"] is not None
        checks["抓屏跑完"] = s is not None
        fp["screen"] = s and {
            "menu": s.get("menu") and {"question": s["menu"]["question"], "options": s["menu"]["options"]},
            "previewReadable": (s.get("bestPreviewLines") or 0) > 0,
            "liveReplySupported": s.get("liveReplySupported"),
        }
    fp["checks"] = checks
    fp = normalize(fp)
    json.dump(fp, open(os.path.join(adir, "fingerprint.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)
    return fp


# ---------- 比较与报告 ----------

def diff(old, new, path=""):
    """结构差异：列表按集合比（工具清单、字段名的顺序不算变化），标量直接比"""
    out = []
    if isinstance(old, dict) and isinstance(new, dict):
        for k in sorted(set(old) | set(new)):
            p = f"{path}.{k}" if path else k
            if k not in old:
                out.append(f"新增 `{p}`：{json.dumps(new[k], ensure_ascii=False)[:300]}")
            elif k not in new:
                out.append(f"消失 `{p}`（原来：{json.dumps(old[k], ensure_ascii=False)[:300]}）")
            else:
                out.extend(diff(old[k], new[k], p))
    elif isinstance(old, list) and isinstance(new, list) and all(isinstance(x, str) for x in old + new):
        add = [x for x in new if x not in old]
        gone = [x for x in old if x not in new]
        if add:
            out.append(f"`{path}` 多了：{', '.join(add)}")
        if gone:
            out.append(f"`{path}` 少了：{', '.join(gone)}")
    elif old != new:
        out.append(f"`{path}`：{json.dumps(old, ensure_ascii=False)[:200]} → {json.dumps(new, ensure_ascii=False)[:200]}")
    return out


def fetch(url, timeout=15):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mesa-cli-canary"})
        return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")
    except Exception:
        return None


def changelog(agent, old, new):
    """两个版本之间的更新日志里，和 Mesa 依赖的东西沾边的行（取不到就说取不到）"""
    if not old or not new or vtuple(old) >= vtuple(new):
        return []
    if agent != "claude-code" and agent not in RELEASES:
        return ["（这家没有公开的更新日志）"]
    sections = []  # [(版本, [行])]
    if agent == "claude-code":
        text = fetch("https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md")
        cache = os.path.expanduser("~/.claude/cache/changelog.md")
        if not text and os.path.exists(cache):
            text = open(cache, encoding="utf-8", errors="replace").read()
        if not text:
            return ["（取不到更新日志）"]
        cur = None
        for line in text.splitlines():
            m = re.match(r"^##\s+v?(\d+\.\d+\.\d+)", line)
            if m:
                cur = (m.group(1), []); sections.append(cur)
            elif cur and line.strip().startswith("-"):
                cur[1].append(line.strip())
    else:
        text = fetch(f"https://api.github.com/repos/{RELEASES[agent]}/releases?per_page=40")
        if not text:
            return ["（取不到更新日志）"]
        for rel in json.loads(text):
            m = re.search(r"(\d+\.\d+\.\d+)$", rel.get("tag_name") or "")
            if m and not rel.get("prerelease"):
                sections.append((m.group(1), [l.strip() for l in (rel.get("body") or "").splitlines() if l.strip().startswith(("-", "*"))]))
    out = []
    for ver, lines in sections:
        if vtuple(old) < vtuple(ver) <= vtuple(new):
            hits = [l for l in lines if CHANGELOG_KEYWORDS.search(l)]
            out.extend(f"{ver} {l}" for l in hits)
    return out[:80]


def baseline_path(agent):
    return os.path.join(HERE, "baseline", PLATFORM, f"{agent}.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agents", default=",".join(BIN))
    ap.add_argument("--out")
    ap.add_argument("--accept", action="store_true", help="把这次的指纹记成新基线（检查没全过时拒绝）")
    ap.add_argument("--accept-unchanged", action="store_true",
                    help="检查全过、指纹和基线一样、只有版本往前走时，把基线的核对版本往前挪（随包进 Mesa，见 src/cli-verified.ts）")
    ap.add_argument("--skip-screen", action="store_true")
    args = ap.parse_args()
    agents = [a for a in args.agents.split(",") if a]
    out = args.out or os.path.join(tempfile.gettempdir(), f"mesa-canary-{time.strftime('%Y%m%d-%H%M%S')}")
    os.makedirs(out, exist_ok=True)
    unknown = [a for a in agents if a not in BIN]
    if unknown:
        log(f"不认得：{', '.join(unknown)}"); sys.exit(2)
    # 没装的跳过（报告里写明），一家都没有才算环境问题
    missing = [a for a in agents if not bin_path(a)]
    agents = [a for a in agents if a not in missing]
    if not agents:
        log(f"一家都没装：{', '.join(missing)}"); sys.exit(2)
    deps, why = (None, None) if args.skip_screen else ensure_screen_deps(out)
    if why:
        log(why)
    gw = Gateway(out)
    report = [f"# CLI 金丝雀 · {time.strftime('%Y-%m-%d %H:%M')} · {PLATFORM}", ""]
    if missing:
        report += [f"> 没装、跳过：{', '.join(missing)}", ""]
    if why:
        report += [f"> 抓屏没跑：{why}", ""]
    bad = False
    try:
        for agent in agents:
            fp = probe_agent(agent, gw, out, args.skip_screen, deps)
            bp = baseline_path(agent)
            base = json.load(open(bp, encoding="utf-8")) if os.path.exists(bp) else None
            failed = [k for k, v in fp["checks"].items() if not v]
            compare = {k: v for k, v in fp.items() if k not in ("version", "checks")}
            if base and fp.get("screen") is None:
                base = {**base, "screen": None}  # 这次没抓屏，不算画面变化
            changes = diff({k: v for k, v in base.items() if k not in ("version", "checks")}, compare) if base else []
            report += [f"## {agent}", "",
                       f"- 版本：{fp['version']}（基线核对到 {base['version'] if base else '无基线'}）",
                       f"- 检查：{'全过' if not failed else '没过 —— ' + '、'.join(failed)}",
                       f"- 与基线比：{'没有变化' if base and not changes else ('无基线，用 --accept 建立' if not base else f'{len(changes)} 处变化')}", ""]
            report += [f"  - {c}" for c in changes]
            notes = changelog(agent, base and base.get("version"), fp["version"])
            if notes:
                report += ["", "### 更新日志里可能相关的条目", ""] + [f"  - {n}" for n in notes]
            report.append("")
            if args.accept:
                if failed:
                    report.append(f"> 没记成基线：检查没全过（{'、'.join(failed)}）"); bad = True
                else:
                    os.makedirs(os.path.dirname(bp), exist_ok=True)
                    json.dump(fp, open(bp, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1, sort_keys=True)
                    open(bp, "a", encoding="utf-8", newline="\n").write("\n")
                    report.append(f"> 已记成新基线：{os.path.relpath(bp, ROOT)}")
                report.append("")
            elif args.accept_unchanged and base and not failed and not changes and fp["version"] != base.get("version"):
                os.makedirs(os.path.dirname(bp), exist_ok=True)
                json.dump(fp, open(bp, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1, sort_keys=True)
                open(bp, "a", encoding="utf-8", newline="\n").write("\n")
                report += [f"> 指纹没变，核对版本前移到 {fp['version']}：{os.path.relpath(bp, ROOT)}", ""]
            elif failed or changes or not base:
                bad = True
    finally:
        gw.stop()
    text = "\n".join(report)
    open(os.path.join(out, "report.md"), "w", encoding="utf-8").write(text)
    log(text)
    log(f"\n明细：{out}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
