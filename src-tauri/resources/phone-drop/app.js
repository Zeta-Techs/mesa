// 「发到 Mesa」手机页（phone_drop.rs 同源下发；不引任何外部资源）。
// 一件一件按顺序传，带进度；失败的可以重试。电脑停止接收后服务就关了，页面连不上即提示重新扫码。
(function () {
  "use strict";

  var MAX_FILE = 100 * 1024 * 1024;
  var MAX_TEXT = 20000;
  var STALL_MS = 60000;
  var POLL_MS = 15000;

  var statusEl = document.getElementById("status");
  var listEl = document.getElementById("sent");
  var camera = document.getElementById("camera");
  var files = document.getElementById("files");
  var form = document.getElementById("note");
  var textEl = document.getElementById("text");
  var sendBtn = document.getElementById("send");

  var queue = [];
  var busy = false;
  var okText = statusEl.textContent;

  var ERRORS = {
    too_large: "超过 100 MB，没有发送",
    session_full: "这次接收已满 1 GB，请在 Mesa 里重新开始接收",
    too_long: "超过 2 万字，没有发送",
    empty: "是空的，没有发送",
    busy: "电脑那边正忙，稍后重试",
    incomplete: "没传完",
    bad_text: "文字编码不对",
  };

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
    task(function () {
      busy = false;
      pump();
    });
  }

  function errorText(xhr) {
    if (xhr.status === 404 || xhr.status === 0) return null;
    try {
      var body = JSON.parse(xhr.responseText);
      if (body && ERRORS[body.error]) return ERRORS[body.error];
    } catch (e) {
      /* 非 JSON：落到通用文案 */
    }
    return "没送到";
  }

  // 一次上传 / 发送：60 秒没有进展就放弃（手机息屏、网络断开时连接可能一直挂着）
  function send(r, path, body, headers, label, again) {
    return function (done) {
      var xhr = new XMLHttpRequest();
      var last = Date.now();
      var timer = setInterval(function () {
        if (Date.now() - last > STALL_MS) xhr.abort();
      }, 5000);
      var ended = false;
      function finish(text, tone, retry) {
        if (ended) return;
        ended = true;
        clearInterval(timer);
        show(r, text, tone, retry);
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
        if (xhr.status === 200) {
          finish(label, "ok", null);
          return;
        }
        var t = errorText(xhr);
        if (t === null) {
          markOffline();
          finish("没送到", "err", again);
        } else {
          var retryable = xhr.status === 503 || xhr.status >= 500 || t === ERRORS.incomplete;
          finish(t, "err", retryable ? again : null);
        }
      };
      xhr.onerror = function () {
        markOffline();
        finish("没送到", "err", again);
      };
      xhr.onabort = function () {
        finish("没送到", "err", again);
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
    var task = function (done) {
      send(r, "file", file, {
        "Content-Type": file.type || "application/octet-stream",
        "X-Mesa-Name": encodeURIComponent(name),
      }, "已送到", task)(done);
    };
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
    var task = function (done) {
      send(r, "text", text, { "Content-Type": "text/plain; charset=utf-8" }, "已送到", task)(done);
    };
    show(r, "排队中", "", null);
    enqueue(task);
    textEl.value = "";
    sendBtn.disabled = true;
  });

  // 连不上电脑：多半是 Mesa 那边停止了接收（服务随之关闭），或手机 / 电脑换了网络
  var misses = 0;
  function markOffline() {
    statusEl.textContent =
      "连不上电脑了：可能 Mesa 那边已停止接收，或网络变了。要再发，在 Mesa 里重新点「从手机添加」扫码。";
    statusEl.className = "status bad";
  }
  function markOnline() {
    misses = 0;
    statusEl.textContent = okText;
    statusEl.className = "status";
  }
  function poll() {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "state");
    xhr.timeout = 8000;
    xhr.onload = function () {
      if (xhr.status === 200) markOnline();
      else miss();
    };
    xhr.onerror = miss;
    xhr.ontimeout = miss;
    xhr.send();
  }
  function miss() {
    misses += 1;
    if (misses >= 2) markOffline();
  }
  setInterval(poll, POLL_MS);
})();
