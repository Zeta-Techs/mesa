"""续聊核对：按 Mesa 内嵌终端的恢复计划（e2e_dump_resume_plans 生成）拉起真 CLI，接着老对话问一句。

用法：python3 -I resume-drive.py <计划.json> <日志目录> [agent ...]
- 环境 = 干净登录 shell 的环境（同 Mesa 从访达打开时导入的，凭据类变量不带）+ 计划的 env / env_remove
- 不往原对话里写：能分叉的家都带分叉参数（Claude / CodeBuddy / Qwen / Grok / OpenCode / Kimi），
  Codex 在临时 CODEX_HOME 的副本上续；Gemini 没有分叉，会在原对话后追加这一问
- 结果：每条一份日志，末尾一行 RESULT=ok / fail；汇总打印到屏幕
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

MSG = "这是一条续聊连通性测试，请只回复两个字母：ok"
TIMEOUT = int(os.environ.get("RESUME_TIMEOUT", "240"))
HOME = os.path.expanduser("~")


def login_env():
    out = subprocess.run(
        ["env", "-i", f"HOME={HOME}", f"USER={os.environ.get('USER', '')}", "TERM=xterm-256color",
         "/bin/zsh", "-lic", "env -0"],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
    ).stdout.decode(errors="ignore")
    env = dict(kv.split("=", 1) for kv in out.split("\0") if "=" in kv)
    # 同 shell_env：API 密钥 / 端点类变量不从 shell 带入
    cred = re.compile(r"(API_KEY|AUTH_TOKEN|BASE_URL|_TOKEN|_SECRET)$")
    return {k: v for k, v in env.items() if not cred.search(k)}


def headless(plan, work):
    """交互恢复参数 → 非交互一问；返回 (argv 尾部, 额外 env)，或抛出说明"""
    a, sid, args = plan["agent"], plan["sid"], list(plan["args"])
    extra_env = {}
    if a == "claude-code":
        return args + ["--fork-session", "-p", MSG], extra_env
    if a == "codebuddy":
        return args + ["--fork-session", "-p", MSG], extra_env
    if a == "grok":
        return args + ["--fork-session", "-p", MSG], extra_env
    if a == "qwen":
        return args + ["--fork-session", MSG], extra_env
    if a == "opencode":
        return ["run"] + args + ["--fork", MSG], extra_env
    if a == "gemini":
        return args + ["-p", MSG], extra_env
    if a == "codex":
        assert args[:2] == ["resume", sid], args[:2]
        home = os.path.join(work, "codex-home")
        os.makedirs(os.path.join(home, "sessions", "x"), exist_ok=True)
        for f in ("config.toml", "auth.json"):
            src = os.path.join(os.environ.get("CODEX_HOME", HOME + "/.codex"), f)
            if os.path.exists(src):
                shutil.copy(src, home)
        shutil.copy(plan["file"], os.path.join(home, "sessions", "x"))
        extra_env["CODEX_HOME"] = home
        # --no-daemon 等只有交互界面认的开关，exec 不收
        rest = [x for x in args[2:] if x not in ("--no-daemon",)]
        return ["exec", "--skip-git-repo-check"] + rest + ["resume", sid, MSG], extra_env
    if a == "kimi":
        return args + ["-p", MSG], extra_env  # sid 由调用方先换成分叉出的新会话
    raise ValueError(f"未支持 {a}")


def run_one(plan, logdir, base_env):
    tag = f"{plan['agent']}-{plan['sid'][:16]}"
    log = open(os.path.join(logdir, tag + ".log"), "w")
    if plan.get("error"):
        log.write(f"PLAN_ERROR={plan['error']}\nRESULT=fail\n")
        return tag, "fail", "Mesa 拼计划失败：" + plan["error"]
    work = tempfile.mkdtemp(prefix="mesa-resume-")
    env = dict(base_env)
    for k in plan.get("env_remove", []):
        env.pop(k, None)
    env.update({k: v for k, v in plan["env"]})
    env.update({"PWD": plan["cwd"], "TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "Mesa"})
    binary = {"claude-code": "claude", "cursor": "cursor-agent"}.get(plan["agent"], plan["agent"])
    try:
        if plan["agent"] == "kimi":
            fork = subprocess.run([binary, "fork", plan["sid"], "-y"], cwd=plan["cwd"], env=env,
                                  capture_output=True, text=True, timeout=60)
            log.write("FORK: " + fork.stdout + fork.stderr + "\n")
            new = [s for s in re.findall(r"session_[0-9a-f-]{36}", fork.stdout + fork.stderr) if s != plan["sid"]]
            if not new:
                raise RuntimeError("kimi fork 没给出新会话")
            plan = dict(plan, args=[new[0] if x == plan["sid"] else x for x in plan["args"]])
        tail, extra_env = headless(plan, work)
        env.update(extra_env)
        log.write("ARGS: " + json.dumps([binary] + tail, ensure_ascii=False) + "\n")
        log.flush()
        p = subprocess.run([binary] + tail, cwd=plan["cwd"], env=env, stdin=subprocess.DEVNULL,
                           stdout=log, stderr=subprocess.STDOUT, timeout=TIMEOUT)
        code = p.returncode
    except subprocess.TimeoutExpired:
        code = "timeout"
    except Exception as e:  # noqa: BLE001
        log.write(f"ERROR: {e}\n")
        code = "error"
    log.close()
    text = open(os.path.join(logdir, tag + ".log"), errors="ignore").read()
    body = "\n".join(ln for ln in text.splitlines() if not ln.startswith(("ARGS: ", "FORK: ")))
    ok = code == 0 and re.search(r"(?im)^[\s•*>-]*ok\**\s*$", body) is not None
    with open(os.path.join(logdir, tag + ".log"), "a") as f:
        f.write(f"\nEXIT={code}\nRESULT={'ok' if ok else 'fail'}\n")
    last = [ln for ln in body.strip().splitlines() if ln.strip() and "rmcp::" not in ln][-1:] or [""]
    return tag, "ok" if ok else "fail", f"exit={code} {last[0][:160]}"


def main():
    plans = json.load(open(sys.argv[1]))
    logdir = sys.argv[2]
    only = set(sys.argv[3:])
    os.makedirs(logdir, exist_ok=True)
    base = login_env()
    seen, todo = set(), []
    for p in plans:
        if (only and p["agent"] not in only) or (p["agent"], p["sid"]) in seen:
            continue
        seen.add((p["agent"], p["sid"]))
        todo.append(p)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda p: run_one(p, logdir, base), todo))
    for (tag, res, note), p in zip(results, todo):
        print(f"{res:4} {tag:34} {p.get('profile')} · {p.get('model')} | {note}")


if __name__ == "__main__":
    main()
