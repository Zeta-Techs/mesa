"""端到端核对：用 Mesa 生成的真实启动计划拉起各家 CLI（非交互一问），看假网关收到的请求。
HOME 换成临时目录，但把用户真实的 CLI 配置文件拷进去——这样「用户全局配置会不会盖过 Mesa 注入」也一并验到，
又不往用户自己的会话目录里写东西。"""
import json, os, shutil, subprocess, sys, tempfile, time

plans = json.load(open(sys.argv[1]))
log_path = sys.argv[2]
only = set(sys.argv[3:])
real_home = os.path.expanduser("~")
COPY = [".claude/settings.json", ".claude.json", ".codex/config.toml", ".grok/config.toml", ".qwen/settings.json",
        ".kimi-code/config.toml", ".config/opencode/opencode.json", ".gemini/settings.json", ".cursor/cli-config.json"]
BIN = {a: shutil.which(b) for a, b in {"claude-code": "claude", "codebuddy": "codebuddy", "codex": "codex", "qwen": "qwen",
       "kimi": "kimi", "opencode": "opencode", "grok": "grok", "gemini": "gemini"}.items()}
BIN["kimi"] = BIN["kimi"] or os.path.join(real_home, ".kimi-code/bin/kimi")
CMD = {
    "claude-code": lambda b, a: [b, *a, "-p", os.environ.get("E2E_PROMPT", "say ok"), "--no-session-persistence"],
    "codebuddy": lambda b, a: [b, *a, "-p", "say ok"],
    "codex": lambda b, a: [b, "exec", "--skip-git-repo-check", *a, "say ok"],
    "qwen": lambda b, a: [b, *a, "-p", "say ok"],
    "kimi": lambda b, a: [b, *a, "-p", "say ok"],
    "opencode": lambda b, a: [b, "run", *a, "say ok"],
    "grok": lambda b, a: [b, *a, "-p", "say ok"],
    "gemini": lambda b, a: [b, *a, "-p", "say ok"],
}
results = {}
for agent, plan in plans.items():
    if only and agent not in only: continue
    if "error" in plan:
        results[agent] = {"refused": plan["error"]}; continue
    b = BIN.get(agent)
    if not b or not os.path.exists(b):
        results[agent] = {"skipped": "未安装"}; continue
    home = tempfile.mkdtemp(prefix=f"e2e-{agent}-"); os.chmod(home, 0o700)
    for rel in COPY:
        src = os.path.join(real_home, rel)
        if os.path.exists(src):
            dst = os.path.join(home, rel); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
    work = os.path.join(home, "work"); os.makedirs(work)
    # 去掉本会话自己带的 ANTHROPIC_* / CLAUDE_CODE_*（Mesa 从桌面启动时没有这些），只留 Mesa 计划里的
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_CODE_", "ANTHROPIC_")) and k != "CLAUDECODE"}
    env.update(HOME=home, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost", TERM="xterm-256color")
    for k in plan.get("env_remove", []): env.pop(k, None)
    for k, v in plan["env"]: env[k] = v
    before = sum(1 for _ in open(log_path)) if os.path.exists(log_path) else 0
    t0 = time.time()
    try:
        p = subprocess.run(CMD[agent](b, plan["args"]), cwd=work, env=env, capture_output=True, text=True, timeout=75, stdin=subprocess.DEVNULL)
        out, code = (p.stdout + p.stderr)[-600:], p.returncode
    except subprocess.TimeoutExpired as e:
        out, code = ((e.stdout or b"").decode(errors="ignore") + (e.stderr or b"").decode(errors="ignore"))[-600:] if isinstance(e.stdout, bytes) else str(e)[-300:], "timeout"
    time.sleep(0.5)
    reqs = [json.loads(l) for l in open(log_path).read().splitlines()[before:]]
    results[agent] = {"exit": code, "secs": round(time.time() - t0, 1), "requests": reqs, "tail": out.strip()[-400:]}
    shutil.rmtree(home, ignore_errors=True)
json.dump(results, open(sys.argv[1] + ".results.json", "w"), ensure_ascii=False, indent=1)
for a, r in results.items():
    print("==", a, {k: v for k, v in r.items() if k not in ("requests", "tail")})
    for q in r.get("requests", []):
        print("   ", q.get("method", q.get("note")), q.get("path", q.get("tool")), "model=", q.get("model"), (q.get("hint") or "")[-70:].replace("\n", " "))
    if r.get("tail") and (os.environ.get("E2E_TAIL") or not any(q["method"] == "POST" for q in r.get("requests", []))):
        print("    tail:", r["tail"].replace("\n", " | ")[:400])
