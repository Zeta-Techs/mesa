"""原生协议探针的准备：在探针目录（PROBE_DIR，默认当前目录）起假网关、按 Mesa 真实启动计划生成 plans.json，
并把 Claude / agy 的会话级设置文件拷进来（Mesa 60 秒后会清理 external-launch 下的原件）。

用法（仓库根目录）：PROBE_DIR=/tmp/native python3 -I scripts/native-probe/prepare.py [端口]
假网关留在后台跑，打印出 PID，探针跑完自己 kill。之后照 docs/design-chat-native-mode.md §5 跑各探针。
"""
import json, os, shutil, socket, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = os.path.abspath(os.environ.get("PROBE_DIR") or os.getcwd())
os.makedirs(P, exist_ok=True)
port = int(sys.argv[1]) if len(sys.argv) > 1 else 18931
gw = subprocess.Popen([sys.executable, "-I", "-X", "utf8", os.path.join(ROOT, "scripts/e2e-model-routing/gateway.py"), str(port),
                       os.path.join(P, "gw.log")], env=dict(os.environ, E2E_DUMP=os.path.join(P, "dump.jsonl")),
                      stdout=subprocess.DEVNULL, stderr=open(os.path.join(P, "gw.err"), "w"), start_new_session=True)
for _ in range(100):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
        break
    except OSError:
        time.sleep(0.1)
else:
    sys.exit(f"假网关没起来，见 {P}/gw.err")
cargo = shutil.which("cargo") or os.path.expanduser("~/.cargo/bin/cargo")
r = subprocess.run([cargo, "test", "--lib", "e2e_dump_launch_plans", "--", "--ignored"], cwd=os.path.join(ROOT, "src-tauri"),
                   env=dict(os.environ, E2E_BASE=f"http://127.0.0.1:{port}", E2E_OUT=os.path.join(P, "plans.json")),
                   capture_output=True, text=True)
if r.returncode != 0:
    gw.kill()
    sys.exit(r.stdout[-2000:] + r.stderr[-2000:])
plans = json.load(open(os.path.join(P, "plans.json")))
for agent, name in (("claude-code", "claude-settings.json"), ("agy", "agy-settings.json")):
    args = plans[agent]["args"]
    shutil.copy(args[args.index("--settings") + 1], os.path.join(P, name))
print(f"假网关 PID {gw.pid}，端口 {port}；探针目录 {P}")
