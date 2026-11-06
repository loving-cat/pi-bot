import 'models.dart';

/// 重连之后，哪些房间的本地消息需要重新拉一次。
///
/// ## 为什么需要这个
///
/// 界面上的"正在输入"三个点，画的是**消息本身的 status**：
/// 一条 `status='streaming'` 且内容为空的消息 → 渲染成三个点气泡。
///
/// 断网时服务端照样跑完了这一轮，把消息收尾成 done 并发 `msg.done`，
/// 但那一刻客户端不在线 —— 事件丢了，本地那条就永远停在 streaming。
/// 再连回来发一轮，服务端建了新消息，界面上就是
/// **旧的三个点还挂着、旁边又冒出一批新的**。
///
/// `hello` 里只带了房间和成员，不带消息；打开着的那个房间会强制刷新，
/// 但其它房间没人管 —— 用户切过去时 loadMessages 因为本地有缓存
/// 直接 return，看到的还是旧的。所以这里把"本地还挂着 streaming 的房间"
/// 全列出来，让调用方统一重拉。
///
/// 纯函数，便于单测：给定本地缓存，算出该刷哪些房间。
Set<String> roomsWithStaleStreaming(Map<String, List<Msg>> messages) {
  final out = <String>{};
  for (final entry in messages.entries) {
    for (final msg in entry.value) {
      if (msg.isStreaming) {
        out.add(entry.key);
        break; // 一个房间有一个就够，不用继续扫
      }
    }
  }
  return out;
}

/// 把这些房间里还停在 streaming 的消息就地标成中断。
///
/// 用于"重拉还没回来 / 重拉失败"的这段时间：先让三个点消失，
/// 而不是让用户对着一个永远不会结束的转圈。服务端真在跑的活
/// 还会有后续事件把它更新回来（新的一轮会建新消息）。
///
/// @returns 被改动的消息条数
int clearStaleStreaming(List<Msg> messages, {String reason = '连接中断，这一轮已结束'}) {
  var n = 0;
  for (final msg in messages) {
    if (!msg.isStreaming) continue;
    msg.status = msg.text.trim().isEmpty ? 'error' : 'done';
    if (msg.status == 'error') msg.error = reason;
    for (final step in msg.steps) {
      if (step.status == 'running') step.status = 'error';
    }
    n++;
  }
  return n;
}