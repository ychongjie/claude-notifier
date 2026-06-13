// Claude Sessions 置顶浮层 —— 左缘抽屉(edge drawer)。
//
// 形态:竖屏副屏左缘常驻一个箭头把手(浮在所有窗口之上,含原生全屏)。
//   点把手 → 面板从左侧滑出并钉住;再点 → 滑回。不失焦自隐(用户选的"点一下钉住,再点才收")。
// 内容:一个无边框浮动 NSPanel,塞个 WKWebView 指向 daemon 的 http://127.0.0.1:8787/panel。
//
// 编译/安装见 build.sh / install.sh。需打成 .app(Info.plist 带 NSAllowsLocalNetworking
// 让 WKWebView 能 load 本地 http;LSUIElement 让它不进 Dock)。

import Cocoa
import WebKit

// ---- 可调参数(改完重新 build.sh) ----
let HANDLE_W: CGFloat = 26      // 把手宽(收起时露在屏左缘的部分;展开时停在屏右缘)
let HANDLE_H: CGFloat = 72      // 把手高(短标签,竖向居中;不再整条全高)
let MAX_H: CGFloat = 760        // 面板高
let TOP_MARGIN: CGFloat = 150   // 距屏幕顶(留出浏览器标题/标签栏,不遮挡)
let BOTTOM_MARGIN: CGFloat = 60 // 距屏幕底(高度上限算入)
let ANIM: TimeInterval = 0.22   // 滑出/滑回动画时长
let PANEL_URL = "http://127.0.0.1:8787/panel"

// 选竖屏副屏:优先"非主屏且竖向(高>宽)";退而求非主屏;再退主屏。
func pickScreen() -> NSScreen {
    let screens = NSScreen.screens
    if let s = screens.first(where: { $0 != NSScreen.main && $0.frame.height > $0.frame.width }) { return s }
    if let s = screens.first(where: { $0 != NSScreen.main }) { return s }
    return NSScreen.main ?? screens.first!
}

// 把手视图:画背景 + 箭头(收起▶ 展开◀),点击切换抽屉。
final class HandleView: NSView {
    var expanded = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?

    override var isFlipped: Bool { false }

    override func draw(_ dirty: NSRect) {
        let b = bounds
        // 背景:半透明深色 + 右侧圆角(贴在面板右边、屏幕左缘)。
        let bg = NSColor(calibratedRed: 0.05, green: 0.07, blue: 0.09, alpha: 0.92)
        bg.setFill()
        let path = NSBezierPath(roundedRect: b, xRadius: 6, yRadius: 6)
        path.fill()
        // 箭头:▶(收起,拉我出来) / ◀(展开,推回去)。
        let cx = b.midX, cy = b.midY, s: CGFloat = 5
        let arrow = NSBezierPath()
        if expanded {
            arrow.move(to: NSPoint(x: cx + s, y: cy + s * 1.6))
            arrow.line(to: NSPoint(x: cx - s, y: cy))
            arrow.line(to: NSPoint(x: cx + s, y: cy - s * 1.6))
        } else {
            arrow.move(to: NSPoint(x: cx - s, y: cy + s * 1.6))
            arrow.line(to: NSPoint(x: cx + s, y: cy))
            arrow.line(to: NSPoint(x: cx - s, y: cy - s * 1.6))
        }
        arrow.lineWidth = 2
        arrow.lineCapStyle = .round
        arrow.lineJoinStyle = .round
        NSColor(calibratedWhite: 0.75, alpha: 1).setStroke()
        arrow.stroke()
    }

    override func mouseDown(with event: NSEvent) { onClick?() }
    // 鼠标悬停时手型,提示可点。
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var panel: NSPanel!
    var webview: WKWebView!
    var handle: HandleView!
    var expanded = false
    var collapsedX: CGFloat = 0
    var expandedX: CGFloat = 0

    func applicationDidFinishLaunching(_ note: Notification) {
        let screen = pickScreen()
        let sf = screen.frame
        // 全屏宽:展开时占满竖屏宽度。把手占右缘 HANDLE_W,内容 = 全宽 - 把手。
        let total = sf.width
        let contentW = total - HANDLE_W
        let h = min(MAX_H, sf.height - TOP_MARGIN - BOTTOM_MARGIN)
        let y = sf.maxY - TOP_MARGIN - h                // 顶部对齐(距顶 TOP_MARGIN)
        collapsedX = sf.minX - contentW                 // 内容滑到屏外左侧,只露出把手(停在屏左缘)
        expandedX = sf.minX                             // 占满全宽,把手停在屏右缘

        panel = NSPanel(
            contentRect: NSRect(x: collapsedX, y: y, width: total, height: h),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovable = false

        let container = NSView(frame: NSRect(x: 0, y: 0, width: total, height: h))
        container.wantsLayer = true

        let cfg = WKWebViewConfiguration()
        webview = WKWebView(frame: NSRect(x: 0, y: 0, width: contentW, height: h), configuration: cfg)
        webview.autoresizingMask = [.width, .height]
        webview.navigationDelegate = self
        webview.setValue(false, forKey: "drawsBackground")  // 透明,避免加载前白闪
        webview.wantsLayer = true
        webview.layer?.cornerRadius = 10
        webview.layer?.masksToBounds = true
        container.addSubview(webview)

        handle = HandleView(frame: NSRect(x: contentW, y: (h - HANDLE_H) / 2, width: HANDLE_W, height: HANDLE_H))
        handle.autoresizingMask = [.minXMargin, .minYMargin, .maxYMargin]
        handle.onClick = { [weak self] in self?.toggle() }
        container.addSubview(handle)

        panel.contentView = container
        panel.orderFrontRegardless()
        loadPanel()
    }

    func toggle() {
        expanded.toggle()
        handle.expanded = expanded
        var f = panel.frame
        f.origin.x = expanded ? expandedX : collapsedX
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = ANIM
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().setFrame(f, display: true)
        }
    }

    func loadPanel() {
        guard let url = URL(string: PANEL_URL) else { return }
        webview.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
    }

    // daemon 还没起来 / 重启 → 隔 2s 重试加载。
    func retryLater() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.loadPanel() }
    }
    func webView(_ wv: WKWebView, didFail nav: WKNavigation!, withError error: Error) { retryLater() }
    func webView(_ wv: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) { retryLater() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // 不进 Dock、不抢菜单栏
app.run()
