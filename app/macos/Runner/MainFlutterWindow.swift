import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  /// 启动阶段允许的尺寸下限（逻辑像素）
  private let bootMinSize = NSSize(width: 760, height: 520)

  /// 启动保底是否还在生效。
  ///
  /// 只在启动后的一小段时间里纠偏：过了这段时间尺寸就交给用户和 Dart 侧，
  /// 否则会把用户主动缩小窗口的操作也顶回去。
  private var guardingBootSize = true

  /// 启动时设定的目标尺寸，用来判断窗口有没有被引擎压小
  private var bootTargetSize: NSSize = .zero

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    // 记住 nib 里的初始尺寸：awakeFromNib 时窗口还没上屏，
    // 这个值才是 xib 里声明的那个（800x600）。
    let nibFrame = self.frame
    bootTargetSize = nibFrame.size
    self.contentViewController = flutterViewController
    self.setFrame(nibFrame, display: true)
    self.minSize = bootMinSize

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }

  override func orderFront(_ sender: Any?) {
    super.orderFront(sender)
    startSizeGuard()
  }

  override func makeKeyAndOrderFront(_ sender: Any?) {
    super.makeKeyAndOrderFront(sender)
    startSizeGuard()
  }

  /// 启动后盯着尺寸一小段时间。
  ///
  /// 背景：Flutter 引擎首次 layout 时会按内容算窗口尺寸，可能把窗口压到
  /// 130x135 这种几乎看不见的大小，而 Dart 侧 windowManager.getBounds()
  /// 仍然报告 1180x732 —— 两边完全不同步，且**不是每次都发生**（取决于
  /// 内容布局和引擎时序，实测 3 次里出现 2 次）。
  ///
  /// 一次纠偏不够：纠完引擎可能又压一次。所以在一段时间内反复检查，
  /// 发现被压小就顶回去。用户开始拖拽窗口后立即停止纠正。
  private func startSizeGuard() {
    guard guardingBootSize else { return }
    var ticks = 0
    func tick() {
      guard guardingBootSize else { return }
      ticks += 1
      // 最多盯 5 秒（50 x 100ms），足够覆盖启动期的布局抖动
      if ticks > 50 {
        guardingBootSize = false
        return
      }
      // 用户已经在拖了：立刻停手，交给用户
      if self.inLiveResize {
        guardingBootSize = false
        return
      }
      let current = self.frame.size
      let tooSmall =
        current.width < bootMinSize.width || current.height < bootMinSize.height
      if tooSmall {
        self.setContentSize(
          NSSize(
            width: max(current.width, bootTargetSize.width),
            height: max(current.height, bootTargetSize.height)
          )
        )
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { tick() }
    }
    DispatchQueue.main.async { tick() }
  }
}
