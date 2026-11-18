import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  private var activityToken: NSObjectProtocol?

  override func applicationDidFinishLaunching(_ notification: Notification) {
    activityToken = ProcessInfo.processInfo.beginActivity(
      options: .userInitiatedAllowingIdleSystemSleep,
      reason: "Keep local pi-bot WebSocket and UI responsive while window is occluded"
    )
    super.applicationDidFinishLaunching(notification)
  }

  override func applicationWillTerminate(_ notification: Notification) {
    if let token = activityToken {
      ProcessInfo.processInfo.endActivity(token)
      activityToken = nil
    }
    super.applicationWillTerminate(notification)
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}
