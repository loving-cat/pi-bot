import io

# ---------- 1) 服务端：/api/grants 带上当前世代 ----------
p = 'http.js'
raw = io.open(p, encoding='utf-8', newline='').read()
crlf = '\r\n' in raw
s = raw.replace('\r\n', '\n')
old = """          grants: gate.list({ botId: botId || null }),
          // 顺带给出"当前规矩版本"，界面能看出哪些授权是基于旧规矩的
          policyRevision: store.policyVersion(),"""
new = """          grants: gate.list({ botId: botId || null }),
          // 顺带给出"当前规矩版本"，界面能看出哪些授权是基于旧规矩的
          policyRevision: store.policyVersion(),
          // ★ 当前实例世代：任务级授权（带 taskId）绑了它，重启后会失效。
          //   界面要能标出来 —— 否则用户看到"授权开着"却一直被拒
          //   （2026-11-16 实际发生过，铺子里管这叫"界面在撒谎"）。
          generation: runner.grantGate?.currentGeneration?.() ?? null,"""
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n') if crlf else s)
print('http ok')

# ---------- 2) App：GrantView 带世代 + 判断 ----------
p = '../app/lib/grant_view.dart'
raw = io.open(p, encoding='utf-8', newline='').read()
crlf = '\r\n' in raw
s = raw.replace('\r\n', '\n')
s = s.replace("""    this.policyRevision,""", """    this.policyRevision,
    this.generation,""")
s = s.replace("""  /// 这条授权是基于哪一版规矩批的。和当前版本不一致时它已经不管用了。
  final String? policyRevision;""",
"""  /// 这条授权是基于哪一版规矩批的。和当前版本不一致时它已经不管用了。
  final String? policyRevision;

  /// 这条授权绑在哪个进程实例上（只有**任务级**授权才有值）。
  ///
  /// 规格 §6.3：上个进程给任务的批准，重启后不该续命。所以任务级授权会带世代，
  /// 而用户/规矩立的长期授权**不带** —— 它们不该因为重启而失效
  /// （2026-11-16 修过这个 bug：以前所有授权都带，重启一次全灭）。
  final String? generation;""")
s = s.replace("""    policyRevision: json['policyRevision'] as String?,""",
              """    policyRevision: json['policyRevision'] as String?,
    generation: json['generation'] as String?,""")
s = s.replace("""  /// 动作清单的短句（超过三个折叠成“等 N 项”）。""",
"""  /// 这条授权是不是**本实例不可用**（任务级授权跨重启就失效）。
  ///
  /// 只比"两边都非空"：长期授权不带世代，拿 null 去比会把它全标成不可用，
  /// 反而制造噪音（和 `staleForPolicy` 同一个口径）。
  bool staleForGeneration(String? currentGeneration) {
    final mine = generation;
    final now = currentGeneration;
    if (mine == null || mine.isEmpty || now == null || now.isEmpty) return false;
    return mine != now;
  }

  /// 动作清单的短句（超过三个折叠成“等 N 项”）。""")
s = s.replace("""List<GrantView> grantsFromResponse(Map<String, dynamic>? json) {""",
              """List<GrantView> grantsFromResponse(Map<String, dynamic>? json) {""")
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n') if crlf else s)
print('grant_view ok')
