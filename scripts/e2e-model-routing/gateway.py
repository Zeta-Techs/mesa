"""假网关：记录每个请求打到哪个路径、带的什么模型；按协议回一个最小可用的回复（让 CLI 至少能走完一轮）。"""
import json, os, socketserver, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open(sys.argv[2], "a", buffering=1)
# E2E_DUMP=<文件>：每个 POST 的完整请求体与少数请求头另记一行（CLI 金丝雀拿它比工具清单、系统提示词结构、请求参数）
DUMP = open(os.environ["E2E_DUMP"], "a", buffering=1, encoding="utf-8") if os.environ.get("E2E_DUMP") else None
DUMP_HEADERS = ("anthropic-beta", "anthropic-version", "user-agent", "openai-beta", "x-app", "originator", "version")
MODELS = ["e2e-default", "e2e-picked"]

# 聊天层第三期抓屏用的两个触发词（只认带工具列表的主对话请求，标题 / 摘要这类后台请求照常回 ok）：
# TRIGGER_SLOW = 慢慢流出一段多行回复（看实时预览能不能从屏上读）；TRIGGER_TOOL = 先回一个「跑命令」工具调用、
# 拿到结果后再回 done（看各家权限档是先问还是直接放行）
SLOW_LINES = ["第一段：这是一段慢慢流出来的回复。", "", "- 要点一：终端先画出来", "- 要点二：会话文件后落盘",
              "", "```bash", "echo mesa", "```", "", "最后一行：完毕。"]
# TRIGGER_LONG = 比一屏还长的回复（看回复开头滚出屏后预览还接不接得上，2026-10-19 用户：Codex 第 22 行卡住）
LONG_LINES = [f"第 {i} 行：长回复逐行流出。" for i in range(1, 61)]
# E2E_LONG_FILE=<Markdown 文件>：TRIGGER_LONG 改为逐行流出这份文件（真回复的样子：标题、代码块、表格，2026-10-22 预览重复）
if os.environ.get("E2E_LONG_FILE"):
    LONG_LINES = open(os.environ["E2E_LONG_FILE"], encoding="utf-8").read().rstrip("\n").split("\n")
LONG_DELAY = float(os.environ.get("E2E_LONG_DELAY", "0.25"))
# E2E_LONG_CHUNK=<字数>：长回复按这么多字一块流出（真模型是逐词出的：半行、没闭合的 ** 和代码块都会先画一下）
LONG_CHUNK = int(os.environ.get("E2E_LONG_CHUNK", "0"))


def pieces(lines, chunk):
    """每次流出的一块：默认一行一块（行尾带换行，最后一行不带）；chunk>0 时整段按字数切"""
    if chunk <= 0:
        return [ln + ("\n" if i < len(lines) - 1 else "") for i, ln in enumerate(lines)]
    text = "\n".join(lines)
    return [text[i:i + chunk] for i in range(0, len(text), chunk)]
# TRIGGER_THINK 时先出的那段思考（Codex 推理摘要的样子：粗体小标题 + 一句）
THINK_TEXT = "**规划探针命令**\n\n先跑一条命令看看环境，再回答。"
# Claude 一轮结束后另发一次请求猜「你下一句想说什么」（系统提示带 SUGGESTION MODE），回这一句，它会灰着字放进输入框（2026-10-22）
SUGGESTION = os.environ.get("E2E_SUGGESTION", "再运行一次看看输出")
# TRIGGER_ASK = 回一个 AskUserQuestion 工具调用（Claude 的「问你一个问题」菜单，看聊天层提问卡片）；TRIGGER_ASK2 = 一次问两题；
# TRIGGER_ASKM = 只问一道多选题（多选交了也要过一遍确认页）
ASK_COLOR = {"question": "红、绿、蓝三种颜色里，你更喜欢哪一种？", "header": "颜色", "multiSelect": False,
             "options": [{"label": "红", "description": "选择红色"}, {"label": "绿", "description": "选择绿色"},
                         {"label": "蓝", "description": "选择蓝色"}]}
ASK_FRUIT = {"question": "下面这些水果你平时会吃哪些？", "header": "水果", "multiSelect": True,
             "options": [{"label": "苹果", "description": "脆甜，一年四季都有"}, {"label": "香蕉", "description": "软糯，适合当早餐"},
                         {"label": "葡萄", "description": "一串一串，夏天最多"}]}
# TRIGGER_PLAN = 照真模型在 Claude 计划模式里的走法：先用 Write 把方案写进系统提示指定的方案文件，再调 ExitPlanMode
# （2.1.308 起方案不在参数里，屏上那份是读方案文件来的；没写文件只会问「Exit plan mode?」），看「要不要开工」那一屏
# （2026-10-26）；拿到 ExitPlanMode 的结果（开工 / 接着改方案）后回 done
PLAN_TEXT = os.environ.get("E2E_PLAN_TEXT", "# 方案：写一个探针文件\n\n1. 在工作目录新建 mesa_probe.txt\n2. 写入一行 mesa\n3. 读回确认")
# E2E_PROBE_CMD 换探针命令（如写绝对路径，看沙箱里的工作目录对不对）
PROBE = os.environ.get("E2E_PROBE_CMD", "echo mesa > mesa_probe.txt")
# E2E_DONE_TEXT 换工具跑完后的那句回复（如带图片路径，看聊天层出不出图）
DONE = os.environ.get("E2E_DONE_TEXT", "done")
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
        if DUMP:
            DUMP.write(json.dumps({"t": time.time(), "path": self.path.split("?")[0],
                                   "headers": {h: self.headers.get(h) for h in DUMP_HEADERS if self.headers.get(h)},
                                   "body": body}, ensure_ascii=False) + "\n")
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
        # 猜下一句的请求带着整段对话历史（里面有触发词），要先认
        if b"SUGGESTION MODE" in raw:
            mode = "suggest"
        # 后一幕的触发词在前：第二幕的请求历史里还带着第一幕的 TRIGGER_SLOW
        elif tools and b"TRIGGER_PLAN" in raw:
            mode = ("done" if b"toolu_plan_exit" in raw and has_tool_result(body, raw)
                    else "plan" if "ExitPlanMode" in dict(tools) else "notool")
        elif tools and b"TRIGGER_ASK" in raw:
            mode = "done" if has_tool_result(body, raw) else ("ask" if "AskUserQuestion" in dict(tools) else "notool")
        elif tools and b"TRIGGER_TOOL" in raw:
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
        lines = (SLOW_LINES if mode == "slow" else LONG_LINES if mode == "long" else [SUGGESTION] if mode == "suggest"
                 else [(DONE if mode == "done" else "ok")])
        if mode == "suggest":
            text = SUGGESTION
        shell = pick_shell(tools) if mode == "tool" else None
        call_args = json.dumps(shell_args(shell[1], b"TRIGGER_ESC" in raw), ensure_ascii=False) if shell else None
        delay = 0.6 if mode == "slow" else LONG_DELAY if mode == "long" else 0
        parts = pieces(lines, LONG_CHUNK if mode == "long" else 0)
        # TRIGGER_THINK：回答 / 调工具前先出一段思考（Responses 推理摘要、Anthropic thinking 块、Chat 的 reasoning_content），
        # 核对聊天层「现在在想什么」那条线；工具结果回来之后的那次请求不再想
        think = THINK_TEXT if b"TRIGGER_THINK" in raw and mode != "done" else None
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
            if mode == "plan":
                import re as _re
                plan_file = _re.search(r"create your plan at (\S+?\.md)", sysp or "") or _re.search(r"create your plan at (\S+?\.md)", raw.decode("utf-8", "replace"))
                write_first = plan_file and b"toolu_plan_write" not in raw
                name, tid, args = (("Write", "toolu_plan_write", {"file_path": plan_file.group(1), "content": PLAN_TEXT}) if write_first
                                   else ("ExitPlanMode", "toolu_plan_exit", {}))
                log(note="emit-plan", tool=name, plan_file=plan_file.group(1) if plan_file else None)
                self._ev({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": tid, "name": name, "input": {}}}, "content_block_start")
                self._ev({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(args, ensure_ascii=False)}}, "content_block_delta")
                self._ev({"type": "content_block_stop", "index": 0}, "content_block_stop")
                self._ev({"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}, "message_delta")
                self._ev({"type": "message_stop"}, "message_stop")
                return
            if mode == "ask":
                ask = {"questions": [ASK_COLOR, ASK_FRUIT] if b"TRIGGER_ASK2" in raw else [ASK_FRUIT] if b"TRIGGER_ASKM" in raw else [ASK_COLOR]}
                log(note="emit-ask", schema=json.dumps(dict(tool_list(body)).get("AskUserQuestion"), ensure_ascii=False)[:1500])
                self._ev({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_ask", "name": "AskUserQuestion", "input": {}}}, "content_block_start")
                self._ev({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(ask, ensure_ascii=False)}}, "content_block_delta")
                self._ev({"type": "content_block_stop", "index": 0}, "content_block_stop")
                self._ev({"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}, "message_delta")
                self._ev({"type": "message_stop"}, "message_stop")
                return
            bi = 0
            if think:
                self._ev({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}, "content_block_start")
                self._ev({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": think}}, "content_block_delta")
                self._ev({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "e2e"}}, "content_block_delta")
                self._ev({"type": "content_block_stop", "index": 0}, "content_block_stop")
                time.sleep(1.0)
                bi = 1
            if shell:
                self._ev({"type": "content_block_start", "index": bi, "content_block": {"type": "tool_use", "id": "toolu_probe", "name": shell[0], "input": {}}}, "content_block_start")
                self._ev({"type": "content_block_delta", "index": bi, "delta": {"type": "input_json_delta", "partial_json": call_args}}, "content_block_delta")
                self._ev({"type": "content_block_stop", "index": bi}, "content_block_stop")
                self._ev({"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}, "message_delta")
                self._ev({"type": "message_stop"}, "message_stop")
                return
            self._ev({"type": "content_block_start", "index": bi, "content_block": {"type": "text", "text": ""}}, "content_block_start")
            for part in parts:
                self._ev({"type": "content_block_delta", "index": bi, "delta": {"type": "text_delta", "text": part}}, "content_block_delta")
                time.sleep(delay)
            self._ev({"type": "content_block_stop", "index": bi}, "content_block_stop")
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
            if think:
                self._ev({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "reasoning_content": think}, "finish_reason": None}]})
                time.sleep(1.0)
            if shell:
                call = {"index": 0, "id": "call_probe", "type": "function", "function": {"name": shell[0], "arguments": call_args}}
                self._ev({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": None, "tool_calls": [call]}, "finish_reason": None}]})
                self._ev({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}})
                self._ev("[DONE]")
                return
            for i, part in enumerate(parts):
                delta = {"content": part}
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
            out, oi = [], 0
            if think:
                rs = {"id": "rs_1", "type": "reasoning", "summary": [{"type": "summary_text", "text": think}]}
                self._ev({"type": "response.output_item.added", "output_index": 0, "item": {**rs, "summary": []}}, "response.output_item.added")
                self._ev({"type": "response.reasoning_summary_part.added", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "part": {"type": "summary_text", "text": ""}}, "response.reasoning_summary_part.added")
                self._ev({"type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "delta": think}, "response.reasoning_summary_text.delta")
                self._ev({"type": "response.reasoning_summary_text.done", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "text": think}, "response.reasoning_summary_text.done")
                self._ev({"type": "response.reasoning_summary_part.done", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "part": {"type": "summary_text", "text": think}}, "response.reasoning_summary_part.done")
                self._ev({"type": "response.output_item.done", "output_index": 0, "item": rs}, "response.output_item.done")
                time.sleep(1.0)
                out.append(rs); oi = 1
            if shell:
                item = {"id": "fc_1", "type": "function_call", "status": "completed", "call_id": "call_probe", "name": shell[0], "arguments": call_args}
                self._ev({"type": "response.output_item.added", "output_index": oi, "item": {**item, "status": "in_progress", "arguments": ""}}, "response.output_item.added")
                self._ev({"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": oi, "delta": call_args}, "response.function_call_arguments.delta")
                self._ev({"type": "response.function_call_arguments.done", "item_id": "fc_1", "output_index": oi, "arguments": call_args}, "response.function_call_arguments.done")
                self._ev({"type": "response.output_item.done", "output_index": oi, "item": item}, "response.output_item.done")
            else:
                full = "\n".join(lines)
                item = {"id": "msg_1", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": full, "annotations": []}]}
                self._ev({"type": "response.output_item.added", "output_index": oi, "item": {**item, "status": "in_progress", "content": []}}, "response.output_item.added")
                for part in parts:
                    self._ev({"type": "response.output_text.delta", "item_id": "msg_1", "output_index": oi, "content_index": 0, "delta": part}, "response.output_text.delta")
                    time.sleep(delay)
                self._ev({"type": "response.output_text.done", "item_id": "msg_1", "output_index": oi, "content_index": 0, "text": full}, "response.output_text.done")
                self._ev({"type": "response.output_item.done", "output_index": oi, "item": item}, "response.output_item.done")
            out.append(item)
            self._ev({"type": "response.completed", "response": {**resp, "status": "completed", "output": out,
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
                for i, part in enumerate(parts):
                    last = i == len(parts) - 1
                    c = {"candidates": [{"content": {"role": "model", "parts": [{"text": part}]}, "index": 0, **({"finishReason": "STOP"} if last else {})}]}
                    if last: c["usageMetadata"] = usage
                    self._ev(c); time.sleep(delay)
                return
            chunk = {"candidates": [{"content": {"role": "model", "parts": [{"text": "\n".join(lines)}]}, "finishReason": "STOP", "index": 0}], "usageMetadata": usage}
            return self._send(200, chunk)
        self._send(404, {"error": {"message": f"e2e gateway: unknown path {p}"}})

class Server(ThreadingHTTPServer):
    # HTTPServer.server_bind 在 listen 之前做 getfqdn 反查，GitHub 的 macOS runner 上会卡住好几秒，金丝雀等不到端口就判「没起来」
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


Server(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
