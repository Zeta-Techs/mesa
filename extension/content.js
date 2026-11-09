// Mesa 文献收货 content script（通道 C，2026-09-16）
// 设计原则（总思路「让真实浏览器干浏览器的事」）：出版商看到的是真实登录用户
// 的正常页内请求，不触发任何风控分支；扩展只做「取字节 → 送 Mesa」。
// 检测：citation_doi meta（有才是文献页）→ 右下角「存到 Mesa」按钮；
// 取 PDF 地址（2026-09-17 与 Zotero 适配器对齐：SD 专用链整页先于通用启发式）：
//   ① citation_pdf_url meta（多数出版商；直接信，%PDF- 魔数兜底——/pdf 无点
//     结尾的 MDPI/IOP 形态曾被正则误杀）；
//   ② ScienceDirect 文章页整页走专用链：#pdfLink → 内嵌 JSON pdfDownload.
//     urlMetadata（token 直链）→ 内嵌阅读器 → 按 PII 构造 /pdfft?download=true
//     （SD 页内唯一 pdfish 链常是补充材料，通用单链采用会误收）；
//   ③ 通用启发式：DOI 命中链 → 唯一 pdfish <a>（多链不猜）→ pdfish 内嵌；
// fetch(credentials)（跨源被 CORS 拦则回退后台代取）→ %PDF- 魔数 → base64 →
// background → native messaging → mesa_helper → save_paper_bytes 落当前项目 papers/。

(function () {
  if (window.__mesaExtLoaded) return;
  window.__mesaExtLoaded = 1;

  // 2026-09-17 修正：\/pdf\/ 收窄成 \/pdf(\/|\?|#|$)——MDPI/IOP 的 citation_pdf_url
  // 形如 …/22/1/1/pdf?version=…（无点、问号结尾），旧式会被误杀
  var PDFISH = /\.pdf(\?|#|$)|\/pdf(\/|\?|#|$)|pdfft|pdfdirect|getpdf|articlepdf|stamp\.jsp|\/doi\/epdf\//i;

  function pageDoi() {
    var m = document.querySelector('meta[name="citation_doi"], meta[name="dc.Identifier"]');
    var fromMeta = m && m.content ? m.content.replace(/^doi:\s*/i, '').trim() : '';
    if (fromMeta) return fromMeta;
    // PDF 阅读器页没有 citation_doi：从地址里抠（Wiley /doi/pdf/10.x/y 等）
    var href = location.href || '';
    var mm = href.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
    return mm ? mm[0].replace(/[.,;]+$/, '') : '';
  }

  function pageTitle() {
    var sels = [
      'meta[name="citation_title"]',
      'meta[name="dc.Title"]',
      'meta[name="DC.title"]',
      'meta[property="og:title"]',
    ];
    for (var i = 0; i < sels.length; i++) {
      var m = document.querySelector(sels[i]);
      if (m && m.content && m.content.trim()) return m.content.trim();
    }
    return (document.title || '').trim();
  }

  function fixPdfUrl(u) {
    return u ? u.replace('/doi/epdf/', '/doi/pdf/') : u;
  }

  // 浏览器原生 PDF 查看器页（Zotero Connector 同款判定）：页面本身就是 PDF
  function isPdfPage() {
    return document.contentType === 'application/pdf';
  }

  function reportPdfPage() {
    try {
      chrome.runtime.sendMessage({ kind: 'mesa-pdf-page', url: location.href }, () => {
        void chrome.runtime.lastError; // 无接收方时消音
      });
    } catch (e) {}
  }

  // ScienceDirect 三级取链（与 Mesa 内嵌窗 mesaSdPdfUrl 同口径）；strict = 只认
  // 高置信信号（#pdfLink / token 直链），构造式兜底由调用方收尾
  function sdPdfUrl(strict) {
    var m = location.pathname.match(/^\/science\/article\/(?:abs\/)?pii\/([^/?#]+)/i);
    if (!m) return null;
    try {
      var pl = document.getElementById('pdfLink');
      if (pl && pl.href && pl.href !== '#' && PDFISH.test(pl.href)) return pl.href;
    } catch (e) {}
    var scripts = document.querySelectorAll('script[type="application/json"]');
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent || '';
      if (t.indexOf('pdfDownload') < 0) continue;
      // 单个 script 解析失败只跳过它（截断 JSON / 非 JSON 误命中），不弃全扫
      try {
        var data = JSON.parse(t);
        var um = data && data.article && data.article.pdfDownload
          && data.article.pdfDownload.urlMetadata;
        if (um && um.path && um.pii && um.pdfExtension
          && um.queryParams && um.queryParams.md5 && um.queryParams.pid) {
          return location.origin + '/' + um.path + '/' + um.pii + um.pdfExtension
            + '?md5=' + encodeURIComponent(um.queryParams.md5)
            + '&pid=' + encodeURIComponent(um.queryParams.pid);
        }
      } catch (e) {}
    }
    if (strict) return null;
    return location.origin + '/science/article/pii/' + m[1] + '/pdfft?download=true';
  }

  // SD 文章页判定（最窄分支纪律：只认 /science/article/(abs/)?pii/）
  function isSdArticle() {
    return /^\/science\/article\/(?:abs\/)?pii\/[^/?#]+/i.test(location.pathname);
  }

  // 内嵌阅读器扫描（iframe/object/embed 里的 pdfish 地址）。blob:/data: 形态
  // （UUID 路径段永不命中 PDFISH）补一档：元素尺寸可观才算——页内 fetch 对
  // blob:/data: 都拿得到字节（2026-09-17 审计：这类阅读器此前是取链盲区）
  function embeddedPdf() {
    var ems = document.querySelectorAll('iframe[src], object[data], embed[src]');
    for (var k = 0; k < ems.length; k++) {
      var el = ems[k];
      var s = el.src || el.data || '';
      if (!s) continue;
      if (PDFISH.test(s)) return fixPdfUrl(s);
      if ((s.indexOf('blob:') === 0 || s.indexOf('data:') === 0)
        && (el.offsetWidth > 200 || el.offsetHeight > 200)) return s;
    }
    return null;
  }

  function pdfUrl() {
    if (isPdfPage()) return location.href;
    // ① 站方声明的 citation_pdf_url 直接信（不再过 PDFISH——/pdf 无点结尾等形态
    // 曾被误杀）；拿到的是不是 PDF 由 %PDF- 魔数兜底校验
    var m = document.querySelector('meta[name="citation_pdf_url"]');
    if (m && m.content) return fixPdfUrl(m.content);
    // ② ScienceDirect 文章页整页走专用链，不进通用启发式（Zotero 适配器顺序，
    // 2026-09-17 对齐）：SD 页内 pdfish 锚链常是补充材料，通用单链采用会误收。
    // 顺序 = #pdfLink/token 直链 → 内嵌阅读器 → PII 构造兜底
    if (isSdArticle()) {
      var sdt = sdPdfUrl(true);
      if (sdt) return sdt;
      var em = embeddedPdf();
      if (em) return em;
      return sdPdfUrl(false);
    }
    // ③ 通用启发式：DOI 命中链 → 唯一 pdfish 链（多链不猜）→ pdfish 内嵌
    var as = document.querySelectorAll('a[href]');
    var hits = [];
    var seen = {};
    var doi = pageDoi();
    for (var i = 0; i < as.length; i++) {
      var h = fixPdfUrl(as[i].href || '');
      if (!PDFISH.test(h)) continue;
      if (doi && h.indexOf(doi) >= 0) return h;
      if (!seen[h]) { seen[h] = 1; hits.push(h); }
    }
    if (hits.length === 1) return hits[0];
    return embeddedPdf();
  }

  function looksLikePdf(b) {
    return b && b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
  }

  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    return btoa(s);
  }

  var btn = null;

  function status(text, ok) {
    if (!btn) return;
    btn.textContent = text;
    btn.style.opacity = ok === false ? '1' : '.75';
    setTimeout(function () { btn.textContent = '存到 Mesa'; btn.style.opacity = '1'; }, 4000);
  }

  // 取字节：页内 fetch 优先（带真实会话，设计主路径），AbortController 45s 超时
  // （出版商网关挂起时 fetch 数分钟不 settle，按钮会永久卡在「取 PDF 中…」且
  // disabled 无从重试，2026-09-17 审计）。先看 Content-Length：>40MB 的直接走
  // 改道（读 body 会被 45s 超时掐断——abort 同样作用于 arrayBuffer，终检提示）。
  // 跨源被 CORS 拦下时回退请后台 service worker 代取（后台仅放行与发起页同源
  // 的地址，见 background.js）——MV3 起内容脚本 fetch 受页面 CORS 约束，
  // host_permissions 只豁免后台
  var BIG_BYTES = 40 * 1024 * 1024;
  async function fetchBytes(u) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 45000);
    try {
      var r = await fetch(u, { credentials: 'include', signal: ctl.signal });
      if (!r.ok) throw new Error('站点没给文件（HTTP ' + r.status + '）');
      var declared = Number(r.headers.get('content-length') || 0);
      if (declared > BIG_BYTES) {
        // 大文件不读 body：清掉计时器，交 save() 的改道分支处理
        clearTimeout(timer);
        try { if (r.body && r.body.cancel) r.body.cancel(); } catch (_) {}
        return null; // 「已知超限」哨兵——save() 按 declaredValue 传给改道
      }
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('取文件超时（45 秒）');
      var sw = await chrome.runtime.sendMessage({ kind: 'mesa-fetch-url', url: u });
      if (!sw) throw e;
      if (!sw.ok) throw new Error(sw.error || '后台代取失败');
      var s = atob(sw.bytesB64 || '');
      var b = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b;
    } finally {
      clearTimeout(timer);
    }
  }

  async function save() {
    if (!btn) return; // 图标转发等无按钮场景的保险（2026-09-17：btn 为 null 时
    // 旧代码在 btn.disabled 处直接 TypeError，且吞在 unhandled rejection 里）
    btn.disabled = true;
    btn.textContent = '取 PDF 中…';
    try {
      var u = pdfUrl();
      if (!u) { status('这页没检出 PDF 链接', false); return; }
      var bytes = await fetchBytes(u);
      // null = Content-Length 已声明 >40MB（或读到的字节实测超限）：不进 base64
      // 桥（Chrome 发往 native host 的单条消息限 64 MiB，base64 膨胀 ×4/3 后约
      // 48MiB 即被拒发，2026-09-17 审计）。改道 background 的 downloads API：
      // 跨源也能下（不是页内 a[download]——Chrome 对跨源 href 无视 download
      // 属性，会把标签页导航走，终检提示），且下载 id 进 ownDownloads 跟踪、
      // 完成后路径直报 Mesa，不受浏览器下载目录影响
      if (bytes === null || bytes.length > BIG_BYTES) {
        var mb = bytes ? Math.round(bytes.length / 1048576) : '';
        var over60 = bytes ? bytes.length > 60 * 1024 * 1024 : false;
        var dl = await chrome.runtime.sendMessage({ kind: 'mesa-big-download', url: u });
        if (!dl || !dl.ok) { status('✗ 大文件转浏览器下载失败：' + ((dl && dl.error) || '未知'), false); return; }
        status(over60
          ? '文件超过 Mesa 60MB 收货上限——已转浏览器下载留在下载文件夹，请手动放进项目 papers/'
          : '文件较大' + (mb ? '（' + mb + ' MB）' : '') + '，已转浏览器下载——Mesa 会自动收进（扩展直报路径，不受下载目录影响）', true);
        return;
      }
      if (!looksLikePdf(bytes)) { status('拿到的不是 PDF（未订阅？）', false); return; }
      btn.textContent = '传输中…（' + Math.round(bytes.length / 1024) + ' KB）';
      var reply = await chrome.runtime.sendMessage({
        kind: 'mesa-save-pdf',
        doi: pageDoi(),
        title: pageTitle(),
        url: location.href,
        bytesB64: b64(bytes)
      });
      if (reply && reply.ok) {
        // 字节级重复不再静默「成功」（2026-09-17 用户实测：再点一次没有任何
        // 「已有一份」的提示，用户不知道到底存没存上）
        if (reply.dedup) {
          status('papers/ 已有同一份（' + (reply.saved || '') + '），未重复存入'
            + (reply.project ? '（项目 ' + reply.project + '）' : ''), true);
        } else {
          status('✓ 已存进 papers/：' + (reply.saved || '')
            + (reply.project ? '（项目 ' + reply.project + '）' : ''), true);
        }
      } else {
        status('✗ ' + ((reply && reply.error) || 'Mesa 未响应'), false);
      }
    } catch (e) {
      status('✗ 取 PDF 失败：' + (e && e.message ? e.message : e), false);
    } finally {
      btn.disabled = false;
    }
  }

  function ensureButton() {
    if (!document.body || (!pageDoi() && !isPdfPage())) return;
    if (isPdfPage()) reportPdfPage();
    if (btn && document.getElementById('__mesa_save')) return;
    btn = document.createElement('button');
    btn.id = '__mesa_save';
    btn.textContent = '存到 Mesa';
    btn.setAttribute('style',
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:9px 14px;' +
      'border-radius:10px;border:1px solid rgba(140,140,140,.5);background:rgba(28,28,30,.92);' +
      'color:#fff;font:13px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)');
    btn.onclick = save;
    document.body.appendChild(btn);
  }

  // 工具栏图标点击（background 转发）：等同按一次页内按钮。图标是按需入口，
  // 页面可能还没轮到 ensureButton 周期——先补一次；仍无按钮（既无 citation_doi
  // 也不是 PDF 页）如实回失败，不再假成功
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.kind === 'mesa-save-from-icon') {
      ensureButton();
      if (btn) {
        save();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: '这页没检出可保存的文献' });
      }
    }
    return false;
  });

  // SPA 换页/晚渲染都能追上
  setInterval(ensureButton, 2000);
  ensureButton();
})();
