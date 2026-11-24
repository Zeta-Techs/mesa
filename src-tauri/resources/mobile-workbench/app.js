(() => {
  "use strict";

  const appEl = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  const state = {
    authed: false,
    csrfToken: "",
    deviceName: "",
    projects: [],
    currentProject: "",
    tab: "overview", // overview | assistant | files
    overview: null,
    history: [],
    filesMode: "closeout", // closeout | all | diff
    files: [],
    fileQuery: "",
    diffText: "",
    streaming: false,
    streamId: "",
    streamStep: "",
    streamText: "",
    pendingQuestion: "",
    sseOnline: false,
    es: null,
    sheet: null, // { type: "drop" | "step" | "file", ... }
  };

  let toastTimer = null;
  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2800);
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function relTime(iso) {
    if (!iso) return "";
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const min = Math.floor(ms / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const d = Math.floor(hr / 24);
    return `${d} 天前`;
  }

  function renderMarkdown(raw) {
    const src = String(raw ?? "").replace(/\r\n/g, "\n").trim();
    if (!src) return "";
    const codeBlocks = [];
    const withPlaceholders = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, _lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000CB${idx}\u0000`;
    });

    const inlineFmt = (line) => {
      let s = esc(line);
      s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
      return s;
    };

    const lines = withPlaceholders.split("\n");
    const out = [];
    let inUl = false;
    let inOl = false;
    const closeLists = () => {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
    };

    for (const line of lines) {
      const cb = line.match(/^\u0000CB(\d+)\u0000$/);
      if (cb) {
        closeLists();
        out.push(codeBlocks[Number(cb[1])]);
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        closeLists();
        continue;
      }
      const h = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (h) {
        closeLists();
        const lv = h[1].length;
        out.push(`<h${lv}>${inlineFmt(h[2])}</h${lv}>`);
        continue;
      }
      const bq = trimmed.match(/^>\s?(.*)$/);
      if (bq) {
        closeLists();
        out.push(`<blockquote>${inlineFmt(bq[1])}</blockquote>`);
        continue;
      }
      const ul = trimmed.match(/^[-*•]\s+(.+)$/);
      if (ul) {
        if (inOl) { out.push("</ol>"); inOl = false; }
        if (!inUl) { out.push("<ul>"); inUl = true; }
        out.push(`<li>${inlineFmt(ul[1])}</li>`);
        continue;
      }
      const ol = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (ol) {
        if (inUl) { out.push("</ul>"); inUl = false; }
        if (!inOl) { out.push("<ol>"); inOl = true; }
        out.push(`<li>${inlineFmt(ol[1])}</li>`);
        continue;
      }
      closeLists();
      out.push(`<p>${inlineFmt(trimmed)}</p>`);
    }
    closeLists();
    return out.join("");
  }

  async function apiGet(path) {
    const res = await fetch(path, { credentials: "same-origin" });
    if (res.status === 401) {
      state.authed = false;
      render();
      throw new Error("需要重新扫码配对");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Mesa-CSRF": state.csrfToken,
      },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 401) {
      state.authed = false;
      render();
      throw new Error("需要重新扫码配对");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `操作失败 (${res.status})`);
    return data;
  }

  function guessDeviceName() {
    const ua = navigator.userAgent || "";
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    if (/Android/i.test(ua)) return "Android 手机";
    if (/Macintosh/i.test(ua)) return "Mac 浏览器";
    return "移动设备";
  }

  async function handlePairPage(token) {
    appEl.innerHTML = `
      <div class="auth-card-wrap">
        <div class="auth-card">
          <div class="auth-brand">
            <img src="/icon.svg" alt="Mesa">
            <h1 class="auth-title">配对 Mesa 手机工作台</h1>
          </div>
          <p class="auth-desc">点击确认后将把这台设备加入电脑端 Mesa 的信任名单（最多 8 台，可随时在电脑上移除）。</p>
          <input id="pair-name" class="input" maxlength="40" value="${esc(guessDeviceName())}" placeholder="给这台设备起个名字">
          <div class="btn-row">
            <button id="pair-go" class="btn primary flex-1">信任此设备并进入</button>
          </div>
          <p id="pair-err" class="auth-desc err-note"></p>
        </div>
      </div>`;
    const btn = document.getElementById("pair-go");
    const errEl = document.getElementById("pair-err");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      errEl.textContent = "";
      try {
        const name = (document.getElementById("pair-name").value || "").trim() || guessDeviceName();
        const res = await fetch("/api/pair", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, deviceName: name }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "配对码已过期或无效，请在电脑端重新生成二维码");
        state.authed = true;
        state.csrfToken = data.csrfToken || "";
        state.deviceName = data.deviceName || name;
        history.replaceState(null, "", "/");
        await bootAuthed();
      } catch (e) {
        errEl.textContent = String(e.message || e);
        btn.disabled = false;
      }
    });
  }

  function renderUnauthed() {
    appEl.innerHTML = `
      <div class="auth-card-wrap">
        <div class="auth-card">
          <div class="auth-brand">
            <img src="/icon.svg" alt="Mesa">
            <h1 class="auth-title">Mesa 手机工作台</h1>
          </div>
          <p class="auth-desc">这台设备尚未配对，或已被电脑端移除。请在电脑上打开 Mesa → <strong>设置 → AI 与 Agent → 手机工作台</strong>，点击「配对新手机」扫码进入。</p>
        </div>
      </div>`;
  }

  async function loadOverview() {
    if (!state.currentProject) return;
    try {
      state.overview = await apiGet(`/api/project/overview?project=${encodeURIComponent(state.currentProject)}`);
      render();
    } catch (e) {
      showToast(String(e.message || e));
    }
  }

  async function loadHistory() {
    if (!state.currentProject) return;
    try {
      const data = await apiGet(`/api/assistant/history?project=${encodeURIComponent(state.currentProject)}`);
      state.history = data.turns || [];
      render();
      scrollChatBottom();
    } catch (e) {
      showToast(String(e.message || e));
    }
  }

  async function loadFiles() {
    if (!state.currentProject) return;
    try {
      if (state.filesMode === "diff") {
        const data = await apiGet(`/api/files/diff?project=${encodeURIComponent(state.currentProject)}`);
        state.diffText = data.diff || "";
      } else {
        const q = state.fileQuery.trim();
        const url = `/api/files/list?project=${encodeURIComponent(state.currentProject)}${q ? `&query=${encodeURIComponent(q)}` : ""}`;
        const data = await apiGet(url);
        state.files = data.entries || [];
      }
      render();
    } catch (e) {
      showToast(String(e.message || e));
    }
  }

  function connectEvents() {
    if (state.es) {
      state.es.close();
      state.es = null;
    }
    if (!state.authed || !state.currentProject) return;
    const es = new EventSource(`/api/events?project=${encodeURIComponent(state.currentProject)}`);
    state.es = es;
    es.onopen = () => {
      state.sseOnline = true;
      const dot = document.querySelector(".live-dot");
      if (dot) dot.classList.add("online");
    };
    es.onerror = () => {
      state.sseOnline = false;
      const dot = document.querySelector(".live-dot");
      if (dot) dot.classList.remove("online");
    };
    es.addEventListener("overview", (ev) => {
      try {
        state.overview = JSON.parse(ev.data);
        if (state.tab === "overview") render();
        else updateTabBadges();
      } catch {}
    });
  }

  function updateTabBadges() {
    const count = state.overview?.helpItems?.length || 0;
    const badge = document.querySelector("[data-help-badge]");
    if (badge) {
      badge.textContent = String(count);
      badge.classList.toggle("hidden", count === 0);
    }
  }

  function scrollChatBottom() {
    requestAnimationFrame(() => {
      const el = document.querySelector(".chat-list");
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async function selectProject(path) {
    state.currentProject = path;
    try { localStorage.setItem("mesa.mw.project", path); } catch {}
    state.overview = null;
    state.history = [];
    state.files = [];
    state.diffText = "";
    render();
    connectEvents();
    await Promise.all([loadOverview(), loadHistory()]);
    if (state.tab === "files") await loadFiles();
  }

  async function sendChat(question) {
    const q = question.trim();
    if (!q || state.streaming || !state.currentProject) return;
    const sid = (crypto.randomUUID ? crypto.randomUUID() : `mw-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    state.streaming = true;
    state.streamId = sid;
    state.pendingQuestion = q;
    state.streamStep = "正在查看项目…";
    state.streamText = "";
    render();
    scrollChatBottom();

    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Mesa-CSRF": state.csrfToken,
        },
        body: JSON.stringify({
          projectRoot: state.currentProject,
          question: q,
          streamId: sid,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `发送失败 (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let evName = "message";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          evName = "message";
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) evName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          const payloadStr = dataLines.join("\n");
          if (!payloadStr) continue;
          let payload = null;
          try { payload = JSON.parse(payloadStr); } catch { continue; }
          if (evName === "step" && payload.step) {
            state.streamStep = payload.step;
            updateStreamDom();
          } else if (evName === "text" && payload.text !== undefined) {
            state.streamText = payload.text;
            updateStreamDom();
          } else if (evName === "done" && payload.turn) {
            state.history = [...state.history, payload.turn];
          } else if (evName === "error") {
            showToast(payload.error || "提问失败");
          }
        }
      }
    } catch (e) {
      showToast(String(e.message || e));
    } finally {
      state.streaming = false;
      state.streamId = "";
      state.pendingQuestion = "";
      state.streamStep = "";
      state.streamText = "";
      render();
      scrollChatBottom();
    }
  }

  function updateStreamDom() {
    const stepEl = document.getElementById("stream-step-label");
    if (stepEl) stepEl.textContent = state.streamStep || "正在思考…";
    const textEl = document.getElementById("stream-md");
    if (textEl) {
      textEl.innerHTML = renderMarkdown(state.streamText);
      scrollChatBottom();
    }
  }

  async function openStepSheet(n) {
    state.sheet = { type: "step", n, loading: true, data: null };
    render();
    try {
      const data = await apiGet(`/api/project/step?project=${encodeURIComponent(state.currentProject)}&step=${n}`);
      state.sheet = { type: "step", n, loading: false, data };
      render();
    } catch (e) {
      state.sheet = null;
      render();
      showToast(String(e.message || e));
    }
  }

  async function openFileSheet(relPath) {
    const ext = (relPath.split(".").pop() || "").toLowerCase();
    const isImg = ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext);
    const isPdf = ext === "pdf";
    const rawUrl = `/api/files/raw?project=${encodeURIComponent(state.currentProject)}&path=${encodeURIComponent(relPath)}`;
    if (isImg || isPdf) {
      state.sheet = { type: "file", path: relPath, kind: isPdf ? "pdf" : "image", rawUrl, loading: false };
      render();
      return;
    }
    state.sheet = { type: "file", path: relPath, kind: "text", loading: true, text: "", truncated: false };
    render();
    try {
      const data = await apiGet(`/api/files/read?project=${encodeURIComponent(state.currentProject)}&path=${encodeURIComponent(relPath)}`);
      state.sheet = {
        type: "file",
        path: relPath,
        kind: ext === "md" || ext === "qmd" ? "markdown" : "text",
        loading: false,
        text: data.text || "",
        truncated: !!data.truncated,
      };
      render();
    } catch (e) {
      state.sheet = null;
      render();
      showToast(String(e.message || e));
    }
  }

  function renderOverviewTab() {
    const ov = state.overview;
    if (!ov) return `<div class="empty-note">正在读取项目状态…</div>`;
    const helpItems = ov.helpItems || [];
    const steps = ov.steps || [];
    const goals = ov.goals || [];
    const closeout = ov.closeout || null;
    const savedCount = steps.filter((s) => s.saved).length;

    let html = "";
    html += `<div class="summary-banner">
      <div>
        <div class="summary-title">${esc(ov.projectName || "项目")}</div>
        <div class="summary-sub">${esc(ov.progressSummary || (steps.length ? `${savedCount}/${steps.length} 步已保存` : "自由目标模式"))}</div>
      </div>
      <span class="pill ${steps.length && savedCount === steps.length ? "ok" : "warn"}">${
        steps.length ? `${savedCount}/${steps.length}` : `${goals.length} 目标`
      }</span>
    </div>`;

    if (helpItems.length > 0) {
      html += `<div class="section-label"><span>等你的事 · ${helpItems.length}</span></div>`;
      for (const h of helpItems) {
        html += `<div class="card card-warn" data-help-card="${esc(h.itemId)}" data-help-root="${esc(h.root)}">
          <div class="help-where">${esc(h.whereLabel || "人工请求")}</div>
          <p class="help-q">${esc(h.question)}</p>
          ${h.options && h.options.length ? `<div class="btn-row">${h.options
            .map((o) => `<button class="btn" data-help-opt="${esc(o.key)}" data-help-label="${esc(o.label)}">${esc(o.key)} · ${esc(o.label)}</button>`)
            .join("")}</div>` : ""}
          <div class="btn-row mt-10">
            <input class="input flex-1" data-help-input placeholder="或者直接写一句回复…">
            <button class="btn primary" data-help-send>回复</button>
          </div>
          <label class="check-row"><input type="checkbox" data-help-rem> 以后同类照此办（记进项目知识）</label>
        </div>`;
      }
    }

    if (steps.length > 0) {
      html += `<div class="section-label"><span>流程步骤</span><span>点开看核验与详情</span></div>`;
      html += `<div class="list-card">`;
      for (const s of steps) {
        const cls = s.saved ? "saved" : s.failure ? "failed" : "";
        const badge = s.failure
          ? `<span class="pill err">出错</span>`
          : s.checksBlocked > 0
            ? `<span class="pill err">拦下 ${s.checksBlocked}</span>`
            : s.checksNeedsHuman > 0
              ? `<span class="pill warn">待判 ${s.checksNeedsHuman}</span>`
              : s.saved
                ? `<span class="pill ok">已保存</span>`
                : `<span class="pill muted">${esc(s.briefState || "进行中")}</span>`;
        html += `<button class="step-row" data-open-step="${s.n}">
          <span class="step-num ${cls}">${s.n}</span>
          <div class="step-body">
            <div class="step-name">${esc(s.name)}</div>
            <div class="step-state">${esc(s.state)}</div>
          </div>
          ${badge}
        </button>`;
      }
      html += `</div>`;
    }

    if (closeout && ((closeout.finalFiles && closeout.finalFiles.length) || closeout.targetJournal)) {
      html += `<div class="section-label"><span>完结产物</span>${closeout.targetJournal ? `<span>${esc(closeout.targetJournal)}</span>` : ""}</div>`;
      html += `<div class="list-card">`;
      for (const line of closeout.finalFiles || []) {
        const m = line.match(/（([^）]+)）$/);
        const rel = m ? m[1] : line;
        html += `<button class="file-row" data-open-file="${esc(rel)}"><span class="file-path">${esc(line)}</span><span class="file-meta">查看</span></button>`;
      }
      html += `</div>`;
    }

    if (goals.length > 0) {
      html += `<div class="section-label"><span>流程外目标</span></div><div class="list-card">`;
      for (const g of goals) {
        const tone = g.status === "completed" ? "ok" : g.status === "failed" ? "err" : g.status === "pending_review" ? "warn" : "muted";
        html += `<div class="file-row"><div><div class="step-name">${esc(g.name)}</div></div><span class="pill ${tone}">${esc(g.statusLabel || g.status)}</span></div>`;
      }
      html += `</div>`;
    }

    return html;
  }

  function renderTurnCard(turn) {
    if (turn.echoOf) {
      return `<div class="a-block">
        <div class="a-head"><span class="a-mark"></span><span>派活进展 · ${esc(relTime(turn.at))}</span></div>
        <div class="md">${renderMarkdown(turn.answer)}</div>
      </div>`;
    }
    const cleanText = String(turn.answer || "")
      .replace(/:::\s*(派活|补料|记下|问)\s*\n[\s\S]*?\n\s*:::/g, "")
      .replace(/\[\[[^\]\n]{1,600}\]\]/g, "")
      .trim();
    const p = turn.proposals || {};
    let extra = "";
    if (p.workOrder) {
      const wo = p.workOrder;
      const doneNote = turn.dispatched ? `<span class="pill ok">已派：${esc(turn.dispatched.note || "已发出")}</span>` : `<button class="btn primary" data-dispatch-at="${esc(turn.at)}">派出去</button>`;
      extra += `<div class="proposal-card">
        <div class="proposal-title">派活单 · ${esc(wo.title)}</div>
        <div class="proposal-meta">${wo.target === "step" ? `交给第 ${wo.step} 步` : "另起新目标"}${wo.deliver ? ` · 交付：${esc(wo.deliver)}` : ""}</div>
        <div class="md">${renderMarkdown(wo.task)}</div>
        <div class="btn-row">${doneNote}</div>
      </div>`;
    }
    if (p.reworkOrder) {
      extra += `<div class="proposal-card">
        <div class="proposal-title">补料单 · 退回第 ${p.reworkOrder.toStep} 步</div>
        <div class="proposal-meta">补料单需回电脑端 Mesa 确认并核对下游跟进</div>
      </div>`;
    }
    if (Array.isArray(p.memories) && p.memories.length) {
      for (const m of p.memories) {
        extra += `<div class="proposal-card">
          <div class="proposal-title">以后照这样办</div>
          <div class="md">${renderMarkdown(m.text)}</div>
          <div class="btn-row"><button class="btn" data-remember-text="${esc(m.text)}">记进项目知识</button></div>
        </div>`;
      }
    }

    return `<div class="q-bubble">${esc(turn.question)}</div>
      <div class="a-block">
        <div class="a-head"><span class="a-mark"></span><span>项目助手 · ${esc(relTime(turn.at))}</span></div>
        <div class="md">${renderMarkdown(cleanText)}</div>
        ${extra}
      </div>`;
  }

  function renderAssistantTab() {
    const turns = state.history || [];
    let body = "";
    if (!turns.length && !state.streaming) {
      body = `<div class="empty-note">
        <div>和电脑端项目助手共用同一份记录与上下文。</div>
        <div class="quick-chips justify-center">
          <button class="chip" data-quick-ask="现在到哪了？">现在到哪了？</button>
          <button class="chip" data-quick-ask="哪里出问题了？">哪里出问题了？</button>
          <button class="chip" data-quick-ask="我下一步该做什么？">我下一步该做什么？</button>
        </div>
      </div>`;
    } else {
      body = turns.slice(-40).map(renderTurnCard).join("");
    }
    if (state.streaming) {
      body += `<div class="q-bubble">${esc(state.pendingQuestion)}</div>
        <div class="a-block">
          <div class="stream-status"><span class="pulse-dot"></span><span id="stream-step-label">${esc(state.streamStep || "正在思考…")}</span></div>
          <div id="stream-md" class="md">${renderMarkdown(state.streamText)}</div>
        </div>`;
    }
    return `<div class="chat-wrap">
      <div class="chat-list">${body}</div>
      <form id="chat-form" class="composer-bar">
        <textarea id="chat-input" class="composer-input" rows="1" placeholder="问项目进展、查文件或派活…"></textarea>
        ${state.streaming
          ? `<button type="button" id="chat-stop" class="btn">停止</button>`
          : `<button type="submit" class="btn primary">发送</button>`}
      </form>
    </div>`;
  }

  function renderFilesTab() {
    const seg = `<div class="seg-bar">
      <button class="seg-btn ${state.filesMode === "closeout" ? "active" : ""}" data-fmode="closeout">完结与重点</button>
      <button class="seg-btn ${state.filesMode === "all" ? "active" : ""}" data-fmode="all">全部文件</button>
      <button class="seg-btn ${state.filesMode === "diff" ? "active" : ""}" data-fmode="diff">最近改动</button>
    </div>`;

    if (state.filesMode === "diff") {
      if (!state.diffText.trim()) return `${seg}<div class="empty-note">当前主仓库暂无未提交改动，也无最近差异可预览。</div>`;
      const lines = state.diffText.split("\n").map((l) => {
        const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "";
        return `<div class="diff-line ${cls}">${esc(l)}</div>`;
      }).join("");
      return `${seg}<div class="diff-box">${lines}</div>`;
    }

    let listHtml = "";
    if (state.filesMode === "closeout") {
      const c = state.overview?.closeout;
      const items = [...(c?.finalFiles || []), ...(c?.checkFiles || [])];
      if (!items.length) {
        listHtml = `<div class="empty-note">暂无完结产物，点上方「全部文件」浏览项目目录。</div>`;
      } else {
        listHtml = `<div class="list-card">${items.map((line) => {
          const m = line.match(/（([^）]+)）$/);
          const rel = m ? m[1] : line;
          return `<button class="file-row" data-open-file="${esc(rel)}"><span class="file-path">${esc(line)}</span><span class="file-meta">打开</span></button>`;
        }).join("")}</div>`;
      }
      return seg + listHtml;
    }

    const searchBox = `<input id="file-search" class="input mb-10" value="${esc(state.fileQuery)}" placeholder="按文件名或路径筛选…">`;
    if (!state.files.length) {
      listHtml = `<div class="empty-note">没有匹配的文件</div>`;
    } else {
      listHtml = `<div class="list-card">${state.files.map((f) => `<button class="file-row" data-open-file="${esc(f.path)}">
        <span class="file-path">${esc(f.path)}</span>
        <span class="file-meta">${esc(formatBytes(f.size))}</span>
      </button>`).join("")}</div>`;
    }
    return seg + searchBox + listHtml;
  }

  function renderSheet() {
    const sh = state.sheet;
    if (!sh) return "";
    let title = "";
    let body = "";
    if (sh.type === "drop") {
      title = "传资料到电脑 Mesa";
      body = `
        <p class="auth-desc mb-12">拍照、选文件或写一段灵感，经加密通道直达电脑端「从手机添加」暂存区（任意网络可用）。</p>
        <div class="btn-row mt-0 mb-14">
          <label class="btn primary inline-flex-center">
            拍照上传
            <input id="drop-cam" type="file" accept="image/*" capture="environment" class="hidden">
          </label>
          <label class="btn inline-flex-center">
            选照片 / PDF / 文件
            <input id="drop-file" type="file" multiple class="hidden">
          </label>
        </div>
        <div id="drop-status" class="auth-desc min-h-18"></div>
        <div class="section-label mt-10"><span>或者发一段文字 / 灵感</span></div>
        <textarea id="drop-text" class="textarea" placeholder="记录实验现象、会议灵感或待查文献标题…"></textarea>
        <div class="btn-row">
          <button id="drop-text-send" class="btn primary flex-1">发送到电脑</button>
        </div>`;
    } else if (sh.type === "step") {
      title = `第 ${sh.n} 步详情`;
      if (sh.loading) {
        body = `<div class="empty-note">正在加载步骤详情…</div>`;
      } else {
        const d = sh.data;
        title = `第 ${d.n} 步 · ${d.name}`;
        body = `
          <div class="card">
            <div class="summary-title">${esc(d.state)}</div>
            ${d.brief ? `<div class="md mt-8">${renderMarkdown(d.brief)}</div>` : ""}
          </div>
          ${d.reviewNotes ? `<div class="card card-warn"><div class="proposal-title">评审退回意见</div><div class="md">${renderMarkdown(d.reviewNotes)}</div></div>` : ""}
          ${(d.checks && d.checks.length) ? `<div class="card"><div class="proposal-title">核验提醒 (${d.checks.length})</div><div class="md"><ul>${d.checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div></div>` : ""}
          ${(d.humanPending && d.humanPending.length) ? `<div class="card"><div class="proposal-title">待办人工事项</div><div class="md"><ul>${d.humanPending.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div></div>` : ""}
          ${(d.pendingNextActions && d.pendingNextActions.length) ? `<div class="card"><div class="proposal-title">后续建议</div><div class="md"><ul>${d.pendingNextActions.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div></div>` : ""}`;
      }
    } else if (sh.type === "file") {
      title = sh.path;
      if (sh.loading) {
        body = `<div class="empty-note">正在读取文件…</div>`;
      } else if (sh.kind === "image") {
        body = `<img class="img-preview" src="${esc(sh.rawUrl)}" alt="${esc(sh.path)}">`;
      } else if (sh.kind === "pdf") {
        body = `<div class="empty-note">
          <p>PDF 文件支持直接用手机浏览器原生预览。</p>
          <a class="btn primary inline-flex-center no-underline" href="${esc(sh.rawUrl)}" target="_blank" rel="noopener">打开 PDF 原文</a>
        </div>`;
      } else if (sh.kind === "markdown") {
        body = `${sh.truncated ? `<p class="auth-desc">文件较大，仅展示前 512 KB 预览（已脱敏）。</p>` : ""}<div class="md">${renderMarkdown(sh.text)}</div>`;
      } else {
        body = `${sh.truncated ? `<p class="auth-desc">文件较大，仅展示前 512 KB 预览（已脱敏）。</p>` : ""}<pre class="code-view">${esc(sh.text)}</pre>`;
      }
    }
    return `<div class="sheet-backdrop" data-close-sheet>
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-head">
          <div class="sheet-title">${esc(title)}</div>
          <button class="icon-btn ghost" data-close-sheet>关闭</button>
        </div>
        <div class="sheet-body">${body}</div>
      </div>
    </div>`;
  }

  function render() {
    if (!state.authed) {
      renderUnauthed();
      return;
    }
    const helpCount = state.overview?.helpItems?.length || 0;
    const projectOpts = state.projects.length
      ? state.projects.map((p) => `<option value="${esc(p.path)}" ${p.path === state.currentProject ? "selected" : ""}>${esc(p.name)}${p.helpCount ? ` (${p.helpCount} 待办)` : ""}</option>`).join("")
      : `<option value="">暂无项目</option>`;

    const content =
      state.tab === "overview"
        ? `<div class="main-scroll">${renderOverviewTab()}</div>`
        : state.tab === "assistant"
          ? renderAssistantTab()
          : `<div class="main-scroll">${renderFilesTab()}</div>`;

    appEl.innerHTML = `
      <header class="topbar">
        <div class="project-select-wrap">
          <span class="live-dot ${state.sseOnline ? "online" : ""}" title="${state.sseOnline ? "实时连接中" : "正在重连"}"></span>
          <select id="project-select" class="project-select" aria-label="切换项目">${projectOpts}</select>
        </div>
        <button class="icon-btn accent" data-open-drop>＋ 传资料</button>
      </header>
      ${content}
      <nav class="tabbar" aria-label="主导航">
        <button class="tab-btn ${state.tab === "overview" ? "active" : ""}" data-tab="overview">
          概览 <span class="badge ${helpCount ? "" : "hidden"}" data-help-badge>${helpCount}</span>
        </button>
        <button class="tab-btn ${state.tab === "assistant" ? "active" : ""}" data-tab="assistant">助手</button>
        <button class="tab-btn ${state.tab === "files" ? "active" : ""}" data-tab="files">文件</button>
      </nav>
      ${renderSheet()}`;

    bindEvents();
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const statusEl = document.getElementById("drop-status");
    let ok = 0;
    for (const f of files) {
      if (statusEl) statusEl.textContent = `正在上传 ${f.name} (${formatBytes(f.size)})…`;
      try {
        const res = await fetch("/api/drop/file", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "X-Mesa-CSRF": state.csrfToken,
            "X-Mesa-Name": encodeURIComponent(f.name || "photo.jpg"),
          },
          body: f,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `上传失败 (${res.status})`);
        ok += 1;
      } catch (e) {
        showToast(`${f.name} 没传上：${e.message || e}`);
      }
    }
    if (statusEl) statusEl.textContent = ok ? `已送达电脑暂存区 ${ok} 份文件` : "";
    if (ok) showToast(`已送达电脑 ${ok} 份文件`);
  }

  function bindEvents() {
    const sel = document.getElementById("project-select");
    if (sel) {
      sel.addEventListener("change", () => void selectProject(sel.value));
    }

    const chatForm = document.getElementById("chat-form");
    const chatInput = document.getElementById("chat-input");
    if (chatForm && chatInput) {
      chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const val = chatInput.value;
        chatInput.value = "";
        void sendChat(val);
      });
      chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          const val = chatInput.value;
          chatInput.value = "";
          void sendChat(val);
        }
      });
    }

    const stopBtn = document.getElementById("chat-stop");
    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        if (state.streamId) {
          void apiPost("/api/assistant/cancel", { streamId: state.streamId }).catch(() => {});
        }
      });
    }

    const fileSearch = document.getElementById("file-search");
    if (fileSearch) {
      let timer = null;
      fileSearch.addEventListener("input", () => {
        state.fileQuery = fileSearch.value;
        clearTimeout(timer);
        timer = setTimeout(() => void loadFiles(), 220);
      });
    }

    const dropCam = document.getElementById("drop-cam");
    const dropFile = document.getElementById("drop-file");
    if (dropCam) dropCam.addEventListener("change", () => void uploadFiles(dropCam.files));
    if (dropFile) dropFile.addEventListener("change", () => void uploadFiles(dropFile.files));

    const dropTextBtn = document.getElementById("drop-text-send");
    if (dropTextBtn) {
      dropTextBtn.addEventListener("click", async () => {
        const box = document.getElementById("drop-text");
        const text = (box?.value || "").trim();
        if (!text) return;
        dropTextBtn.disabled = true;
        try {
          await apiPost("/api/drop/text", { text });
          if (box) box.value = "";
          showToast("已送到电脑端暂存区");
        } catch (e) {
          showToast(String(e.message || e));
        } finally {
          dropTextBtn.disabled = false;
        }
      });
    }
  }

  appEl.addEventListener("click", async (e) => {
    const target = e.target.closest("button, [data-close-sheet]");
    if (!target) return;

    if (target.hasAttribute("data-close-sheet")) {
      if (target.classList.contains("sheet-backdrop") && e.target !== target) return;
      state.sheet = null;
      render();
      return;
    }

    if (target.hasAttribute("data-open-drop")) {
      state.sheet = { type: "drop" };
      render();
      return;
    }

    if (target.hasAttribute("data-tab")) {
      const next = target.getAttribute("data-tab");
      if (next && next !== state.tab) {
        state.tab = next;
        render();
        if (next === "files") await loadFiles();
        if (next === "assistant") scrollChatBottom();
      }
      return;
    }

    if (target.hasAttribute("data-fmode")) {
      state.filesMode = target.getAttribute("data-fmode");
      render();
      if (state.filesMode !== "closeout") await loadFiles();
      return;
    }

    if (target.hasAttribute("data-open-step")) {
      await openStepSheet(Number(target.getAttribute("data-open-step")));
      return;
    }

    if (target.hasAttribute("data-open-file")) {
      await openFileSheet(target.getAttribute("data-open-file"));
      return;
    }

    if (target.hasAttribute("data-quick-ask")) {
      await sendChat(target.getAttribute("data-quick-ask"));
      return;
    }

    if (target.hasAttribute("data-help-opt") || target.hasAttribute("data-help-send")) {
      const card = target.closest("[data-help-card]");
      if (!card) return;
      const itemId = card.getAttribute("data-help-card");
      const root = card.getAttribute("data-help-root");
      const remember = card.querySelector("[data-help-rem]")?.checked ? "已定" : null;
      let answer = "";
      if (target.hasAttribute("data-help-opt")) {
        const k = target.getAttribute("data-help-opt");
        const l = target.getAttribute("data-help-label");
        answer = l ? `${k}（${l}）` : k;
      } else {
        answer = (card.querySelector("[data-help-input]")?.value || "").trim();
      }
      if (!answer) {
        showToast("先选一个选项或写一句回复");
        return;
      }
      target.disabled = true;
      try {
        await apiPost("/api/help/answer", { root, itemId, answer, remember });
        showToast("已回复并通知电脑端");
        await loadOverview();
      } catch (err) {
        showToast(String(err.message || err));
        target.disabled = false;
      }
      return;
    }

    if (target.hasAttribute("data-remember-text")) {
      const text = target.getAttribute("data-remember-text");
      target.disabled = true;
      try {
        await apiPost("/api/memory/add", { projectRoot: state.currentProject, text });
        target.textContent = "已记进项目知识";
        showToast("已记进项目知识");
      } catch (err) {
        showToast(String(err.message || err));
        target.disabled = false;
      }
      return;
    }

    if (target.hasAttribute("data-dispatch-at")) {
      const turnAt = target.getAttribute("data-dispatch-at");
      target.disabled = true;
      target.textContent = "正在派出…";
      try {
        const res = await apiPost("/api/dispatch", { projectRoot: state.currentProject, turnAt });
        showToast(res.note || "已派出去");
        await loadHistory();
      } catch (err) {
        showToast(String(err.message || err));
        target.disabled = false;
        target.textContent = "派出去";
      }
    }
  });

  async function bootAuthed() {
    const projectsData = await apiGet("/api/projects");
    state.projects = projectsData.projects || [];
    const saved = (() => { try { return localStorage.getItem("mesa.mw.project"); } catch { return ""; } })();
    const hashProj = new URLSearchParams(location.hash.replace(/^#\/?/, "").split("?")[1] || "").get("project");
    const picked =
      state.projects.find((p) => p.path === hashProj)?.path ||
      state.projects.find((p) => p.path === saved)?.path ||
      state.projects[0]?.path ||
      "";
    if (picked) {
      await selectProject(picked);
    } else {
      render();
    }
  }

  async function init() {
    if (location.pathname === "/pair") {
      const params = new URLSearchParams(location.search);
      const token = (params.get("t") || "").trim();
      history.replaceState(null, "", "/pair");
      if (token) {
        await handlePairPage(token);
        return;
      }
    }
    try {
      const me = await apiGet("/api/me");
      state.authed = true;
      state.csrfToken = me.csrfToken || "";
      state.deviceName = me.deviceName || "";
      await bootAuthed();
    } catch {
      state.authed = false;
      render();
    }
  }

  void init();
})();
