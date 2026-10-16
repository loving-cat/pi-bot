#include "flutter_window.h"

#include <dwmapi.h>

#include <optional>

#include "flutter/generated_plugin_registrant.h"

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  // 深色标题栏（否则会跟着系统强调色走，很容易是一块刺眼的亮色）
  HWND handle = GetHandle();

  // ★ 无边框：Windows 在 CreateWindow 时会把 WS_CAPTION 补回来（实测：
  //   传进去 0x020f0000，拿回来 0x06cf0000），所以只能在创建之后强制去掉。
  //   配合 MessageHandler 里的 WM_NCCALCSIZE 返回 0，标题栏和边框彻底消失。
  LONG style = GetWindowLong(handle, GWL_STYLE);
  style &= ~(WS_CAPTION | WS_BORDER | WS_DLGFRAME);
  SetWindowLong(handle, GWL_STYLE, style);
  SetWindowPos(handle, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE |
                   SWP_FRAMECHANGED);
  BOOL dark_mode = TRUE;
  DwmSetWindowAttribute(handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */,
                        &dark_mode, sizeof(dark_mode));
  const COLORREF caption = RGB(0x0E, 0x0E, 0x0E);
  DwmSetWindowAttribute(handle, 35 /* DWMWA_CAPTION_COLOR */, &caption,
                        sizeof(caption));
  const COLORREF border = RGB(0x24, 0x24, 0x24);
  DwmSetWindowAttribute(handle, 34 /* DWMWA_BORDER_COLOR */, &border,
                        sizeof(border));

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // ---- 无边框窗口 ----
  // ★ 必须放在 Flutter 的 HandleTopLevelWindowProc 之前：
  //   否则这个消息会被上游吃掉，我们自己的处理永远跑不到。
  // 返回 0 = 客户区覆盖整个窗口 → 标题栏和边框彻底消失（但样式位还在，
  // Windows 自已在 CreateWindow 时会补回 WS_CAPTION，改样式没用）。
  if (message == WM_NCCALCSIZE && wparam == TRUE) {
    auto* params = reinterpret_cast<NCCALCSIZE_PARAMS*>(lparam);
    // 最大化时 Windows 会把窗口撑到工作区之外，补回边距，否则内容被任务栏盖住
    if (IsZoomed(hwnd)) {
      const int frame_x =
          GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
      const int frame_y =
          GetSystemMetrics(SM_CYSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
      params->rgrc[0].left += frame_x;
      params->rgrc[0].right -= frame_x;
      params->rgrc[0].top += frame_y;
      params->rgrc[0].bottom -= frame_y;
    }
    return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
