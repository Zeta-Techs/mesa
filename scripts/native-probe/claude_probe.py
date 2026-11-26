"""Claude Code：-p 双向 stream-json + --permission-prompts host。用法：python3 claude_probe.py <tier> <输出目录> [轮次逗号分隔]
轮次：tool（跑命令要审批）、ask（AskUserQuestion）、slash（/context）、plan（计划模式结束计划）、slow（边写边显示）。
审批要交给宿主还得带 EXTRA="--permission-prompt-tool stdio"（--help 不列，只在 --permission-prompts 的说明里提到；不带则一律拒）；
边写边显示再加 --include-partial-messages。RESUME=<会话 id> 接回已有会话。
注意：假网关按整段请求找触发词，同一会话里前一轮的 TRIGGER_TOOL 会盖过后面的 ask / slow，这几种各开一个输出目录跑"""
import json, os, sys, time
from common import *

tier, out = sys.argv[1], os.path.abspath(sys.argv[2])
turns = (sys.argv[3] if len(sys.argv) > 3 else "tool").split(",")
os.makedirs(out, exist_ok=True)
home, work = make_home("claude-code", os.path.join(out, "home"))
env = make_env("claude-code", home)
argv = [BIN["claude-code"], "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--permission-prompts", "host", *os.environ.get("EXTRA", "").split(), *plan_args("claude-code", tier)]
if os.environ.get("RESUME"):
    argv += ["--resume", os.environ["RESUME"]]
pr = Proc(argv, env, work, os.path.join(out, "wire.log"))
report = {"tier": tier, "argv": argv[1:], "turns": []}
pr.send({"type": "control_request", "request_id": "init-1", "request": {"subtype": "initialize"}})

PROMPTS = {"tool": "TRIGGER_TOOL 写一个探针文件", "ask": "TRIGGER_ASK 问我一个问题", "slash": "/context",
           "plan": "TRIGGER_PLAN 先做个方案", "slow": "TRIGGER_SLOW 慢慢说"}
for t in turns:
    pr.send({"type": "user", "message": {"role": "user", "content": PROMPTS[t]}, "parent_tool_use_id": None,
             "session_id": ""})
    seen, perms, end = [], [], time.time() + 90
    result = None
    while time.time() < end:
        m = pr.recv(end - time.time())
        if m is None:
            break
        kind = m.get("type") + (":" + str(m.get("subtype")) if m.get("subtype") else "")
        if m.get("type") == "system" and m.get("subtype") == "init":
            report["session_id"] = m.get("session_id")
            report["permissionMode"] = m.get("permissionMode")
            report["slash_commands"] = m.get("slash_commands")
        if m.get("type") == "control_request":
            req = m.get("request") or {}
            kind += ":" + str(req.get("subtype"))
            if req.get("subtype") == "can_use_tool":
                perms.append({k: req.get(k) for k in ("tool_name", "input", "permission_suggestions", "decision_reason",
                                                         "blocked_path", "tool_use_id", "title", "description")})
                upd = dict(req.get("input") or {})
                if req.get("tool_name") == "AskUserQuestion":
                    qs = upd.get("questions") or []
                    upd["answers"] = {q["question"]: q["options"][1]["label"] for q in qs if q.get("options")}
                pr.send({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"],
                                                                   "response": {"behavior": "allow", "updatedInput": upd}}})
        if m.get("type") == "stream_event":
            ev = (m.get("event") or {}).get("type")
            kind += ":" + str(ev)
        if not seen or seen[-1] != kind:
            seen.append(kind)
        if m.get("type") == "result":
            result = {k: m.get(k) for k in ("subtype", "is_error", "result", "num_turns", "stop_reason", "permission_denials")}
            break
    report["turns"].append({"turn": t, "kinds": seen, "permission_requests": perms, "result": result})
pr.close()
report["probe_file"] = os.path.exists(os.path.join(work, "mesa_probe.txt"))
proj = os.path.join(home, ".claude/projects")
report["transcripts"] = [os.path.relpath(os.path.join(d, f), home) for d, _, fs in os.walk(proj) for f in fs if f.endswith(".jsonl")] if os.path.isdir(proj) else []
json.dump(report, open(os.path.join(out, "report.json"), "w"), ensure_ascii=False, indent=1)
print(json.dumps(report, ensure_ascii=False, indent=1)[:6000])
