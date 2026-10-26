import Cocoa
import WebKit
// 用法: host <网址或 html 文件>：屏外开一个真 WKWebView 跑页面，等页面写出 window.__result 后打印成一行 JSON。
// 屏外窗口默认被当成被挡住，rAF 停、计时器变慢，所以要关掉遮挡检测（私有接口，只在本机量测用）
let path = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let cfg = WKWebViewConfiguration()
cfg.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 1000), configuration: cfg)
let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
if web.responds(to: sel) {
  let f = unsafeBitCast(web.method(for: sel), to: (@convention(c) (AnyObject, Selector, Bool) -> Void).self)
  f(web, sel, false)
}
let win = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 1100, height: 1000), styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = web
win.orderFrontRegardless()
if path.hasPrefix("http") { web.load(URLRequest(url: URL(string: path)!)) } else { web.loadFileURL(URL(fileURLWithPath: path), allowingReadAccessTo: URL(fileURLWithPath: "/")) }
var tries = 0
Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { t in
  tries += 1
  web.evaluateJavaScript("window.__result ? JSON.stringify(window.__result) : null") { v, e in
    if let s = v as? String { print(s); exit(0) }
    if tries > 150 { print("timeout", e ?? ""); exit(1) }
  }
}
app.run()
