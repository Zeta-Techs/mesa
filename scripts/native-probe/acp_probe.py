"""ACP 探针：initialize → session/new（或 LOAD=<id> 时 session/load）→ 若干轮 session/prompt，审批按 PICK（allow_once 等）回。
用法：python3 acp_probe.py <agent> <输出目录> [轮次逗号分隔：tool,ask,slow,plan]；MODE=<modeId> 时开聊前 session/set_mode"""
import json, os, sys, time
from common import *

agent, out = sys.argv[1], os.path.abspath(sys.argv[2])
turns = (sys.argv[3] if len(sys.argv) > 3 else "tool").split(",")
os.makedirs(out, exist_ok=True)
home, work = make_home(agent, os.path.join(out, "home"))
if agent == "agy":
    s = os.path.join(home, ".gemini/antigravity-cli/settings.json")
    d = json.load(open(s)); d.update(json.load(open(os.path.join(P, "agy-settings.json")))); json.dump(d, open(s, "w"))
env = make_env(agent, home)
argv = [BIN[agent], "acp", *os.environ.get("EXTRA", "").split()]
rpc = Rpc(argv, env, work, os.path.join(out, "wire.log"))
report = {"agent": agent, "argv": argv[1:], "turns": []}
perms = []
PICK = os.environ.get("PICK", "allow_once")


def on_request(msg):
    if msg["method"] == "session/request_permission":
        p = msg["params"]
        perms.append(p)
        opts = p.get("options") or []
        pick = next((o for o in opts if o.get("kind") == PICK), opts[0] if opts else None)
        return {"outcome": {"outcome": "selected", "optionId": pick["optionId"]}} if pick else {"outcome": {"outcome": "cancelled"}}
    report.setdefault("other_requests", []).append(msg["method"])
    return {}


rpc.on_request = on_request
init = rpc.call("initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                                                                          "terminal": False},
                               "clientInfo": {"name": "mesa-probe", "version": "0"}}, timeout=60)
report["initialize"] = init.get("result") or init
if os.environ.get("LOAD"):
    sess = rpc.call("session/load", {"sessionId": os.environ["LOAD"], "cwd": work, "mcpServers": []}, timeout=90)
    sid = os.environ["LOAD"]
    report["load_replay_updates"] = [((n.get("params") or {}).get("update") or {}).get("sessionUpdate") for n in rpc.notes]
else:
    sess = rpc.call("session/new", {"cwd": work, "mcpServers": []}, timeout=90)
    sid = (sess.get("result") or {}).get("sessionId")
report["session"] = sess.get("result") or sess
report["session_id"] = sid
if os.environ.get("MODE") and sid:
    report["set_mode"] = rpc.call("session/set_mode", {"sessionId": sid, "modeId": os.environ["MODE"]}, timeout=30)
if os.environ.get("SETMODEL") and sid:
    m = os.environ["SETMODEL"]
    report["set_model"] = rpc.call("session/set_model", {"sessionId": sid, "modelId": m}, timeout=30)
    report["set_config_option"] = rpc.call("session/set_config_option", {"sessionId": sid, "configId": "model", "value": m}, timeout=30)
PROMPTS = {"tool": "TRIGGER_TOOL 写一个探针文件", "ask": "TRIGGER_ASK 问我一个问题", "slow": "TRIGGER_SLOW 慢慢说",
           "plan": "TRIGGER_PLAN 先做个方案", "slash": "/usage", "help": "/help"}
for t in turns:
    if not sid:
        break
    rpc.notes.clear(); perms.clear()
    res = rpc.call("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": PROMPTS[t]}]}, timeout=120)
    kinds = []
    for n in rpc.notes:
        u = (n.get("params") or {}).get("update") or {}
        k = u.get("sessionUpdate") or n.get("method")
        if u.get("sessionUpdate") in ("tool_call", "tool_call_update"):
            k += f"[{u.get('kind')},{u.get('status')}]"
        if not kinds or kinds[-1] != k:
            kinds.append(k)
    report["turns"].append({"turn": t, "result": res.get("result") or res, "updates": kinds,
                            "permission_requests": json.loads(json.dumps(perms))})
rpc.close()
report["probe_file"] = os.path.exists(os.path.join(work, "mesa_probe.txt"))
json.dump(report, open(os.path.join(out, "report.json"), "w"), ensure_ascii=False, indent=1)
print(json.dumps(report, ensure_ascii=False, indent=1)[:5000])
