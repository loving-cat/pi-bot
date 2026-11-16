import io

# ---------- system-prompt：注入【用户的习惯】 ----------
p = 'src/system-prompt.js'
raw = io.open(p, encoding='utf-8', newline='').read()
crlf = '\r\n' in raw
s = raw.replace('\r\n', '\n')

old_sig = """export function buildAppendSystemPrompt(
  bot = {},
  { userName = '', policy = null, mcpLines = '', modelLines = '' } = {},
) {"""
new_sig = """export function buildAppendSystemPrompt(
  bot = {},
  {
    userName = '', policy = null, mcpLines = '', modelLines = '',
    /**
     * 用户的习惯（`preferences.js` 的 `preferencesPromptLines()` 产物）。
     *
     * 只放 strong + 最多 5 条 —— 多了会污染 prompt，还白烧 token
     * （规格 `spec-intent-and-habits-v1.md` §3.3）。
     */
    preferenceLines = [],
  } = {},
) {"""
assert s.count(old_sig) == 1
s = s.replace(old_sig, new_sig)

old_body = """    ...(bot.persona ? [effectiveModelPersona(bot)] : []),"""
new_body = """    // ★ 用户的习惯排在最前面（紧跟人设）：它是"这个人要你怎么做"，
    //   比后面所有通用规矩都优先 —— 和它冲突时以它为准。
    ...(Array.isArray(preferenceLines) ? preferenceLines : []),
    ...(bot.persona ? [effectiveModelPersona(bot)] : []),"""
assert s.count(old_body) == 1
s = s.replace(old_body, new_body)
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n') if crlf else s)
print('prompt ok')

# ---------- session-factory：把偏好传进去 ----------
p = 'src/session-factory.js'
raw = io.open(p, encoding='utf-8', newline='').read()
crlf = '\r\n' in raw
s = raw.replace('\r\n', '\n')

old = """      buildAppendSystemPrompt(bot, {"""
assert s.count(old) == 1
s = s.replace(old, """      buildAppendSystemPrompt(bot, {
        preferenceLines: preferencesPromptLines(store.preferences()),""")
# 调用里其它参数保持不动；补 import
s = s.replace("import { store } from './store.js';",
              "import { store } from './store.js';\nimport { preferencesPromptLines } from './preferences.js';")
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n') if crlf else s)
print('factory ok')
