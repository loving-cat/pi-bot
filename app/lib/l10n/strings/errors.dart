// 服务端错误代码对应的界面文案。
//
// 服务端返回 { error, code }：error 是中文兜底（老客户端用），
// code 是稳定标识。界面按当前语言取自己的说法，不依赖服务端语言。
// 没有匹配到的 code 原样显示服务端的 error，不吞掉信息。

import 'area.dart';

const areaErrors = StringArea(
  zh: {
    'err.PAIR_CODE_INVALID': '配对码不对或已过期，看服务端控制台最新那 6 位数字',
    'err.BAD_CONTENT_TYPE': '请求格式不对',
    'err.UNAUTHORIZED': '没有登录或登录已过期，请重新配对',
    'err.APPROVAL_NOT_PENDING': '这一条已经处理过了，没有待批准的操作',
    'err.ROOM_NOT_FOUND': '这个会话已经不在了',
    'err.AUTOMATION_INVALID': '定时任务要有标题和内容',
    'err.AUTOMATION_NOT_FOUND': '这条定时任务已经不在了',
    'err.TASK_NEEDS_TITLE': '任务需要一个标题',
    'err.TASK_NOT_FOUND': '这条任务已经不在了',
    'err.SITE_NOT_FOUND': '这个系统已经不在了',
    'err.IMPORT_NOTHING_SELECTED': '没有选中要导入的条目',
    'err.INVALID_KIND': '类型只能是技能或 MCP',
    'err.CHUNK_TOO_LARGE': '单个分片不能超过 4MB',
    'err.FILE_TOO_LARGE': '文件太大，上限 25MB',
    'err.EMPTY_FILE': '这是个空文件',
    'err.FILE_NOT_FOUND': '文件已经不在了',
    'err.NAME_REQUIRED': '需要填写名称',
    'err.BOT_NOT_FOUND': '这个 bot 已经不在了',
    'err.CANNOT_DELETE_MAIN_BOT': '删不了：它不存在，或者是助手本身',
    'err.MODEL_GROUP_NOT_FOUND': '这个模型组已经不在了',
    'err.CANNOT_DELETE_DM': '删不了：它不存在，或者是私聊',
    'err.ROOM_HAS_NO_BOT': '这个会话里没有 bot',
    'err.BOT_NOT_IN_ROOM': '这个 bot 不在该会话里',
  },
  en: {
    'err.PAIR_CODE_INVALID': 'Wrong or expired pairing code — check the 6 digits in the server console',
    'err.BAD_CONTENT_TYPE': 'Malformed request format',
    'err.UNAUTHORIZED': 'Not signed in or the session expired, please pair again',
    'err.APPROVAL_NOT_PENDING': 'This was already handled, nothing is pending',
    'err.ROOM_NOT_FOUND': 'That conversation is gone',
    'err.AUTOMATION_INVALID': 'A scheduled task needs a title and a body',
    'err.AUTOMATION_NOT_FOUND': 'That scheduled task is gone',
    'err.TASK_NEEDS_TITLE': 'A task needs a title',
    'err.TASK_NOT_FOUND': 'That task is gone',
    'err.SITE_NOT_FOUND': 'That site integration is gone',
    'err.IMPORT_NOTHING_SELECTED': 'Nothing selected to import',
    'err.INVALID_KIND': 'Type must be skill or MCP',
    'err.CHUNK_TOO_LARGE': 'A single chunk cannot exceed 4MB',
    'err.FILE_TOO_LARGE': 'File too large, 25MB limit',
    'err.EMPTY_FILE': 'That file is empty',
    'err.FILE_NOT_FOUND': 'That file is gone',
    'err.NAME_REQUIRED': 'A name is required',
    'err.BOT_NOT_FOUND': 'That bot is gone',
    'err.CANNOT_DELETE_MAIN_BOT': 'Cannot delete: it is missing or is the assistant itself',
    'err.MODEL_GROUP_NOT_FOUND': 'That model group is gone',
    'err.CANNOT_DELETE_DM': 'Cannot delete: it is missing or is a direct chat',
    'err.ROOM_HAS_NO_BOT': 'This conversation has no bot',
    'err.BOT_NOT_IN_ROOM': 'That bot is not in this conversation',
  },
);
