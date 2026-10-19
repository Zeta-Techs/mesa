"""假网关：记录每个请求打到哪个路径、带的什么模型；按协议回一个最小可用的回复（让 CLI 至少能走完一轮）。"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open(sys.argv[2], "a", buffering=1)
MODELS = ["e2e-default", "e2e-picked"]

# 聊天层第三期抓屏用的两个触发词（只认带工具列表的主对话请求，标题 / 摘要这类后台请求照常回 ok）：
# TRIGGER_SLOW = 慢慢流出一段多行回复（看实时预览能不能从屏上读）；TRIGGER_TOOL = 先回一个「跑命令」工具调用、
# 拿到结果后再回 done（看各家权限档是先问还是直接放行）
SLOW_LINES = ["第一段：这是一段慢慢流出来的回复。", "", "- 要点一：终端先画出来", "- 要点二：会话文件后落盘",
              "", "```bash", "echo mesa", "```", "", "最后一行：完毕。"]
# TRIGGER_LONG = 比一屏还长的回复（看回复开头滚出屏后预览还接不接得上，2026-10-19 用户：Codex 第 22 行卡住）
LONG_LINES = [f"第 {i} 行：长回复逐行流出。" for i in range(1, 61)]
PROBE = "echo mesa > mesa_probe.txt"
SHELLISH = ("bash", "shell", "run_shell_command", "exec_command", "run_command", "terminal", "execute", "command")


def tool_list(body):
    """各协议的工具清单 → [(名字, JSON schema)]"""
    out = []
    for t in body.get("tools") or []:
        if not isinstance(t, dict):
            continue
        if "functionDeclarations" in t:  # gemini
            for f in t["functionDeclarations"]:
                out.append((f.get("name", ""), f.get("parametersJsonSchema") or f.get("parameters") or {}))
        elif isinstance(t.get("function"), dict):  # chat completions
            out.append((t["function"].get("name", ""), t["function"].get("parameters") or {}))
        else:  # anthropic / responses
            out.append((t.get("name") or t.get("type") or "", t.get("input_schema") or t.get("parameters") or {}))
    return out


def pick_shell(tools):
    for want in SHELLISH:
        for name, schema in tools:
            if name.lower() == want:
                return name, schema
    for name, schema in tools:
        if any(w in name.lower() for w in ("bash", "shell", "command")):
            return name, schema
    # CodeBuddy 2.168 的 ptc 模式只给一个 REPL 工具，命令要写成 JS：await Bash({ command })
    for name, schema in tools:
        if name == "REPL" and "code" in ((schema or {}).get("properties") or {}):
            return name, schema
    return None


def shell_args(schema, escalate=False):
    props = (schema or {}).get("properties") or {}
    args = {}
    for key, spec in props.items():
        kind = spec.get("type") if isinstance(spec, dict) else None
        if key == "code":
            args[key] = f'return await Bash({{ command: {json.dumps(PROBE)}, description: "写一个探针文件" }})'
        elif key in ("command", "cmd", "script"):
            args[key] = ["bash", "-lc", PROBE] if kind == "array" else PROBE
        elif key == "description":
            args[key] = "写一个探针文件"
    # TRIGGER_ESC：Codex 在沙箱里跑普通命令不问人，要申请出沙箱（require_escalated）才走审批
    if escalate and "sandbox_permissions" in props:
        args["sandbox_permissions"] = "require_escalated"
        args["justification"] = "写一个探针文件，可以吗？"
    for key in (schema or {}).get("required") or []:
        if key not in args:
            spec = props.get(key) or {}
            args[key] = {"array": [], "boolean": False, "integer": 0, "number": 0}.get(spec.get("type"), ".")
    return args


def tool_result_excerpt(raw):
    """工具结果原文的一截（看 CLI 到底跑没跑、报了什么）"""
    text = raw.decode("utf-8", "replace")
    for key in ('"function_call_output"', '"tool_result"', '"functionResponse"', '"role": "tool"', '"role":"tool"'):
        i = text.rfind(key)
        if i >= 0:
            return text[i:i + 400]
    return None


def has_tool_result(body, raw):
    return any(k in raw for k in (b'"tool_result"', b'"function_call_output"', b'"functionResponse"', b'"role": "tool"', b'"role":"tool"'))

def log(**kw):
    LOG.write(json.dumps(kw, ensure_ascii=False) + "\n")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def _sse_start(self):
        self.send_response(200); self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache"); self.send_header("connection", "close"); self.end_headers()
        self.close_connection = True
    def _ev(self, data, name=None):
        s = (f"event: {name}\n" if name else "") + f"data: {json.dumps(data) if not isinstance(data, str) else data}\n\n"
        self.wfile.write(s.encode()); self.wfile.flush()
    def do_GET(self):
        log(method="GET", path=self.path, model=None)
        if "models" in self.path:
            self._send(200, {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "e2e"} for m in MODELS],
                             "models": [{"name": f"models/{m}", "slug": m, "id": m} for m in MODELS]})
        else:
            self._send(200, {})
    def do_HEAD(self):
        self.send_response(200); self.send_header("content-length", "0"); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        try: body = json.loads(raw or b"{}")
        except Exception: body = {}
        model = body.get("model")
        if model is None and "/models/" in self.path:  # gemini: /v1beta/models/<m>:generateContent
            model = self.path.split("/models/")[1].split(":")[0]
        sysp = body.get("system")
        if isinstance(sysp, list): sysp = " ".join(x.get("text", "") for x in sysp if isinstance(x, dict))
        msgs = json.dumps(body.get("messages", []), ensure_ascii=False)
        # 与「别家模型能不能用」相关的请求参数：思考 / 档位 / 输出上限 / 采样 / Responses 专有字段
        params = {k: body[k] for k in ("thinking", "output_config", "reasoning", "reasoning_effort", "max_tokens",
                                       "max_completion_tokens", "max_output_tokens", "temperature", "top_p", "text",
                                       "include", "store", "service_tier", "parallel_tool_calls", "tool_choice",
                                       "enable_thinking", "thinking_budget", "extra_body", "stream_options") if k in body}
        gen = body.get("generationConfig")
        if isinstance(gen, dict):
            params["generationConfig"] = {k: gen[k] for k in gen if k in ("thinkingConfig", "maxOutputTokens", "temperature")}
        tools = tool_list(body)
        mode = None
        # 后一幕的触发词在前：第二幕的请求历史里还带着第一幕的 TRIGGER_SLOW
        if tools and b"TRIGGER_TOOL" in raw:
            mode = "done" if has_tool_result(body, raw) else ("tool" if pick_shell(tools) else "notool")
        elif tools and b"TRIGGER_LONG" in raw:
            mode = "long"
        elif tools and b"TRIGGER_SLOW" in raw:
            mode = "slow"
        log(method="POST", path=self.path.split("?")[0], model=model, stream=bool(body.get("stream")), params=params,
            tools=len(tools), mode=mode, shell=(pick_shell(tools) or ("",))[0] if mode == "tool" else None,
            toolnames=[n for n, _ in tools][:40] if mode else None,
            result=tool_result_excerpt(raw) if mode == "done" else None,
            schema=json.dumps(dict(tools).get((pick_shell(tools) or ("",))[0]), ensure_ascii=False)[:600] if mode == "tool" else
                   (json.dumps(tools, ensure_ascii=False)[:1500] if mode == "notool" else None),
            hint=("SUBTASK" if "SUBTASK" in msgs else "") + " | " + (sysp or "")[:0] + msgs[-90:].replace("\n", " "))
        p = self.path
        text = "ok"
        lines = SLOW_LINES if mode == "slow" else LONG_LINES if mode == "long" else [("done" if mode == "done" else "ok")]
        shell = pick_shell(tools) if mode == "tool" else None
        call_args = json.dumps(shell_args(shell[1], b"TRIGGER_ESC" in raw), ensure_ascii=False) if shell else None
        delay = 0.6 if mode == "slow" else 0.25 if mode == "long" else 0
        if "count_tokens" in p:
            return self._send(200, {"input_tokens": 10})
        if p.split("?")[0].endswith("/messages"):
            if not body.get("stream"):
                return self._send(200, {"id": "m", "type": "message", "role": "assistant", "model": model, "content": [{"type": "text", "text": text}],
                                        "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 5, "output_tokens": 1}})
            self._sse_start()
            self._ev({"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 5, "output_tokens": 1}}}, "message_start")
            msgs = json.dumps(body.get("messages", []), ensure_ascii=False)
            tools = [t.get("name") for t in body.get("tools", []) if isinstance(t, dict)]
            if "TRIGGER_SUBAGENT" in msgs and "tool_result" not in msgs and ("Agent" in tools or "Task" in tools):
                name = "Agent" if "Agent" in tools else "Task"
                log(note="emit-subagent", tool=name)
                self._ev({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_e2e", "name": name, "input": {}}}, "content_block_start")
                self._ev({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps({"description": "e2e", "prompt": "SUBTASK say ok", "subagent_type": "general-purpose"})}}, "content_block_delta")
                self._ev({"type": "content_block_stop", "index": 0}, "content_block_stop")
                self._ev({"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}, "message_delta")
                self._ev({"type": "message_stop"}, "message_stop")
                return
            if shell:
                self._ev({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_probe", "name": shell[0], "input": {}}}, "content_block_start")
                self._ev({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": call_args}}, "content_block_delta")
                self._ev({"type": "content_block_stop", "index": 0}, "content_block_stop")
                self._ev({"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}, "message_delta")
                self._ev({"type": "message_stop"}, "message_stop")
                return
            self._ev({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}, "content_block_start")
            for i, ln in enumerate(lines):
                self._ev({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": ln + ("\n" if i < len(lines) - 1 else "")}}, "content_block_delta")
                time.sleep(delay)
            self._ev({"type": "content_block_stop", "index": 0}, "content_block_stop")
            self._ev({"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}, "message_delta")
            self._ev({"type": "message_stop"}, "message_stop")
            return
        if p.split("?")[0].endswith("/chat/completions"):
            if not body.get("stream"):
                return self._send(200, {"id": "c", "object": "chat.completion", "created": int(time.time()), "model": model,
                                        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                        "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}})
            self._sse_start()
            base = {"id": "c", "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
            if shell:
                call = {"index": 0, "id": "call_probe", "type": "function", "function": {"name": shell[0], "arguments": call_args}}
                self._ev({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": None, "tool_calls": [call]}, "finish_reason": None}]})
                self._ev({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}})
                self._ev("[DONE]")
                return
            for i, ln in enumerate(lines):
                delta = {"content": ln + ("\n" if i < len(lines) - 1 else "")}
                if i == 0: delta["role"] = "assistant"
                self._ev({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
                time.sleep(delay)
            self._ev({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}})
            self._ev("[DONE]")
            return
        if p.split("?")[0].endswith("/responses"):
            self._sse_start()
            rid = "resp_e2e"
            resp = {"id": rid, "object": "response", "created_at": int(time.time()), "status": "in_progress", "model": model, "output": []}
            self._ev({"type": "response.created", "response": resp}, "response.created")
            if shell:
                item = {"id": "fc_1", "type": "function_call", "status": "completed", "call_id": "call_probe", "name": shell[0], "arguments": call_args}
                self._ev({"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "arguments": ""}}, "response.output_item.added")
                self._ev({"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 0, "delta": call_args}, "response.function_call_arguments.delta")
                self._ev({"type": "response.function_call_arguments.done", "item_id": "fc_1", "output_index": 0, "arguments": call_args}, "response.function_call_arguments.done")
                self._ev({"type": "response.output_item.done", "output_index": 0, "item": item}, "response.output_item.done")
            else:
                full = "\n".join(lines)
                item = {"id": "msg_1", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": full, "annotations": []}]}
                self._ev({"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}}, "response.output_item.added")
                for i, ln in enumerate(lines):
                    self._ev({"type": "response.output_text.delta", "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": ln + ("\n" if i < len(lines) - 1 else "")}, "response.output_text.delta")
                    time.sleep(delay)
                self._ev({"type": "response.output_text.done", "item_id": "msg_1", "output_index": 0, "content_index": 0, "text": full}, "response.output_text.done")
                self._ev({"type": "response.output_item.done", "output_index": 0, "item": item}, "response.output_item.done")
            self._ev({"type": "response.completed", "response": {**resp, "status": "completed", "output": [item],
                      "usage": {"input_tokens": 5, "output_tokens": 1, "total_tokens": 6, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}}, "response.completed")
            return
        if ":streamGenerateContent" in p or ":generateContent" in p:
            usage = {"promptTokenCount": 5, "candidatesTokenCount": 1, "totalTokenCount": 6}
            if shell:
                parts = [{"functionCall": {"name": shell[0], "args": json.loads(call_args)}}]
                chunk = {"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP", "index": 0}], "usageMetadata": usage}
                if "stream" in p:
                    self._sse_start(); self._ev(chunk); return
                return self._send(200, chunk)
            if "stream" in p:
                self._sse_start()
                for i, ln in enumerate(lines):
                    last = i == len(lines) - 1
                    c = {"candidates": [{"content": {"role": "model", "parts": [{"text": ln + ("" if last else "\n")}]}, "index": 0, **({"finishReason": "STOP"} if last else {})}]}
                    if last: c["usageMetadata"] = usage
                    self._ev(c); time.sleep(delay)
                return
            chunk = {"candidates": [{"content": {"role": "model", "parts": [{"text": "\n".join(lines)}]}, "finishReason": "STOP", "index": 0}], "usageMetadata": usage}
            return self._send(200, chunk)
        self._send(404, {"error": {"message": f"e2e gateway: unknown path {p}"}})

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
