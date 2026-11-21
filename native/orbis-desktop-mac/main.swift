// Orbis 桌面输入原生助手（macOS）。
//
// 零第三方依赖：只链接系统框架 CoreGraphics / ApplicationServices / AppKit。
// 协议：从 stdin 读一个 UTF-8 JSON，向 stdout 写一个 UTF-8 JSON。
// 为什么用 stdin 而不是 argv：文本里可能带引号、反引号、换行、中文，
// 走命令行参数要经过两层转义（shell + JSON），是 bug 的温床。
//
// ## 坐标一律是「点」（points），左上角原点
//
//   CGDisplayBounds / CGEventGetLocation / CGWarpMouseCursorPosition /
//   CGEventCreateMouseEvent 全部是同一套坐标 —— 点、左上原点。
//
//   绝不用 NSEvent.mouseLocation（左下原点，y 轴镜像），
//   也绝不把点乘 2 换成像素（Retina 上那样会整体偏移一倍且不报错）。
//
// ## 授权
//
//   perform 的第一件事是 AXIsProcessTrusted()。没有它，CGEventPost 会
//   静默丢弃事件 —— 我们会以为发出去了，实际什么都没发生。
//   所以宁可直接返回 not_authorized，也不发一个"看起来成功"的输入。
//   不在 perform 里弹授权窗（规格要求：不绕过系统保护，明确交还用户）。

import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

// MARK: - 协议层

func readRequest() -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty,
          let obj = try? JSONSerialization.jsonObject(with: data),
          let dict = obj as? [String: Any] else { return [:] }
    return dict
}

func emit(_ dict: [String: Any]) {
    let payload: [String: Any] = dict
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"code\":\"call_failed\",\"text\":\"JSON 编码失败\"}")
        return
    }
    print(text)
}

func fail(_ code: String, _ text: String) -> [String: Any] {
    return ["ok": false, "code": code, "text": text]
}

func num(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String, let d = Double(s) { return d }
    return nil
}

// MARK: - 授权与屏幕

func authorized() -> Bool {
    return AXIsProcessTrusted()
}

/// 虚拟桌面矩形（多屏拼起来，左屏在左边时 x 为负）+ 最大缩放 + 会话状态。
func probeEnvironment() -> [String: Any] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        return fail("call_failed", "拿不到活动显示器列表")
    }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
        return fail("call_failed", "读取显示器信息失败")
    }

    var minX = Double.greatestFiniteMagnitude
    var minY = Double.greatestFiniteMagnitude
    var maxX = -Double.greatestFiniteMagnitude
    var maxY = -Double.greatestFiniteMagnitude
    var maxScale = 1.0
    for id in ids.prefix(Int(count)) {
        let r = CGDisplayBounds(id)
        if r.width <= 0 || r.height <= 0 { continue }
        minX = min(minX, Double(r.minX))
        maxX = max(maxX, Double(r.maxX))
        minY = min(minY, Double(r.minY))
        maxY = max(maxY, Double(r.maxY))
        let pw = Double(CGDisplayPixelsWide(id))
        if pw > 0 { maxScale = max(maxScale, pw / Double(r.width)) }
    }
    if !(maxX > minX && maxY > minY) {
        return fail("call_failed", "显示器矩形为空（可能没有登录会话）")
    }

    var session = false
    var locked = false
    if let info = CGSessionCopyCurrentDictionary() as NSDictionary? {
        locked = (info["CGSSessionScreenIsLocked"] as? Bool) ?? false
        let onConsole = (info["kCGSSessionOnConsoleKey"] as? Bool) ?? false
        session = onConsole && !locked
    }

    return [
        "ok": true,
        "screen": ["x": minX, "y": minY, "width": maxX - minX, "height": maxY - minY],
        // dpi 只为与 Windows 的返回形状对齐；任何逻辑都不靠它换算
        "dpi": Int((maxScale * 96).rounded()),
        "session": session,
        "locked": locked,
        "authorized": authorized(),
    ]
}

/// 距最后一次任意输入过了多少秒。负数/非有限值表示探针不可用。
func lastInputAgoSeconds() -> Double {
    let anyInput = CGEventType(rawValue: ~0 as UInt32)!
    return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
}

func cursorPosition() -> CGPoint? {
    guard let ev = CGEvent(source: nil) else { return nil }
    return ev.location
}

// MARK: - 前台窗口标题（审计用，只记标题不记内容）

/// 前台窗口标题（审计用：只记标题，不记窗口内容）。
///
/// 实机结论：`AXUIElementCreateSystemWide()` + `kAXFocusedApplicationAttribute`
/// 在本进程里返回 -25204（kAXErrorCannotComplete）—— 系统级焦点查询要求进程是
/// 交互式 GUI 客户端，从终端 / 宿主 App 里 spawn 出来的助手拿不到。
///
/// 改用 NSWorkspace 拿前台应用（不依赖 AX 系统级权限），再按 pid 用
/// AXUIElementCreateApplication 读它自己的窗口标题。实机验证：
///   · 靶子 → "orbis_target3 — Orbis Input Target"
///   · Orbis.app → "Orbis — Orbis"
/// 没有辅助功能授权时退化为只报应用名，不报错（审计可以没有窗口标题）。
func focusedAppTitle() -> String {
    guard let app = NSWorkspace.shared.frontmostApplication else { return "" }
    let name = app.localizedName ?? ""
    guard authorized() else { return name }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var windowRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
       let win = windowRef {
        var titleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(win as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success,
           let t = titleRef as? String, !t.isEmpty {
            return name.isEmpty ? t : "\(name) — \(t)"
        }
    }
    return name
}

// MARK: - 键码表（CGKeyCode：硬件扫描码，与 Win32 虚拟键码完全不是一回事）

let keyCodeTable: [String: CGKeyCode] = [
    // 修饰键
    "ctrl": 0x3B, "control": 0x3B,
    "shift": 0x38,
    "alt": 0x3A, "option": 0x3A,
    "cmd": 0x37, "command": 0x37, "meta": 0x37, "win": 0x37,
    // 编辑 / 导航
    "enter": 0x24, "return": 0x24,
    "tab": 0x30,
    "esc": 0x35, "escape": 0x35,
    "space": 0x31,
    "backspace": 0x33,
    "delete": 0x75, "del": 0x75,
    "insert": 0x72,
    "left": 0x7B, "right": 0x7C, "up": 0x7E, "down": 0x7D,
    "home": 0x73, "end": 0x77,
    "pageup": 0x74, "pagedown": 0x79,
    // 功能键
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61,
    "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    // 字母（ANSI 布局的物理位置，全 26 个）
    "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E, "f": 0x03, "g": 0x05,
    "h": 0x04, "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D,
    "o": 0x1F, "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11, "u": 0x20,
    "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10, "z": 0x06,
    // 数字（主键盘区）
    "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
]

/// 修饰键 → CGEventFlags
let modifierFlags: [String: CGEventFlags] = [
    "ctrl": .maskControl, "control": .maskControl,
    "shift": .maskShift,
    "alt": .maskAlternate, "option": .maskAlternate,
    "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand, "win": .maskCommand,
]

func keyCode(_ name: String) -> CGKeyCode? {
    return keyCodeTable[name.trimmingCharacters(in: .whitespaces).lowercased()]
}

func modifierFlag(_ name: String) -> CGEventFlags? {
    return modifierFlags[name.trimmingCharacters(in: .whitespaces).lowercased()]
}

// MARK: - 合成输入

let eventSource = CGEventSource(stateID: .hidSystemState)

/// 按顺序投递一个键事件；flags 是「此刻」的修饰键状态。
func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let ev = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down) else { return }
    ev.flags = flags
    ev.post(tap: .cghidEventTap)
    usleep(18_000)
}

/// 组合键：修饰键按下时 flag 要**逐步累加**。
///
/// 这是实机踩出来的：只给主键设 flags、修饰键本身带空 flags，
/// 系统会把它当成「打了一个单独的字母」，cmd+V 会打出 v 而不是粘贴。
func postCombo(modifiers: [String], key: String) -> [String: Any] {
    guard let code = keyCode(key) else {
        return fail("invalid", "不认识的键「\(key)」（macOS 侧不猜键码）")
    }
    var flags: CGEventFlags = []
    var applied: [CGEventFlags] = []
    for name in modifiers {
        guard let f = modifierFlag(name) else {
            return fail("invalid", "不认识的修饰键「\(name)」")
        }
        flags.insert(f)
        applied.append(f)
        postKey(codeForModifier(f), down: true, flags: flags)
    }
    postKey(code, down: true, flags: flags)
    postKey(code, down: false, flags: flags)
    for f in applied.reversed() {
        flags.remove(f)
        postKey(codeForModifier(f), down: false, flags: flags)
    }
    return ["ok": true]
}

/// CGEventFlags → 那个修饰键自己的 keyCode（松开时要用同一个键码）
func codeForModifier(_ flag: CGEventFlags) -> CGKeyCode {
    switch flag {
    case .maskCommand: return 0x37
    case .maskShift: return 0x38
    case .maskControl: return 0x3B
    case .maskAlternate: return 0x3A
    default: return 0x37
    }
}

/// 移动光标并复核。
///
/// 实机实测（本机 macOS 15.5 / 2560x1440 / 1x）：`CGWarpMouseCursorPosition`
/// 落位误差 **0.0 点**（5 个目标点 5/5 精确）。所以容差用 0.5 ——
/// 只吸收浮点抖动，不放任真实偏移。Windows 那边的 24px 在 macOS 上不成立，
/// 照抄会掩盖真问题。
let cursorTolerance = 0.5
let moveAttempts = 3

func warpAndVerify(_ target: CGPoint) -> [String: Any] {
    var last = CGPoint.zero
    for attempt in 0..<moveAttempts {
        CGWarpMouseCursorPosition(target)
        // 移动后必须重新关联，否则光标会和物理鼠标「脱钩」
        CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
        usleep(attempt == 0 ? 30_000 : 60_000)
        guard let now = cursorPosition() else {
            return fail("call_failed", "读不到光标位置")
        }
        last = now
        let dx = abs(now.x - target.x)
        let dy = abs(now.y - target.y)
        if dx <= cursorTolerance && dy <= cursorTolerance {
            return ["ok": true, "at": ["x": now.x, "y": now.y]]
        }
    }
    return fail("call_failed",
                "光标没能落到目标位置（想去 \(fmt(target.x)),\(fmt(target.y))，实际 \(fmt(last.x)),\(fmt(last.y))）—— 可能有别的程序在动光标，本轮不点击")
}

func fmt(_ v: Double) -> String {
    return String(format: "%.1f", v)
}

func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, clickState: Int64) {
    guard let ev = CGEvent(mouseEventSource: eventSource, mouseType: type,
                           mouseCursorPosition: point, mouseButton: button) else { return }
    ev.setIntegerValueField(.mouseEventClickState, value: clickState)
    ev.post(tap: .cghidEventTap)
}

func doClick(_ point: CGPoint, button: CGMouseButton, clicks: Int) -> [String: Any] {
    let downType: CGEventType
    let upType: CGEventType
    switch button {
    case .right: downType = .rightMouseDown; upType = .rightMouseUp
    case .center: downType = .otherMouseDown; upType = .otherMouseUp
    default: downType = .leftMouseDown; upType = .leftMouseUp
    }
    let n = max(1, min(clicks, 3))
    for i in 1...n {
        postMouse(downType, at: point, button: button, clickState: Int64(i))
        usleep(25_000)
        postMouse(upType, at: point, button: button, clickState: Int64(i))
        usleep(35_000)
    }
    return ["ok": true]
}

/// 滚动：与 Windows 对齐，「正 = 向上」。
///
/// CGEventCreateScrollWheelEvent 的 wheel1 正数向**上**滚（内容向下移动），
/// 与 Win32 的 WHEEL_DELTA 同号，所以直接传，不取反。
func doScroll(_ delta: Int) -> [String: Any] {
    guard let ev = CGEvent(scrollWheelEvent2Source: eventSource, units: .line,
                           wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else {
        return fail("call_failed", "创建滚轮事件失败")
    }
    ev.post(tap: .cghidEventTap)
    return ["ok": true]
}

/// 文本输入：走剪贴板 + cmd+V。
///
/// 三个实机结论：
///   1. 必须用 NSPasteboard。`pbcopy` 在 C/POSIX locale 下会把中文写成空串
///      （实机复现：23 字节的 UTF-8 载荷 pbcopy 后 pbpaste 是空的）；
///   2. 必须发 **cmd+V**。发 ctrl+V 什么都不会发生（NSTextField 不响应）；
///   3. 目标窗口必须有 Edit 菜单 —— cmd+V 走的是菜单 keyEquivalent，
///      没有菜单项时事件不会变成 paste: 动作（实机复现：加菜单前不粘贴，加完立刻好）。
///      这是宿主应用的事，我们在失败时如实报告即可。
func doTypeText(_ text: String) -> [String: Any] {
    let pb = NSPasteboard.general
    // ★ 备份要按 NSPasteboardItem 全量备份，不能只存纯文本。
    //
    //   用户剪贴板里可能是一张截图、一个文件、或者带富文本的段落 ——
    //   `string(forType: .string)` 对它们返回 nil，粘完再清空剪贴板，
    //   用户原本复制的东西就没了。逐 item 备份每种 (type, Data)，粘完原样写回。
    let backup: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
        item.types.compactMap { type in
            guard let data = item.data(forType: type) else { return nil }
            return (type, data)
        }
    }

    pb.clearContents()
    let set = pb.setString(text, forType: .string)
    if !set {
        restorePasteboard(backup)
        return fail("call_failed", "写剪贴板失败")
    }
    usleep(60_000)
    let comboResult = postCombo(modifiers: ["cmd"], key: "v")
    // 等目标应用把内容取走，再还原 —— 用户剪贴板里可能是他正在搬的东西
    usleep(350_000)
    restorePasteboard(backup)
    if comboResult["code"] != nil {
        return comboResult
    }
    return ["ok": true]
}

/// 把之前备份的剪贴板逐 item 写回去（备份为空就只清空）。
func restorePasteboard(_ backup: [[(NSPasteboard.PasteboardType, Data)]]) {
    let pb = NSPasteboard.general
    pb.clearContents()
    if backup.isEmpty { return }
    let items: [NSPasteboardItem] = backup.map { pairs in
        let item = NSPasteboardItem()
        for (type, data) in pairs {
            item.setData(data, forType: type)
        }
        return item
    }
    pb.writeObjects(items)
}

// MARK: - 命令分发

/// perform 的总入口：先判授权，再分派。
///
/// 授权检查必须排在**所有**平台调用之前：没有辅助功能授权时
/// CGEventPost 会静默丢弃，我们会以为发成功了。
func doPerform(_ req: [String: Any]) -> [String: Any] {
    guard authorized() else {
        return fail("not_authorized",
                    "需要「辅助功能」授权：系统设置 → 隐私与安全性 → 辅助功能，把 Orbis 打开后重试")
    }
    guard let action = (req["action"] as? String)?.trimmingCharacters(in: .whitespaces).lowercased(),
          !action.isEmpty else {
        return fail("invalid", "没有 action")
    }

    let foreground = focusedAppTitle()

    // 拖拽要「按下—分步移动—每步检测接管—中断必松键」的完整链路，
    // 本轮没有做完实机验证，所以明确拒绝 —— 绝不留半截按着鼠标不放。
    if action == "drag" {
        return fail("invalid", "拖拽还没有完整实现（按下—移动—抬起的中断恢复未验证），本轮不支持")
    }

    var result: [String: Any]
    switch action {
    case "move":
        guard let point = readPoint(req["point"]) else {
            return fail("invalid", "move 需要 point{x,y}")
        }
        result = warpAndVerify(point)
    case "click":
        guard let point = readPoint(req["point"]) else {
            return fail("invalid", "click 需要 point{x,y}")
        }
        // 先移到位并复核，**到位之前绝不点击**
        let moved = warpAndVerify(point)
        if moved["ok"] as? Bool != true { return moved }
        let actual = moved["at"] as? [String: Double] ?? ["x": point.x, "y": point.y]
        let btnName = (req["button"] as? String)?.lowercased() ?? "left"
        let button: CGMouseButton
        switch btnName {
        case "right": button = .right
        case "middle", "center": button = .center
        case "left": button = .left
        default: return fail("invalid", "不认识的鼠标键「\(btnName)」")
        }
        let clicks = Int(num(req["clicks"]) ?? 1)
        let clicked = doClick(CGPoint(x: actual["x"] ?? point.x, y: actual["y"] ?? point.y),
                              button: button, clicks: clicks)
        if clicked["ok"] as? Bool != true { return clicked }
        result = ["ok": true, "at": moved["at"] ?? ["x": point.x, "y": point.y]]
    case "scroll":
        let delta = Int(num(req["delta"]) ?? 0)
        if delta == 0 { return fail("invalid", "scroll 的 delta 不能是 0") }
        // 可选坐标：先移到位再滚。
        //
        // macOS 的滚轮事件发给「鼠标指针下那个窗口」—— 不先移动就会滚到
        // 光标上次停留的无关窗口。JS 侧 planInput 允许 scroll 带 point，
        // 这里收到就照样做，并像 move/click 一样复核落点。
        if let scrollPoint = readPoint(req["point"]) {
            let moved = warpAndVerify(scrollPoint)
            if moved["ok"] as? Bool != true { return moved }
            let scrolled = doScroll(delta)
            if scrolled["ok"] as? Bool != true { return scrolled }
            result = ["ok": true, "at": moved["at"] ?? ["x": scrollPoint.x, "y": scrollPoint.y]]
        } else {
            result = doScroll(delta)
        }
    case "key":
        guard let key = (req["key"] as? String)?.trimmingCharacters(in: .whitespaces), !key.isEmpty else {
            return fail("invalid", "key 需要键名")
        }
        result = postCombo(modifiers: [], key: key)
    case "keycombo", "key_combo":
        var keys: [String] = []
        if let raw = req["keys"] as? [String] { keys = raw }
        else if let single = req["keys"] as? String { keys = single.split(separator: "+").map(String.init) }
        guard !keys.isEmpty else { return fail("invalid", "keyCombo 需要 keys") }
        let modifiers = keys.dropLast().map { $0 }
        let mainKey = keys.last!
        result = postCombo(modifiers: modifiers, key: mainKey)
    case "type_text", "typetext", "text", "paste":
        guard let text = req["text"] as? String, !text.isEmpty else {
            return fail("invalid", "type_text 需要非空 text")
        }
        result = doTypeText(text)
    default:
        return fail("invalid", "不认识的动作「\(action)」")
    }

    if result["ok"] as? Bool == true {
        result["foreground"] = foreground
    }
    return result
}

/// 把任意数值参数夹到 Int 安全范围（避免溢出崩溃）
func clampInt(_ raw: Double?, fallback: Int) -> Int {
    guard let v = raw, v.isFinite else { return fallback }
    return Int(v.rounded())
}

func readPoint(_ raw: Any?) -> CGPoint? {
    guard let d = raw as? [String: Any] else { return nil }
    guard let x = num(d["x"]), let y = num(d["y"]) else { return nil }
    return CGPoint(x: x, y: y)
}

/// 连续采样若干次，把「每次的 idleMs + 光标位置」原样交给 JS 侧判据。
/// 判据（classifyInputNoise）是平台无关的纯逻辑，这里不重写。
func doNoise(_ req: [String: Any]) -> [String: Any] {
    let samples = max(1, min(clampInt(num(req["samples"]), fallback: 5), 20))
    let intervalMs = max(20, min(clampInt(num(req["intervalMs"]), fallback: 120), 2000))
    var out: [[String: Any]] = []
    for i in 0..<samples {
        let ago = lastInputAgoSeconds()
        let cur = cursorPosition() ?? CGPoint.zero
        out.append([
            "idleMs": max(0, ago * 1000.0),
            "cursor": ["x": cur.x, "y": cur.y],
            "at": Date().timeIntervalSince1970 * 1000.0,
        ])
        if i < samples - 1 { usleep(useconds_t(intervalMs * 1000)) }
    }
    return ["ok": true, "samples": out]
}

// MARK: - main

let argv = CommandLine.arguments
let command = argv.count > 1 ? argv[1].lowercased() : ""
let req = readRequest()

switch command {
case "probe":
    emit(probeEnvironment())
case "last-input", "lastinput":
    let ago = lastInputAgoSeconds()
    if !ago.isFinite || ago < 0 {
        emit(fail("probe_unavailable", "CGEventSourceSecondsSinceLastEventType 返回了不可用的值（\(ago)）"))
    } else {
        emit(["ok": true, "agoSeconds": ago, "authorized": authorized()])
    }
case "cursor":
    if let p = cursorPosition() {
        emit(["ok": true, "x": p.x, "y": p.y])
    } else {
        emit(fail("call_failed", "读不到光标位置"))
    }
case "foreground":
    emit(["ok": true, "title": focusedAppTitle(), "authorized": authorized()])
case "perform":
    emit(doPerform(req))
case "noise":
    emit(doNoise(req))
case "version":
    emit(["ok": true, "version": "1.0.0", "protocol": 1])
default:
    emit(fail("invalid", "不认识的命令「\(command)」（支持 probe / last-input / cursor / foreground / perform / noise / version）"))
}

