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
    diffSources: [],
    diffScope: "",
    streaming: false,
    streamId: "",
    streamSteps: [],
    streamText: "",
    pendingQuestion: "",
    sseOnline: false,
    es: null,
    sheet: null, // { type: "drop" | "step" | "file", ... }
    dropProject: "",
    overviewPendingRender: false,
  };

  let activeBlobUrl = null;
  function revokeBlobUrl() {
    if (activeBlobUrl) {
      try { URL.revokeObjectURL(activeBlobUrl); } catch {}
      activeBlobUrl = null;
    }
  }

  function closeSheet() {
    revokeBlobUrl();
    state.sheet = null;
    state.overviewPendingRender = false;
    render();
  }

  function isUserTyping() {
    const el = document.activeElement;
    if (!el || !appEl.contains(el)) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function briefStateMeta(code) {
    switch (code) {
      case "saved": return { label: "已保存", cls: "ok" };
      case "review": return { label: "待评审", cls: "warn" };
      case "working": return { label: "运行中", cls: "info" };
      case "confirm": return { label: "等确认", cls: "warn" };
      case "failed": return { label: "出错", cls: "err" };
      case "open": return { label: "已开副本", cls: "muted" };
      case "idle": return { label: "未开始", cls: "muted" };
      default: return { label: code || "进行中", cls: "muted" };
    }
  }

  const ICON_MESA_MARK = `<svg viewBox="232 284 708 456" aria-hidden="true"><path d="M232 740 V284 H356 L512 512 L668 284 H792 V740 H672 V474 L548 652 H476 L352 474 V740 Z" fill="currentColor"/><rect x="820" y="680" width="120" height="60" rx="6" class="mesa-cursor"/></svg>`;
  const ICON_CHEV_DOWN = `<svg class="select-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const ICON_CHEV_RIGHT = `<svg class="row-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
  const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
  const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
  const ICON_TAB_OVERVIEW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/></svg>`;
  const ICON_TAB_ASSISTANT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const ICON_TAB_FILES = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>`;
  const ICON_STOP = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
  const ICON_FILE_TEXT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/><path d="M16 13h-2"/></svg>`;
  const ICON_FILE_IMG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;

  function fileIconInfo(relPath) {
    const ext = (String(relPath || "").split(".").pop() || "").toLowerCase();
    if (ext === "pdf") return { cls: "pdf", svg: ICON_FILE_TEXT };
    if (["doc", "docx", "rtf", "pptx", "xlsx"].includes(ext)) return { cls: "doc", svg: ICON_FILE_TEXT };
    if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext)) return { cls: "img", svg: ICON_FILE_IMG };
    return { cls: "", svg: ICON_FILE_TEXT };
  }

  function parseCloseoutLine(line) {
    const s = String(line || "").trim();
    const m = s.match(/^(.+?)\s*[（(]([^）)]+)[）)]$/);
    if (m) return { title: m[1].trim(), rel: m[2].trim() };
    const name = s.split("/").pop() || s;
    return { title: name, rel: s };
  }

  function humanSummarySub(ov, steps, savedCount) {
    if (!steps.length) {
      const n = (ov.goals || []).length;
      return n ? `自由目标模式 · ${n} 个目标` : "自由目标模式";
    }
    if (savedCount === steps.length) {
      const allArchived = steps.every((s) => s.archived);
      return allArchived ? "全部步骤已保存 · 临时副本已收起" : "全部步骤已保存进项目";
    }
    const cur =
      steps.find((s) => s.failure) ||
      steps.find((s) => s.briefState === "confirm") ||
      steps.find((s) => s.briefState === "review") ||
      steps.find((s) => s.briefState === "working") ||
      steps.find((s) => !s.saved);
    if (!cur) return `已完成 ${savedCount}/${steps.length} 步`;
    const bm = briefStateMeta(cur.briefState);
    return `第 ${cur.n} 步「${cur.name}」${cur.failure ? "出错" : bm.label}`;
  }

  function humanStepSub(s) {
    if (s.failure) return s.failure;
    if (s.saved && s.archived) return "已保存 · 已收起";
    if (s.saved) return "已保存进项目";
    if (s.staleUpstream) return `上游「${s.staleUpstream}」有更新待跟进`;
    if (s.briefState === "review") return "做完了 · 待回电脑评审";
    if (s.briefState === "working") return "Agent 运行中";
    if (s.briefState === "confirm") return "等确认";
    if (s.briefState === "open") return "已开启工作副本";
    if (s.briefState === "idle") return "未开始";
    return String(s.state || "").replace(/（[^）]*）/g, "").trim() || "进行中";
  }

  function totalPendingCount(ov) {
    if (!ov) return 0;
    return (ov.helpItems?.length || 0) + (ov.grantItems?.length || 0);
  }

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

    const splitRow = (row) =>
      row
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
    const isTableSep = (line) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim());

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
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
      if (trimmed.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        closeLists();
        const headers = splitRow(trimmed);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().includes("|") && !/^\u0000CB\d+\u0000$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        i -= 1;
        const thead = `<thead><tr>${headers.map((h) => `<th>${inlineFmt(h)}</th>`).join("")}</tr></thead>`;
        const tbody = rows.length
          ? `<tbody>${rows.map((r) => `<tr>${headers.map((_, ci) => `<td>${inlineFmt(r[ci] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>`
          : "";
        out.push(`<table>${thead}${tbody}</table>`);
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

  async function loadFiles(scopeOverride) {
    if (!state.currentProject) return;
    try {
      if (state.filesMode === "diff") {
        const reqScope = scopeOverride !== undefined ? scopeOverride : state.diffScope;
        const qs = reqScope ? `&scope=${encodeURIComponent(reqScope)}` : "";
        const data = await apiGet(`/api/files/diff?project=${encodeURIComponent(state.currentProject)}${qs}`);
        state.diffText = data.diff || "";
        state.diffSources = Array.isArray(data.sources) ? data.sources : [];
        state.diffScope = data.activeSource || reqScope || "main";
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
        if (state.tab === "overview" && !state.sheet && !isUserTyping()) {
          state.overviewPendingRender = false;
          render();
        } else {
          if (state.tab === "overview") state.overviewPendingRender = true;
          updateTabBadges();
        }
      } catch {}
    });
  }

  function updateTabBadges() {
    const count = totalPendingCount(state.overview);
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
    state.dropProject = path;
    try { localStorage.setItem("mesa.mw.project", path); } catch {}
    state.overview = null;
    state.history = [];
    state.files = [];
    state.diffText = "";
    state.diffSources = [];
    state.diffScope = "";
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
    state.streamSteps = ["正在查看项目…"];
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
            const label = String(payload.step).trim();
            if (label && state.streamSteps[state.streamSteps.length - 1] !== label) {
              if (state.streamSteps.length === 1 && state.streamSteps[0] === "正在查看项目…") {
                state.streamSteps = [label];
              } else {
                state.streamSteps = [...state.streamSteps.slice(-11), label];
              }
              updateStreamDom();
            }
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
      state.streamSteps = [];
      state.streamText = "";
      render();
      scrollChatBottom();
    }
  }

  function renderStreamTrailHtml() {
    const steps = state.streamSteps.length ? state.streamSteps : ["正在思考…"];
    const lastIdx = steps.length - 1;
    return steps
      .map((s, idx) =>
        idx === lastIdx
          ? `<div class="stream-trail-item now"><span class="pulse-dot"></span><span>${esc(s)}</span></div>`
          : `<div class="stream-trail-item done"><span>✓</span><span>${esc(s)}</span></div>`,
      )
      .join("");
  }

  function updateStreamDom() {
    const trailEl = document.getElementById("stream-trail");
    if (trailEl) trailEl.innerHTML = renderStreamTrailHtml();
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
    revokeBlobUrl();
    const ext = (relPath.split(".").pop() || "").toLowerCase();
    const isImg = ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext);
    const isPdf = ext === "pdf";
    const isOffice = ["docx", "pptx", "xlsx"].includes(ext);
    const rawUrl = `/api/files/raw?project=${encodeURIComponent(state.currentProject)}&path=${encodeURIComponent(relPath)}`;
    if (isImg) {
      state.sheet = { type: "file", path: relPath, kind: "image", rawUrl, loading: false };
      render();
      return;
    }
    if (isPdf || isOffice) {
      state.sheet = { type: "file", path: relPath, kind: isPdf ? "pdf" : "download", rawUrl, blobUrl: "", loading: true };
      render();
      try {
        // iOS 主屏独立 PWA 下 target="_blank" 会切到无 Cookie 的 SafariViewController 导致 401；
        // 先同源带 Cookie 拉成 Blob URL，PDF 页内嵌显，Word/PPT/Excel 直接提供系统打开/下载
        const res = await fetch(rawUrl, { credentials: "same-origin" });
        if (res.status === 401) {
          state.authed = false;
          state.sheet = null;
          render();
          throw new Error("需要重新扫码配对");
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `读取文件失败 (${res.status})`);
        }
        const blob = await res.blob();
        activeBlobUrl = URL.createObjectURL(blob);
        state.sheet = {
          type: "file",
          path: relPath,
          kind: isPdf ? "pdf" : "download",
          rawUrl,
          blobUrl: activeBlobUrl,
          size: blob.size,
          loading: false,
        };
        render();
      } catch (e) {
        closeSheet();
        showToast(String(e.message || e));
      }
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
      closeSheet();
      showToast(String(e.message || e));
    }
  }

  function formatCheckItem(c) {
    if (typeof c === "string") return `<li>${esc(c)}</li>`;
    if (!c || typeof c !== "object") return "";
    const mark = c.status === "blocked" ? "✕" : c.status === "needs_human" ? "⚠" : "✓";
    const meta = [c.source, c.location].filter(Boolean).join(" · ");
    return `<li><strong>${mark} ${esc(c.title || "核验项")}</strong>${meta ? `<div class="check-meta">${esc(meta)}</div>` : ""}${c.detail ? `<div class="check-meta">${esc(c.detail)}</div>` : ""}</li>`;
  }

  function renderOverviewTab() {
    const ov = state.overview;
    if (!ov) return `<div class="empty-note">正在读取项目状态…</div>`;
    const helpItems = ov.helpItems || [];
    const grantItems = ov.grantItems || [];
    const pendingTotal = helpItems.length + grantItems.length;
    const steps = ov.steps || [];
    const goals = ov.goals || [];
    const closeout = ov.closeout || null;
    const savedCount = steps.filter((s) => s.saved).length;

    let html = "";
    const miniStepper = steps.length > 0
      ? `<div class="mini-stepper" aria-label="步骤总览">${steps
          .map((s, idx) => {
            const nodeCls = s.saved
              ? "saved"
              : s.failure
                ? "failed"
                : s.briefState === "working"
                  ? "working"
                  : s.briefState === "review" || s.briefState === "confirm"
                    ? "warn"
                    : "";
            const nodeInner = s.saved ? ICON_CHECK : String(s.n);
            const line = idx < steps.length - 1
              ? `<span class="mini-line ${s.saved && steps[idx + 1].saved ? "done" : ""}"></span>`
              : "";
            return `<button type="button" class="mini-node ${nodeCls}" data-open-step="${s.n}" title="第 ${s.n} 步 · ${esc(s.name)}">${nodeInner}</button>${line}`;
          })
          .join("")}</div>`
      : "";

    html += `<div class="summary-card">
      <div class="summary-top">
        <div class="step-body">
          <div class="summary-title">${esc(ov.name || ov.projectName || "项目")}</div>
          <div class="summary-sub">${esc(humanSummarySub(ov, steps, savedCount))}</div>
        </div>
        <span class="pill ${steps.length && savedCount === steps.length ? "ok" : "muted"}">
          <span class="pill-dot"></span>${steps.length ? `${savedCount} / ${steps.length}` : `${goals.length} 目标`}
        </span>
      </div>
      ${miniStepper}
    </div>`;

    if (pendingTotal > 0) {
      html += `<div class="section-label"><span>等你的事 · ${pendingTotal}</span></div>`;
      for (const g of grantItems) {
        const blockedList = Array.isArray(g.blocked) && g.blocked.length
          ? `<div class="md mt-8"><ul>${g.blocked.slice(0, 6).map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>`
          : "";
        html += `<div class="card card-warn" data-grant-card="${esc(g.scheduleId)}">
          <div class="help-where"><span class="pill warn"><span class="pill-dot"></span>定时授权</span><span>${esc(g.scheduleName)}</span></div>
          <p class="help-q">这次运行因联网或权限受限被拦下，是否放宽重跑这一次？</p>
          ${blockedList}
          <div class="btn-row mt-10">
            <button class="btn primary" data-grant-resolve="once" data-grant-id="${esc(g.scheduleId)}">放宽重跑这一次</button>
            <button class="btn" data-grant-resolve="dismiss" data-grant-id="${esc(g.scheduleId)}">不用</button>
          </div>
        </div>`;
      }
      for (const h of helpItems) {
        html += `<div class="card card-warn" data-help-card="${esc(h.itemId)}" data-help-root="${esc(h.root)}">
          <div class="help-where"><span class="pill warn"><span class="pill-dot"></span>人工请求</span><span>${esc(h.whereLabel || "待答复")}</span></div>
          <p class="help-q">${esc(h.question)}</p>
          ${h.options && h.options.length ? `<div class="btn-row">${h.options
            .map((o) => {
              const isRec = h.recommend && h.recommend === o.key;
              return `<button class="btn ${isRec ? "primary" : ""}" data-help-opt="${esc(o.key)}" data-help-label="${esc(o.label)}">${esc(o.key)} · ${esc(o.label)}${isRec ? "（建议）" : ""}</button>`;
            })
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
      html += `<div class="section-label"><span>流程步骤</span><span>点按看核验与详情</span></div>`;
      html += `<div class="list-card">`;
      for (const s of steps) {
        const cls = s.saved ? "saved" : s.failure ? "failed" : s.briefState === "working" ? "working" : "";
        const bm = briefStateMeta(s.briefState);
        const badge = s.failure
          ? `<span class="pill err"><span class="pill-dot"></span>出错</span>`
          : s.checksBlocked > 0
            ? `<span class="pill err"><span class="pill-dot"></span>拦下 ${s.checksBlocked}</span>`
            : s.checksNeedsHuman > 0
              ? `<span class="pill warn"><span class="pill-dot"></span>待判 ${s.checksNeedsHuman}</span>`
              : s.saved
                ? `<span class="pill ok"><span class="pill-dot"></span>已保存</span>`
                : `<span class="pill ${bm.cls}"><span class="pill-dot"></span>${esc(bm.label)}</span>`;
        html += `<button class="step-row" data-open-step="${s.n}">
          <span class="step-num ${cls}">${s.saved ? ICON_CHECK : s.n}</span>
          <div class="step-body">
            <div class="step-name">${esc(s.name)}</div>
            <div class="step-state">${esc(humanStepSub(s))}</div>
          </div>
          ${badge}
          ${ICON_CHEV_RIGHT}
        </button>`;
      }
      html += `</div>`;
    }

    if (closeout && ((closeout.finalFiles && closeout.finalFiles.length) || closeout.targetJournal)) {
      html += `<div class="section-label"><span>完结文件</span>${closeout.targetJournal ? `<span>${esc(closeout.targetJournal)}</span>` : ""}</div>`;
      html += `<div class="list-card">`;
      for (const line of closeout.finalFiles || []) {
        const { title, rel } = parseCloseoutLine(line);
        const ico = fileIconInfo(rel);
        html += `<button class="file-row" data-open-file="${esc(rel)}">
          <span class="file-ico ${ico.cls}">${ico.svg}</span>
          <div class="file-main">
            <div class="file-name">${esc(title)}</div>
            <div class="file-sub">${esc(rel)}</div>
          </div>
          ${ICON_CHEV_RIGHT}
        </button>`;
      }
      html += `</div>`;
    }

    if (goals.length > 0) {
      html += `<div class="section-label"><span>流程外目标</span></div><div class="list-card">`;
      for (const g of goals) {
        const tone = g.status === "completed" ? "ok" : g.status === "failed" ? "err" : g.status === "pending_review" ? "warn" : g.status === "running" ? "info" : "muted";
        html += `<div class="file-row"><div class="file-main"><div class="file-name">${esc(g.name)}</div></div><span class="pill ${tone}"><span class="pill-dot"></span>${esc(g.statusLabel || g.status)}</span></div>`;
      }
      html += `</div>`;
    }

    return html;
  }

  function parseLegacyProposals(answerText) {
    const src = String(answerText || "");
    let workOrder = null;
    const memories = [];
    const woMatch = src.match(/:::\s*派活\s*\n([\s\S]*?)\n\s*:::/);
    if (woMatch) {
      const lines = woMatch[1].split("\n");
      const map = {};
      for (const ln of lines) {
        const m = ln.match(/^([^：:]+)[：:]\s*(.*)$/);
        if (m) map[m[1].trim()] = m[2].trim();
      }
      const targetStr = map["交给"] || "";
      const stepMatch = targetStr.match(/第\s*(\d+)\s*步/);
      if (map["要做"] || map["标题"]) {
        workOrder = {
          title: map["标题"] || (map["要做"] || "派活任务").slice(0, 32),
          target: stepMatch ? "step" : "goal",
          step: stepMatch ? Number(stepMatch[1]) : null,
          task: map["要做"] || "",
          deliver: map["交付"] || map["交付物"] || "",
        };
      }
    }
    const memRe = /:::\s*记下\s*\n([\s\S]*?)\n\s*:::/g;
    let mm;
    while ((mm = memRe.exec(src)) !== null) {
      const txt = mm[1].trim();
      if (txt) memories.push({ text: txt });
    }
    return { workOrder, memories };
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
    const rawP = turn.proposals || {};
    const legacy = !rawP.workOrder && !(rawP.memories && rawP.memories.length)
      ? parseLegacyProposals(turn.answer)
      : { workOrder: null, memories: [] };
    const workOrder = rawP.workOrder || legacy.workOrder;
    const memories = Array.isArray(rawP.memories) && rawP.memories.length ? rawP.memories : legacy.memories;

    let extra = "";
    if (workOrder) {
      const wo = workOrder;
      const doneNote = turn.dispatched
        ? `<span class="pill ok">已派：${esc(turn.dispatched.note || "已发出")}</span>`
        : `<button class="btn primary" data-dispatch-at="${esc(turn.at)}">派出去</button>`;
      extra += `<div class="proposal-card">
        <div class="proposal-title">派活单 · ${esc(wo.title)}</div>
        <div class="proposal-meta">${wo.target === "step" ? `交给第 ${wo.step} 步` : "另起新目标"}${wo.deliver ? ` · 交付：${esc(wo.deliver)}` : ""}</div>
        <div class="md">${renderMarkdown(wo.task)}</div>
        <div class="btn-row">${doneNote}</div>
      </div>`;
    }
    if (rawP.reworkOrder) {
      extra += `<div class="proposal-card">
        <div class="proposal-title">补料单 · 退回第 ${rawP.reworkOrder.toStep} 步</div>
        <div class="proposal-meta">补料单需回电脑端 Mesa 确认并核对下游跟进</div>
      </div>`;
    }
    if (memories.length) {
      for (const m of memories) {
        extra += `<div class="proposal-card">
          <div class="proposal-title">以后照这样办</div>
          <div class="md">${renderMarkdown(m.text)}</div>
          <div class="btn-row"><button class="btn" data-remember-text="${esc(m.text)}">记进项目知识</button></div>
        </div>`;
      }
    }

    const headMeta = [relTime(turn.at), turn.connection].filter(Boolean).join(" · ");
    return `<div class="q-bubble">${esc(turn.question)}</div>
      <div class="a-block">
        <div class="a-head"><span class="a-mark-svg">${ICON_MESA_MARK}</span><span>项目助手${headMeta ? ` · ${esc(headMeta)}` : ""}</span></div>
        <div class="md">${renderMarkdown(cleanText)}</div>
        ${extra}
      </div>`;
  }

  function renderAssistantTab() {
    const turns = state.history || [];
    let body = "";
    if (!turns.length && !state.streaming) {
      body = `<div class="chat-empty">
        <div class="chat-empty-mark">${ICON_MESA_MARK}</div>
        <div class="chat-empty-title">项目助手</div>
        <div class="chat-empty-sub">与电脑端共用同一份记录与上下文</div>
        <div class="quick-list">
          <button class="quick-row" data-quick-ask="现在到哪了？"><span>现在到哪了？</span>${ICON_CHEV_RIGHT}</button>
          <button class="quick-row" data-quick-ask="哪里出问题了？"><span>哪里出问题了？</span>${ICON_CHEV_RIGHT}</button>
          <button class="quick-row" data-quick-ask="我下一步该做什么？"><span>我下一步该做什么？</span>${ICON_CHEV_RIGHT}</button>
        </div>
      </div>`;
    } else {
      body = turns.slice(-40).map(renderTurnCard).join("");
    }
    if (state.streaming) {
      body += `<div class="q-bubble">${esc(state.pendingQuestion)}</div>
        <div class="a-block">
          <div class="a-head"><span class="a-mark-svg">${ICON_MESA_MARK}</span><span>项目助手</span></div>
          <div id="stream-trail" class="stream-trail">${renderStreamTrailHtml()}</div>
          <div id="stream-md" class="md">${renderMarkdown(state.streamText)}</div>
        </div>`;
    }
    return `<div class="chat-wrap">
      <div class="chat-list">${body}</div>
      <div class="composer-wrap">
        <form id="chat-form" class="composer-bar">
          <textarea id="chat-input" class="composer-input" rows="1" placeholder="问项目进展、查文件或起草派活…"></textarea>
          ${state.streaming
            ? `<button type="button" id="chat-stop" class="send-circle stop" aria-label="停止">${ICON_STOP}</button>`
            : `<button type="submit" class="send-circle" aria-label="发送">${ICON_SEND}</button>`}
        </form>
      </div>
    </div>`;
  }

  function renderFilesTab() {
    const seg = `<div class="seg-bar">
      <button class="seg-btn ${state.filesMode === "closeout" ? "active" : ""}" data-fmode="closeout">完结文件</button>
      <button class="seg-btn ${state.filesMode === "all" ? "active" : ""}" data-fmode="all">全部文件</button>
      <button class="seg-btn ${state.filesMode === "diff" ? "active" : ""}" data-fmode="diff">最近改动</button>
    </div>`;

    if (state.filesMode === "diff") {
      const srcBar = state.diffSources.length > 1
        ? `<div class="diff-sources">${state.diffSources
            .map((s) => `<button class="diff-src-btn ${s.id === state.diffScope ? "active" : ""}" data-diff-scope="${esc(s.id)}">${esc(s.label)}${s.hasChanges ? " ●" : ""}</button>`)
            .join("")}</div>`
        : "";
      if (!state.diffText.trim()) return `${seg}${srcBar}<div class="empty-note">当前范围暂无未提交改动，也无最近差异可预览。</div>`;
      const lines = state.diffText.split("\n").map((l) => {
        const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "";
        return `<div class="diff-line ${cls}">${esc(l)}</div>`;
      }).join("");
      return `${seg}${srcBar}<div class="diff-box">${lines}</div>`;
    }

    let listHtml = "";
    if (state.filesMode === "closeout") {
      const c = state.overview?.closeout;
      const items = [...(c?.finalFiles || []), ...(c?.checkFiles || [])];
      if (!items.length) {
        listHtml = `<div class="empty-note">暂无完结文件，点上方「全部文件」浏览项目目录。</div>`;
      } else {
        listHtml = `<div class="list-card">${items.map((line) => {
          const { title, rel } = parseCloseoutLine(line);
          const ico = fileIconInfo(rel);
          return `<button class="file-row" data-open-file="${esc(rel)}">
            <span class="file-ico ${ico.cls}">${ico.svg}</span>
            <div class="file-main">
              <div class="file-name">${esc(title)}</div>
              <div class="file-sub">${esc(rel)}</div>
            </div>
            ${ICON_CHEV_RIGHT}
          </button>`;
        }).join("")}</div>`;
      }
      return seg + listHtml;
    }

    const searchBox = `<input id="file-search" class="input mb-10" value="${esc(state.fileQuery)}" placeholder="按文件名或路径筛选…">`;
    if (!state.files.length) {
      listHtml = `<div class="empty-note">没有匹配的文件</div>`;
    } else {
      listHtml = `<div class="list-card">${state.files.map((f) => {
        const ico = fileIconInfo(f.path);
        const name = f.path.split("/").pop() || f.path;
        return `<button class="file-row" data-open-file="${esc(f.path)}">
          <span class="file-ico ${ico.cls}">${ico.svg}</span>
          <div class="file-main">
            <div class="file-name">${esc(name)}</div>
            <div class="file-sub">${esc(f.path)}</div>
          </div>
          <span class="file-meta">${esc(formatBytes(f.size))}</span>
          ${ICON_CHEV_RIGHT}
        </button>`;
      }).join("")}</div>`;
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
      const targetProj = state.dropProject || state.currentProject || "";
      const dropOpts = state.projects.length
        ? `<option value="">不指定课题（进通用暂存区）</option>${state.projects
            .map((p) => `<option value="${esc(p.path)}" ${p.path === targetProj ? "selected" : ""}>${esc(p.name)}</option>`)
            .join("")}`
        : `<option value="">通用暂存区</option>`;
      body = `
        <p class="auth-desc mb-12">拍照、选文件或写一段灵感，经加密通道直达电脑端「从手机添加」暂存区（4G/5G 或任意 Wi-Fi 均可）。</p>
        <div class="mb-12">
          <label class="field-label" for="drop-project">目标课题</label>
          <div class="project-select-wrap">
            <select id="drop-project" class="project-select plain-select">${dropOpts}</select>
            ${ICON_CHEV_DOWN}
          </div>
        </div>
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
          ${(d.checks && d.checks.length) ? `<div class="card"><div class="proposal-title">核验提醒 (${d.checks.length})</div><div class="md"><ul>${d.checks.map(formatCheckItem).join("")}</ul></div></div>` : ""}
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
        const fileName = sh.path.split("/").pop() || "document.pdf";
        body = `
          <iframe class="pdf-frame" src="${esc(sh.blobUrl)}" title="${esc(fileName)}"></iframe>
          <div class="btn-row mt-10">
            <a class="btn primary flex-1 inline-flex-center justify-center no-underline" href="${esc(sh.blobUrl)}" download="${esc(fileName)}">下载 / 用系统打开 PDF</a>
          </div>`;
      } else if (sh.kind === "download") {
        const fileName = sh.path.split("/").pop() || "document";
        body = `<div class="empty-note">
          <div class="summary-title">${esc(fileName)}</div>
          <p class="auth-desc mt-8">${sh.size ? `文件大小 ${esc(formatBytes(sh.size))}，` : ""}点击下方按钮保存到手机或用 Word / WPS 打开。</p>
          <a class="btn primary inline-flex-center no-underline" href="${esc(sh.blobUrl)}" download="${esc(fileName)}">下载 / 用系统打开</a>
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
    const pendingCount = totalPendingCount(state.overview);
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
        <span class="brand-mini" title="Mesa 手机工作台">${ICON_MESA_MARK}</span>
        <div class="project-select-wrap">
          <span class="live-dot ${state.sseOnline ? "online" : ""}" title="${state.sseOnline ? "实时连接中" : "正在重连"}"></span>
          <select id="project-select" class="project-select" aria-label="切换项目">${projectOpts}</select>
          ${ICON_CHEV_DOWN}
        </div>
        <button class="icon-btn" data-open-drop>${ICON_PLUS}<span>传资料</span></button>
      </header>
      ${content}
      <nav class="tabbar" aria-label="主导航">
        <button class="tab-btn ${state.tab === "overview" ? "active" : ""}" data-tab="overview">
          <span class="tab-ico-wrap">${ICON_TAB_OVERVIEW}<span class="badge ${pendingCount ? "" : "hidden"}" data-help-badge>${pendingCount}</span></span>
          <span>概览</span>
        </button>
        <button class="tab-btn ${state.tab === "assistant" ? "active" : ""}" data-tab="assistant">
          <span class="tab-ico-wrap">${ICON_TAB_ASSISTANT}</span>
          <span>助手</span>
        </button>
        <button class="tab-btn ${state.tab === "files" ? "active" : ""}" data-tab="files">
          <span class="tab-ico-wrap">${ICON_TAB_FILES}</span>
          <span>文件</span>
        </button>
      </nav>
      ${renderSheet()}`;

    bindEvents();
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const statusEl = document.getElementById("drop-status");
    const targetProj = state.dropProject || "";
    const targetName = state.projects.find((p) => p.path === targetProj)?.name || "";
    let ok = 0;
    for (const f of files) {
      if (statusEl) statusEl.textContent = `正在上传 ${f.name} (${formatBytes(f.size)})…`;
      try {
        const headers = {
          "X-Mesa-CSRF": state.csrfToken,
          "X-Mesa-Name": encodeURIComponent(f.name || "photo.jpg"),
        };
        if (targetProj) headers["X-Mesa-Project"] = encodeURIComponent(targetProj);
        const res = await fetch("/api/drop/file", {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: f,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `上传失败 (${res.status})`);
        ok += 1;
      } catch (e) {
        showToast(`${f.name} 没传上：${e.message || e}`);
      }
    }
    const suffix = targetName ? `（目标课题：${targetName}）` : "";
    if (statusEl) statusEl.textContent = ok ? `已送达电脑暂存区 ${ok} 份文件${suffix}` : "";
    if (ok) showToast(`已送达电脑 ${ok} 份文件${suffix}`);
  }

  function bindEvents() {
    const sel = document.getElementById("project-select");
    if (sel) {
      sel.addEventListener("change", () => void selectProject(sel.value));
    }

    const dropProj = document.getElementById("drop-project");
    if (dropProj) {
      dropProj.addEventListener("change", () => {
        state.dropProject = dropProj.value;
      });
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
          const targetProj = state.dropProject || "";
          await apiPost("/api/drop/text", targetProj ? { text, projectRoot: targetProj } : { text });
          if (box) box.value = "";
          const targetName = state.projects.find((p) => p.path === targetProj)?.name || "";
          showToast(targetName ? `已送到电脑暂存区（${targetName}）` : "已送到电脑端暂存区");
        } catch (e) {
          showToast(String(e.message || e));
        } finally {
          dropTextBtn.disabled = false;
        }
      });
    }
  }

  appEl.addEventListener("focusout", () => {
    if (!state.overviewPendingRender) return;
    setTimeout(() => {
      if (state.overviewPendingRender && state.tab === "overview" && !state.sheet && !isUserTyping()) {
        state.overviewPendingRender = false;
        render();
      }
    }, 120);
  });

  appEl.addEventListener("click", async (e) => {
    const target = e.target.closest("button, [data-close-sheet]");
    if (!target) return;

    if (target.hasAttribute("data-close-sheet")) {
      if (target.classList.contains("sheet-backdrop") && e.target !== target) return;
      closeSheet();
      return;
    }

    if (target.hasAttribute("data-open-drop")) {
      state.dropProject = state.currentProject || "";
      state.sheet = { type: "drop" };
      render();
      return;
    }

    if (target.hasAttribute("data-tab")) {
      const next = target.getAttribute("data-tab");
      if (next && next !== state.tab) {
        state.tab = next;
        state.overviewPendingRender = false;
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

    if (target.hasAttribute("data-diff-scope")) {
      const nextScope = target.getAttribute("data-diff-scope") || "";
      if (nextScope !== state.diffScope) {
        state.diffScope = nextScope;
        await loadFiles(nextScope);
      }
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

    if (target.hasAttribute("data-grant-resolve")) {
      const mode = target.getAttribute("data-grant-resolve");
      const scheduleId = target.getAttribute("data-grant-id");
      if (!scheduleId) return;
      target.disabled = true;
      try {
        const res = await apiPost("/api/grant/resolve", {
          projectRoot: state.currentProject,
          scheduleId,
          allowOnce: mode === "once",
        });
        showToast(res.message || "已处理授权请求");
        await loadOverview();
      } catch (err) {
        showToast(String(err.message || err));
        target.disabled = false;
      }
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

  function readDeepLinkParams() {
    const hashParams = new URLSearchParams(location.hash.replace(/^#\/?/, "").split("?")[1] || "");
    const searchParams = new URLSearchParams(location.search || "");
    const project = hashParams.get("project") || searchParams.get("project") || "";
    const tab = hashParams.get("tab") || searchParams.get("tab") || "";
    return { project, tab };
  }

  async function bootAuthed() {
    const projectsData = await apiGet("/api/projects");
    state.projects = projectsData.projects || [];
    const saved = (() => { try { return localStorage.getItem("mesa.mw.project"); } catch { return ""; } })();
    const link = readDeepLinkParams();
    if (link.tab === "overview" || link.tab === "assistant" || link.tab === "files") {
      state.tab = link.tab;
    }
    const picked =
      state.projects.find((p) => p.path === link.project)?.path ||
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
      if (me.theme === "light" || me.theme === "dark") {
        document.documentElement.dataset.theme = me.theme;
      }
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
