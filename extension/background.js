// Mesa 文献收货 service worker（通道 C）：content → native messaging → mesa_helper。
// 每次保存一条连接（MV3 service worker 生命周期短，不维持长连接）。
// chrome.runtime.connectNative 的 postMessage 直接发对象，封帧由浏览器完成。
//
// MV3 铁律（2026-09-17 踩坑修正）：事件监听必须注册在 **worker 顶层**——写在
// onInstalled 里会在 worker 休眠唤醒后消失（badge/PDF 检测全失效）。
// pdfTabs 是内存态：worker 休眠会丢，丢了只是角标暂时不亮，点图标仍走页内路径
// （content script 会在 PDF 页自报，见下）。
const HOST = 'dev.ccode.mesa';
const pdfTabs = new Map();

// Uint8Array → base64（与 content.js 的 b64 同款分块实现；MV3 无共享模块，保持双份）
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(s);
}

// 角标全防御（个别环境 action API 未就绪时不允许 worker 回调抛错）
function badge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ tabId, text });
    if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) {}
}

// 后台代取的同源门禁（纯函数，tests/extension.test.ts 直测）：只允许代取与
// 发起页同源的地址——页面可伪造 citation_pdf_url 指向内网/第三方需登录接口，
// 跨源代取等于用浏览器凭据替页面发起它自己（受 CORS）发不了的请求
// 同一个站点（注册域相同，https）才代取：Wiley 学会刊的落地页在 chemistry-europe.onlinelibrary.wiley.com，
// PDF 在 onlinelibrary.wiley.com，严格同源会被挡（2026-11-09 HER 实测「跨源地址不代取」）
function siteOf(host) {
  var parts = host.toLowerCase().split('.');
  var n = parts.length;
  if (n <= 2) return host.toLowerCase();
  // co.uk / ac.cn / com.cn 这类二级后缀多取一段
  var second = parts[n - 2];
  var take = parts[n - 1].length === 2 && /^(co|ac|com|edu|org|gov|net)$/.test(second) ? 3 : 2;
  return parts.slice(n - take).join('.');
}
function allowedFetchTarget(targetUrl, senderUrl) {
  try {
    var target = new URL(targetUrl);
    var page = senderUrl ? new URL(senderUrl) : null;
    if (!page) return false;
    if (target.origin === page.origin) return true;
    return target.protocol === 'https:' && page.protocol === 'https:' && siteOf(target.hostname) === siteOf(page.hostname);
  } catch (_) {
    return false;
  }
}

// 出版商网页上点的下载，保存位置由浏览器决定。系统「下载」文件夹只是其中一处：
// 用户改过默认目录，或每次另选位置，目录监听看不见。Chrome 的 downloads 能给出
// 最终绝对路径，完成后一律上报；收货端仍按 90 秒窗口和文件名决定归哪一篇。
const reportedDownloads = new Map();
function watchOwnDownload(downloadId) {
  reportedDownloads.set(downloadId, true);
  if (reportedDownloads.size > 64) {
    reportedDownloads.delete(reportedDownloads.keys().next().value);
  }
}
chrome.downloads.onCreated.addListener((item) => {
  if (item && item.id != null) watchOwnDownload(item.id);
});
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || delta.state == null || delta.state.current !== 'complete') return;
  const id = delta.id;
  if (!reportedDownloads.delete(id)) return;
  try {
    chrome.downloads.search({ id }, (items) => {
      const item = items && items[0];
      if (!item) return;
      // 站方对「下载式请求」回网页（SD 型反爬，2026-09-17 用户实测：点图标得到
      // 一个 html）：删掉这个垃圾文件并指路页内按钮——它有完整会话上下文
      const mime = (item.mime || '').toLowerCase();
      if (mime.indexOf('html') >= 0) {
        try { void chrome.downloads.removeFile(id); } catch (_) {}
        notifyFailure('站方给了网页而不是 PDF（下载被拦）——回到文章页点右下角「存到 Mesa」，或用浏览器菜单手动另存');
        return;
      }
      // DownloadItem 的绝对本地路径字段是 filename（finalPath 不存在——终检
      // 抓出：取错字段导致上报链静默空转）
      const path = item.filename;
      if (!path) return;
      let port;
      try {
        port = chrome.runtime.connectNative(HOST);
      } catch (_) {
        return;
      }
      const finish = () => { try { port.disconnect(); } catch (_) {} };
      port.onMessage.addListener(finish);
      port.onDisconnect.addListener(finish);
      try {
        port.postMessage({ kind: 'mesa-report-download', path });
      } catch (_) {
        finish();
        return;
      }
      setTimeout(finish, 5000);
    });
  } catch (_) {}
});

// 观察型 webRequest（MV3 允许非阻塞监听）：识别主框架 PDF 响应 → 图标亮角标
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.type !== 'main_frame') return;
    const ct = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === 'content-type',
    );
    const pdf = ct && /application\/pdf/i.test(ct.value || '');
    if (pdf) {
      pdfTabs.set(details.tabId, details.url);
      badge(details.tabId, 'PDF', '#1c6b2d');
    } else {
      // 无条件清角标（2026-09-17 修正）：badge 状态跨 worker 重启存活而 pdfTabs
      // 内存态不存活——按 pdfTabs.has 条件清理会在重启后留下永久 'PDF' 死角标；
      // 空串 setBadgeText 是幂等无害操作
      pdfTabs.delete(details.tabId);
      badge(details.tabId, '');
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  pdfTabs.delete(tabId);
});

// 图标点击失败的临时角标 + 系统通知（2026-09-17 审计：content 精心构造的
// {ok:false,error} 回包被 await 后丢弃，用户在无 citation_doi 的文章页反复点
// 图标零反应，只会认为按钮坏了）
function notifyFailure(text) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: '存到 Mesa',
      message: text || '这页没检出可保存的文献',
    });
  } catch (_) {}
}

// 工具栏图标点击：有页内按钮就走同一条「存到 Mesa」（页内 fetch 带真实会话）。
// 旧口径 PDF 页先 chrome.downloads——出版商对下载式请求常回 HTML（SD 型），
// 完成后又按 mime 删掉，用户只看见「已删除」。downloads 只在没有 content
// script 时作末路（Chrome 内置 PDF 查看器不注内容脚本）。
// 全防御：个别环境下 API/权限未生效时点图标静默无效，不允许 worker 崩
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab || tab.id == null) return;
    if (chrome.tabs && chrome.tabs.sendMessage) {
      let resp = null;
      try {
        resp = await chrome.tabs.sendMessage(tab.id, { kind: 'mesa-save-from-icon' });
      } catch (_) {
        /* 页面没有 content script（如纯 PDF 查看器/blob: 页） */
      }
      if (resp && resp.ok === true) return;
      if (resp && resp.ok === false) {
        badge(tab.id, '!', '#b3261e');
        setTimeout(() => { if (!pdfTabs.has(tab.id)) badge(tab.id, ''); }, 6000);
        notifyFailure(resp.error);
        return;
      }
    }
    const pdfUrl = pdfTabs.get(tab.id);
    if (pdfUrl && chrome.downloads && chrome.downloads.download) {
      try {
        const dlId = await chrome.downloads.download({ url: pdfUrl });
        if (dlId != null) watchOwnDownload(dlId);
      } catch (_) {
        // 用户取消另存对话框 / 下载被浏览器拦下：尊重用户意图
      }
      return;
    }
    const isHttp = tab.url && /^https?:/i.test(tab.url);
    if (isHttp) {
      badge(tab.id, '!', '#b3261e');
      setTimeout(() => { if (!pdfTabs.has(tab.id)) badge(tab.id, ''); }, 6000);
      notifyFailure('这页没有 Mesa 的保存按钮（PDF 查看器/blob 页）——用页面自带下载，Mesa 会自动收进');
    }
  } catch (_) {
    /* 全防御：不允许 worker 崩 */
  }
});

// content script 在 PDF 查看器页自报地址（worker 唤醒后 pdfTabs 为空时的补位）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === 'mesa-pdf-page' && sender.tab && sender.tab.id != null) {
    pdfTabs.set(sender.tab.id, sender.tab.url || msg.url);
    badge(sender.tab.id, 'PDF', '#1c6b2d');
    sendResponse({ ok: true });
    return false;
  }
  // 内容脚本跨源 fetch 被 CORS 拦下时的回退：后台 service worker 受
  // host_permissions 豁免可代取字节（Cookie 口径可能不同，尽力而为）。
  // 仅放行与发起页同源的地址（2026-09-17 审计）：页面可伪造 citation_pdf_url
  // 指向内网/第三方需登录接口——跨源代取等于用浏览器凭据替页面发起它自己
  // （受 CORS）发不了的请求，字节再经 %PDF 校验落盘
  // 大文件改道（终检二轮补）：content 侧 >40MB 的 PDF 不走 base64 桥（Chrome
  // 单条 native 消息限 64MiB），改由这里用 downloads API 下载——跨源也能下
  // （页内 a[download] 对跨源 href 无效）、下载 id 进 ownDownloads、完成后路径
  // 直报 Mesa，不受浏览器下载目录影响
  if (msg && msg.kind === 'mesa-big-download' && msg.url) {
    (async () => {
      try {
        if (!chrome.downloads || !chrome.downloads.download) {
          sendResponse({ ok: false, error: '此浏览器不支持 downloads API' });
          return;
        }
        const dlId = await chrome.downloads.download({ url: msg.url });
        if (dlId != null) watchOwnDownload(dlId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }
  if (msg && msg.kind === 'mesa-fetch-url' && msg.url) {
    (async () => {
      try {
        const originUrl = (sender.tab && sender.tab.url) || sender.url || '';
        if (!allowedFetchTarget(msg.url, originUrl)) {
          sendResponse({ ok: false, error: '跨源地址不代取' });
          return;
        }
        // AbortSignal.timeout 需 Chrome 103+（终检提示：88–102 上该 API 不存在、
        // 属性求值抛错会打死整条代取兜底）——能力检测，老浏览器退化为不设超时
        const timeoutSignal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(45000)
          : undefined;
        const r = await fetch(msg.url, {
          credentials: 'include',
          ...(timeoutSignal ? { signal: timeoutSignal } : {}),
        });
        if (!r.ok) { sendResponse({ ok: false, error: 'HTTP ' + r.status }); return; }
        const bytes = new Uint8Array(await r.arrayBuffer());
        sendResponse({ ok: true, bytesB64: b64(bytes) });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true; // 异步 sendResponse
  }
  if (!msg || msg.kind !== 'mesa-save-pdf') return false;
  (async () => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      sendResponse({ ok: false, error: '连不上 Mesa helper（先在 Mesa 设置里安装浏览器桥）' });
      return;
    }
    let done = false;
    const finish = (reply) => {
      if (done) return;
      done = true;
      try { port.disconnect(); } catch (_) {}
      sendResponse(reply);
    };
    port.onMessage.addListener((reply) => finish(reply || { ok: false, error: 'helper 无响应' }));
    port.onDisconnect.addListener(() => {
      if (done) return;
      const last = chrome.runtime.lastError;
      finish({ ok: false, error: (last && last.message) || 'Mesa helper 已断开' });
    });
    port.postMessage(msg);
    // 兜底超时（150s：helper 侧 60MB PDF 解码 + papers/ 全量 md5 查重可超 60s——
    // 旧 60s 会在 helper 实际还在干活时先向用户报失败，2026-09-17 审计）
    setTimeout(() => finish({ ok: false, error: 'Mesa helper 超时' }), 150000);
  })();
  return true; // 异步 sendResponse
});

// ===== 跟 Mesa 打招呼（2026-11-09 改）=====
// Mesa 设置里的「已连接」看扩展来问过没有：每分钟问一次，装好 / 重新加载 / 浏览器启动时立刻问一次。
// 不再在后台标签替人取付费墙全文（2026-11-09 用户拍板：Wiley / RSC 拒脚本请求、Elsevier 封 IP，「根本不可行」）——
// 付费墙由人点 Mesa 里的「官网」自己下，扩展只管「存到 Mesa」按钮和把下载落盘路径报给 Mesa。
const POLL_ALARM = 'mesa-poll-jobs';
chrome.alarms.get(POLL_ALARM, (a) => {
  if (!a) chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a && a.name === POLL_ALARM) void ping();
});
chrome.runtime.onInstalled.addListener(() => void ping());
chrome.runtime.onStartup.addListener(() => void ping());

// 发一条 native 消息、等一条回话（每次一条连接，MV3 不维持长连接）
function nativeCall(msg, timeoutMs) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (_) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (reply) => {
      if (done) return;
      done = true;
      try { port.disconnect(); } catch (_) {}
      resolve(reply);
    };
    port.onMessage.addListener((reply) => finish(reply || null));
    port.onDisconnect.addListener(() => finish(null));
    try {
      port.postMessage(msg);
    } catch (_) {
      finish(null);
      return;
    }
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function ping() {
  try {
    await nativeCall({ kind: 'mesa-poll-jobs' }, 10000);
  } catch (_) {
    /* 全防御 */
  }
}
