// 「发到 Mesa」手机页（phone_drop.rs 同源下发；不引任何外部资源）。
// 扫码地址 /p/<配对令牌>/ 打开即配对，跳到 /d/<设备令牌>/——加到主屏的就是这个地址，下次点开直接能发。
// 一件一件按顺序传，带进度；电脑没在接收时先排着，连上后自动补发。
(function () {
  "use strict";

  var MAX_FILE = 100 * 1024 * 1024;
  var MAX_TEXT = 20000;
  var STALL_MS = 60000;
  var POLL_ONLINE_MS = 15000;
  var POLL_OFFLINE_MS = 4000;
  var DEVICE_KEY = "mesa.devicePath";

  var statusEl = document.getElementById("status");
  var listEl = document.getElementById("sent");
  var camera = document.getElementById("camera");
  var files = document.getElementById("files");
  var form = document.getElementById("note");
  var textEl = document.getElementById("text");
  var sendBtn = document.getElementById("send");

  var queue = [];
  var busy = false;
  var online = true;
  // 没连上电脑时没送出去的：连上后自动补发
  var waiting = [];
  var okText = statusEl.textContent;

  var ERRORS = {
    too_large: "超过 100 MB，没有发送",
    session_full: "24 小时内最多传 1 GB，已经满了",
    too_long: "超过 2 万字，没有发送",
    empty: "是空的，没有发送",
    busy: "电脑那边正忙，稍后重试",
    incomplete: "没传完",
    bad_text: "文字编码不对",
  };

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* 无痕模式写不进：这次照样能发，只是下次要重新扫码 */
    }
  }

  function request(method, path, body, headers, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.timeout = 8000;
    for (var k in headers || {}) xhr.setRequestHeader(k, headers[k]);
    xhr.onload = function () {
      done(xhr.status, xhr.responseText);
    };
    xhr.onerror = xhr.ontimeout = function () {
      done(0, "");
    };
    xhr.send(body || null);
  }

  // ---- 配对：扫码地址先看这台手机是不是已经配过（同一地址存过设备路径且还有效），否则新配一台 ----
  function pairIfNeeded() {
    if (!/^\/p\//.test(location.pathname)) return;
    var saved = storageGet(DEVICE_KEY);
    var fresh = function () {
      request("POST", "pair", null, {}, function (status, text) {
        var body = null;
        try {
          body = JSON.parse(text);
        } catch (e) {
          body = null;
        }
        if (status === 200 && body && body.path) {
          storageSet(DEVICE_KEY, body.path);
          location.replace(body.path + "?new=1");
          return;
        }
        if (body && body.error === "too_many_devices") {
          statusEl.textContent =
            "这台电脑已经记住 8 台手机了：先在 Mesa 的「从手机添加」里移除不用的。这次照样能发，只是下次要重新扫码。";
          statusEl.className = "status bad";
        }
      });
    };
    if (!saved || !/^\/d\/[0-9a-f]+\/$/.test(saved)) {
      fresh();
      return;
    }
    request("GET", saved + "state", null, {}, function (status) {
      if (status === 200) location.replace(saved);
      else fresh();
    });
  }

  function showTipIfNew() {
    if (!/[?&]new=1/.test(location.search)) return;
    var ua = navigator.userAgent || "";
    var ios = /iPhone|iPad|iPod/.test(ua);
    var android = /Android/.test(ua);
    document.getElementById("tip-ios").hidden = android && !ios;
    document.getElementById("tip-android").hidden = ios && !android;
    var tip = document.getElementById("tip");
    tip.hidden = false;
    document.getElementById("tip-close").addEventListener("click", function () {
      tip.hidden = true;
    });
    // 去掉 ?new=1 再让人加到主屏，免得主屏图标每次打开都弹这段说明
    history.replaceState(null, "", location.pathname);
  }

  // ---- 已发列表 ----
  function row(name) {
    var li = document.createElement("li");
    var n = document.createElement("span");
    n.className = "name";
    n.textContent = name;
    var s = document.createElement("span");
    s.className = "state";
    li.appendChild(n);
    li.appendChild(s);
    listEl.insertBefore(li, listEl.firstChild);
    return { li: li, state: s, retry: null };
  }

  function show(r, text, tone, retry) {
    r.state.textContent = text;
    r.state.className = "state" + (tone ? " " + tone : "");
    if (r.retry) {
      r.li.removeChild(r.retry);
      r.retry = null;
    }
    if (retry) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "重试";
      b.addEventListener("click", function () {
        show(r, "排队中", "", null);
        enqueue(retry);
      });
      r.li.appendChild(b);
      r.retry = b;
    }
  }

  function enqueue(task) {
    queue.push(task);
    pump();
  }

  function pump() {
    if (busy || queue.length === 0) return;
    busy = true;
    var task = queue.shift();
    task.run(function () {
      busy = false;
      pump();
    });
  }

  function errorText(xhr) {
    try {
      var body = JSON.parse(xhr.responseText);
      if (body && ERRORS[body.error]) return ERRORS[body.error];
    } catch (e) {
      /* 非 JSON：落到通用文案 */
    }
    return "没送到";
  }

  // 连不上电脑（没在接收 / 网络变了）的那条先排着，连上后自动补发
  function park(task) {
    show(task.row, "等连上电脑", "", null);
    waiting.push(task);
    markOffline();
  }

  // 一次上传 / 发送：60 秒没有进展就放弃（手机息屏、网络断开时连接可能一直挂着）
  function send(task, path, body, headers) {
    var r = task.row;
    return function (done) {
      var xhr = new XMLHttpRequest();
      var last = Date.now();
      var timer = setInterval(function () {
        if (Date.now() - last > STALL_MS) xhr.abort();
      }, 5000);
      var ended = false;
      function finish(fn) {
        if (ended) return;
        ended = true;
        clearInterval(timer);
        fn();
        done();
      }
      xhr.open("POST", path);
      for (var k in headers) xhr.setRequestHeader(k, headers[k]);
      xhr.upload.onprogress = function (e) {
        last = Date.now();
        if (e.lengthComputable && e.total > 0) {
          show(r, "上传中 " + Math.floor((e.loaded / e.total) * 100) + "%", "", null);
        }
      };
      xhr.onload = function () {
        finish(function () {
          if (xhr.status === 200) {
            show(r, "已送到", "ok", null);
            markOnline();
          } else if (xhr.status === 404) {
            // 这台手机被移除了，或扫码地址已过期
            show(r, "没送到：电脑不认这个页面了，请重新扫码", "err", null);
          } else {
            var t = errorText(xhr);
            var retryable = xhr.status === 503 || xhr.status >= 500 || t === ERRORS.incomplete;
            show(r, t, "err", retryable ? task : null);
          }
        });
      };
      xhr.onerror = function () {
        finish(function () {
          park(task);
        });
      };
      xhr.onabort = function () {
        finish(function () {
          show(r, "没送到", "err", task);
        });
      };
      show(r, "上传中", "", null);
      xhr.send(body);
    };
  }

  function addFile(file) {
    var name = file.name || "文件";
    var r = row(name);
    if (file.size > MAX_FILE) {
      show(r, ERRORS.too_large, "err", null);
      return;
    }
    if (file.size === 0) {
      show(r, ERRORS.empty, "err", null);
      return;
    }
    var task = { row: r };
    task.run = send(task, "file", file, {
      "Content-Type": file.type || "application/octet-stream",
      "X-Mesa-Name": encodeURIComponent(name),
    });
    show(r, "排队中", "", null);
    enqueue(task);
  }

  function onPick(input) {
    input.addEventListener("change", function () {
      var list = Array.prototype.slice.call(input.files || []);
      list.forEach(addFile);
      // 清空才能再次选同一个文件
      input.value = "";
    });
  }

  onPick(camera);
  onPick(files);

  textEl.addEventListener("input", function () {
    sendBtn.disabled = textEl.value.trim() === "";
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = textEl.value.trim();
    if (!text) return;
    var title = text.split("\n")[0].slice(0, 30);
    var r = row("「" + title + (text.length > 30 ? "…" : "") + "」");
    if (text.length > MAX_TEXT) {
      show(r, ERRORS.too_long, "err", null);
      return;
    }
    var task = { row: r };
    task.run = send(task, "text", text, { "Content-Type": "text/plain; charset=utf-8" });
    show(r, "排队中", "", null);
    enqueue(task);
    textEl.value = "";
    sendBtn.disabled = true;
  });

  // ---- 连接状态：没在接收时每几秒问一次，连上就把排着的补发 ----
  function markOffline() {
    if (!online) return;
    online = false;
    statusEl.textContent =
      "连不上电脑：确认电脑上的 Mesa 开着、两边连的是同一个 Wi-Fi。连上后没送出去的会自动补发。";
    statusEl.className = "status bad";
    schedulePoll(POLL_OFFLINE_MS);
  }

  function markOnline() {
    if (online) return;
    online = true;
    statusEl.textContent = okText;
    statusEl.className = "status";
    var again = waiting;
    waiting = [];
    again.forEach(function (task) {
      show(task.row, "排队中", "", null);
      enqueue(task);
    });
  }

  var misses = 0;
  var gone = false;
  var pollTimer = null;
  function schedulePoll(ms) {
    if (gone) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }
  function poll() {
    request("GET", "state", null, {}, function (status) {
      if (status === 200) {
        misses = 0;
        markOnline();
      } else if (status === 404) {
        // 电脑在接收，但不认这个地址：这台手机在 Mesa 里被移除了，或扫码地址已过期
        gone = true;
        statusEl.textContent = "电脑不认这个页面了：这台手机可能已在 Mesa 里被移除。请在 Mesa 里点「从手机添加」重新扫码。";
        statusEl.className = "status bad";
        return;
      } else {
        misses += 1;
        if (misses >= 2) markOffline();
      }
      schedulePoll(online ? POLL_ONLINE_MS : POLL_OFFLINE_MS);
    });
  }

  pairIfNeeded();
  showTipIfNew();
  // 配对中的扫码页马上要跳走，不急着探；其余页面一打开就问一次，状态点才是真的
  schedulePoll(/^\/p\//.test(location.pathname) ? POLL_ONLINE_MS : 600);
})();
