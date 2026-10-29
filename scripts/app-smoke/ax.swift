// 打包版点验用的无障碍（Accessibility）驱动：按进程号找 Mesa 窗口，读界面文字、按文字找控件并「按下」。
// 走 AXUIElement 的 AXPress，不移动鼠标、不发键盘事件、不要求窗口在最前——不会点进别的应用。
// 运行它的终端 / 应用要在「系统设置 → 隐私与安全性 → 辅助功能」里打开。
//
// 用法（smoke.sh 会先编译成二进制）：
//   ax tree  <pid> [最大深度]          打出控件树（角色 | 标题 | 说明 | 值），摸界面结构用
//   ax texts <pid>                     打出窗口里所有文字（一行一段），判有没有报错页
//   ax press <pid> <文字> [--nth N] [--role 角色] [--exact]
//                                      按下第 N 个（从 1 数）标题/说明/值含该文字的控件；按不下就往上找能按的祖先
//   ax wait  <pid> <文字> <秒>         等文字出现；超时退出码 1
//   ax gone  <pid> <文字> <秒>         等文字消失；超时退出码 1
//   ax menu  <pid> <文字>              对控件弹右键菜单
//   ax shot  <pid> <png>               截该进程最上面那个窗口（被遮挡也能截）
//   ax raise <pid>                     把窗口挪到最前（不抢键盘焦点之外的东西）
import AppKit
import ApplicationServices
import Foundation

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String {
    guard let v = attr(el, name) else { return "" }
    if let s = v as? String { return s }
    if let a = v as? NSAttributedString { return a.string }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

struct Node {
    let el: AXUIElement
    let depth: Int
    var role: String { str(el, kAXRoleAttribute) }
    var title: String { str(el, kAXTitleAttribute) }
    var desc: String { str(el, kAXDescriptionAttribute) }
    var value: String { str(el, kAXValueAttribute) }
    var help: String { str(el, kAXHelpAttribute) }
    var label: String { [title, desc, value].filter { !$0.isEmpty }.joined(separator: " | ") }
}

func walk(_ root: AXUIElement, maxDepth: Int = 80, _ visit: (Node) -> Bool) {
    var stack: [(AXUIElement, Int)] = [(root, 0)]
    var seen = 0
    while let (el, d) = stack.popLast() {
        seen += 1
        if seen > 60000 { return }
        if !visit(Node(el: el, depth: d)) { return }
        if d < maxDepth {
            for c in children(el).reversed() { stack.append((c, d + 1)) }
        }
    }
}

func windows(_ pid: pid_t) -> [AXUIElement] {
    // AXWindows 有时只回一个 AXApplication（2026-10-29 沙盒实例实测），主窗口另从 AXMainWindow / AXFocusedWindow 取
    let app = AXUIElementCreateApplication(pid)
    var out: [AXUIElement] = []
    var cands = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    for k in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
        if let w = attr(app, k) { cands.append(w as! AXUIElement) }
    }
    for w in cands where str(w, kAXRoleAttribute) == kAXWindowRole && !out.contains(where: { CFEqual($0, w) }) {
        out.append(w)
    }
    return out
}

func allNodes(_ pid: pid_t) -> [Node] {
    var out: [Node] = []
    for w in windows(pid) { walk(w) { out.append($0); return true } }
    return out
}

func matches(_ n: Node, _ text: String, exact: Bool, role: String?) -> Bool {
    if let role, n.role != role { return false }
    for s in [n.title, n.desc, n.value, n.help] where !s.isEmpty {
        if exact ? s == text : s.contains(text) { return true }
    }
    return false
}

func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
    return list
}

func parent(_ el: AXUIElement) -> AXUIElement? {
    guard let p = attr(el, kAXParentAttribute) else { return nil }
    return (p as! AXUIElement)
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[2]) else { fail("用法见文件头注释") }
guard AXIsProcessTrusted() else { fail("没有辅助功能权限：系统设置 → 隐私与安全性 → 辅助功能，打开运行本命令的终端/应用") }

switch args[1] {
case "tree":
    let maxDepth = args.count > 3 ? Int(args[3]) ?? 80 : 80
    for w in windows(pid) {
        walk(w, maxDepth: maxDepth) { n in
            let pad = String(repeating: "  ", count: n.depth)
            print("\(pad)\(n.role) | \(n.label)")
            return true
        }
    }
case "texts":
    var last = ""
    for n in allNodes(pid) {
        for s in [n.title, n.desc, n.value] where !s.isEmpty && s != last {
            print(s.replacingOccurrences(of: "\n", with: " ⏎ "))
            last = s
        }
    }
case "press":
    guard args.count >= 4 else { fail("press 要给文字") }
    let text = args[3]
    var nth = 1, role: String? = nil, exact = false
    var i = 4
    while i < args.count {
        switch args[i] {
        case "--nth": nth = Int(args[i + 1]) ?? 1; i += 2
        case "--role": role = args[i + 1]; i += 2
        case "--exact": exact = true; i += 1
        default: fail("未知参数 \(args[i])")
        }
    }
    let hits = allNodes(pid).filter { matches($0, text, exact: exact, role: role) }
    guard hits.count >= nth else { fail("找不到第 \(nth) 个「\(text)」（共 \(hits.count) 个）") }
    var target: AXUIElement? = hits[nth - 1].el
    while let t = target, !actions(t).contains(kAXPressAction) { target = parent(t) }
    guard let t = target else { fail("「\(text)」及其祖先都不能按") }
    let err = AXUIElementPerformAction(t, kAXPressAction as CFString)
    guard err == .success else { fail("按「\(text)」失败：AXError \(err.rawValue)") }
    print("按下：\(Node(el: t, depth: 0).role) | \(Node(el: t, depth: 0).label)")
case "wait", "gone":
    guard args.count >= 5, let secs = Double(args[4]) else { fail("\(args[1]) 要给文字和秒数") }
    let want = args[1] == "wait"
    let deadline = Date().addingTimeInterval(secs)
    repeat {
        let present = allNodes(pid).contains { matches($0, args[3], exact: false, role: nil) }
        if present == want { exit(0) }
        Thread.sleep(forTimeInterval: 0.3)
    } while Date() < deadline
    fail(want ? "等不到「\(args[3])」" : "「\(args[3])」一直不消失")
case "shot":
    guard args.count >= 4 else { fail("shot 要给输出路径") }
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let win = list.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }),
          let num = win[kCGWindowNumber as String] as? Int else { fail("找不到进程 \(pid) 的窗口") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-l", String(num), args[3]]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 { fail("截图失败") }
case "menu":
    // 右键菜单：AXShowMenu 在网页里会派发 contextmenu 事件，应用自绘菜单照常弹出
    guard args.count >= 4 else { fail("menu 要给文字") }
    guard let hit = allNodes(pid).first(where: { matches($0, args[3], exact: false, role: nil) }) else { fail("找不到「\(args[3])」") }
    let err = AXUIElementPerformAction(hit.el, kAXShowMenuAction as CFString)
    guard err == .success else { fail("对「\(args[3])」弹菜单失败：AXError \(err.rawValue)") }
    print("弹出菜单：\(hit.role) | \(hit.label)")
case "raise":
    for w in windows(pid) { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
    NSRunningApplication(processIdentifier: pid)?.activate()
default:
    fail("未知命令 \(args[1])")
}
