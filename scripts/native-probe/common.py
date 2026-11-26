"""原生协议探针公用：临时 HOME、按 Mesa 启动计划的环境变量、逐行收发 NDJSON / JSON-RPC。只连假网关。

所有探针都在「探针目录」（PROBE_DIR，默认当前目录）里读写：prepare.py 生成的 plans.json、拷出来的 Claude / agy 设置文件、
假网关的 dump.jsonl，以及各次探针的输出目录。见 docs/design-chat-native-mode.md §5。"""
import json, os, re, shutil, subprocess, sys, tempfile, threading, time, queue

P = os.path.abspath(os.environ.get("PROBE_DIR") or os.getcwd())
PLANS = json.load(open(os.path.join(P, "plans.json")))
REAL_HOME = os.path.expanduser("~")
# 与 chat-capture.py 同一顺序：PATH 上的优先，官方安装脚本的落点兜底
BIN = {"claude-code": shutil.which("claude") or os.path.join(REAL_HOME, ".local/bin/claude"),
       "kimi": shutil.which("kimi") or os.path.join(REAL_HOME, ".kimi-code/bin/kimi"),
       "agy": shutil.which("agy") or os.path.join(REAL_HOME, ".antigravity/antigravity/bin/agy")}


def make_home(agent, keep=None):
    home = keep or tempfile.mkdtemp(prefix=f"native-{agent}-")
    os.makedirs(home, exist_ok=True)
    work = os.path.join(home, "work"); os.makedirs(work, exist_ok=True)
    if agent == "claude-code":
        cj = {"hasCompletedOnboarding": True, "projects": {}}
        for w in {work, os.path.realpath(work)}:
            cj["projects"][w] = {"hasTrustDialogAccepted": True}
        json.dump(cj, open(os.path.join(home, ".claude.json"), "w"))
    if agent == "agy":
        d = os.path.join(home, ".gemini/antigravity-cli"); os.makedirs(os.path.join(d, "cache"), exist_ok=True)
        json.dump({"onboardingComplete": True, "consumerOnboardingComplete": True, "enterpriseOnboardingComplete": False},
                  open(os.path.join(d, "cache/onboarding.json"), "w"))
        json.dump({"trustedWorkspaces": sorted({work, os.path.realpath(work)})}, open(os.path.join(d, "settings.json"), "w"))
    return home, work


def make_env(agent, home):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("CLAUDE_CODE_", "ANTHROPIC_", "GHOSTTY", "TERM", "LC_TERMINAL", "KIMI_", "GEMINI_", "GOOGLE_"))
           and k not in ("CLAUDECODE", "COLORTERM")}
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"):
        env.pop(k, None)
    env.update(HOME=home, NO_PROXY="127.0.0.1", no_proxy="127.0.0.1")
    for k, v in PLANS[agent]["env"]:
        env[k] = v
    return env


def plan_args(agent, tier=None):
    """计划里的参数，--settings 换成探针目录里拷出来的那份（Mesa 60 秒后清理原件）"""
    plan = PLANS[agent]
    a = list(plan["args"] if tier is None else plan["permission"][tier])
    if "--settings" in a:
        i = a.index("--settings")
        a[i + 1] = os.path.join(P, {"claude-code": "claude-settings.json", "agy": "agy-settings.json"}[agent])
    return a


class Proc:
    """逐行读 stdout 的子进程；所有收发记进 log"""

    def __init__(self, argv, env, cwd, log):
        self.log = open(log, "w", encoding="utf-8")
        self.log.write("ARGV " + json.dumps(argv, ensure_ascii=False) + "\n")
        self.p = subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=open(log + ".stderr", "w"), text=True, encoding="utf-8", bufsize=1)
        self.q = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.p.stdout:
            self.log.write("<< " + line); self.log.flush()
            self.q.put(line)
        self.q.put(None)

    def send(self, obj):
        s = json.dumps(obj, ensure_ascii=False)
        self.log.write(">> " + s + "\n"); self.log.flush()
        self.p.stdin.write(s + "\n"); self.p.stdin.flush()

    def recv(self, timeout):
        """下一条 JSON（非 JSON 行跳过）；超时 / 进程退出返回 None"""
        end = time.time() + timeout
        while time.time() < end:
            try:
                line = self.q.get(timeout=max(0.05, end - time.time()))
            except queue.Empty:
                return None
            if line is None:
                return None
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except ValueError:
                self.log.write("## 非 JSON 行\n")
        return None

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.p.kill()
        self.log.close()


class Rpc(Proc):
    """ACP：JSON-RPC 2.0 over stdio。call 等自己的回包，期间对方发来的请求交给 on_request，通知存进 notes"""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.next_id = 0
        self.notes = []
        self.on_request = lambda msg: None

    def call(self, method, params, timeout=60):
        self.next_id += 1
        mid = self.next_id
        self.send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        end = time.time() + timeout
        while time.time() < end:
            msg = self.recv(end - time.time())
            if msg is None:
                return {"error": "timeout-or-exit"}
            if "method" in msg and "id" in msg:
                res = self.on_request(msg)
                if res is not None:
                    self.send({"jsonrpc": "2.0", "id": msg["id"], "result": res})
                continue
            if "method" in msg:
                self.notes.append(msg)
                continue
            if msg.get("id") == mid:
                return msg
        return {"error": "timeout"}


def gateway_requests():
    path = os.path.join(P, "dump.jsonl")
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()] if os.path.exists(path) else []
