/** Private V1 wire mapping; callers use semantic operation names. */
export const v1Routes = {
  "lifecycle.health": {
    "method": "GET",
    "path": "/global/health"
  },
  "configuration.get": {
    "method": "GET",
    "path": "/config"
  },
  "configuration.update": {
    "method": "PATCH",
    "path": "/config"
  },
  "providers.configured": {
    "method": "GET",
    "path": "/config/providers"
  },
  "providers.list": {
    "method": "GET",
    "path": "/provider"
  },
  "providers.authMethods": {
    "method": "GET",
    "path": "/provider/auth"
  },
  "projects.list": {
    "method": "GET",
    "path": "/project"
  },
  "projects.current": {
    "method": "GET",
    "path": "/project/current"
  },
  "files.paths": {
    "method": "GET",
    "path": "/path"
  },
  "files.vcs": {
    "method": "GET",
    "path": "/vcs"
  },
  "sessions.list": {
    "method": "GET",
    "path": "/session"
  },
  "sessions.create": {
    "method": "POST",
    "path": "/session"
  },
  "sessions.status": {
    "method": "GET",
    "path": "/session/status"
  },
  "sessions.get": {
    "method": "GET",
    "path": "/session/:sessionId"
  },
  "sessions.remove": {
    "method": "DELETE",
    "path": "/session/:sessionId"
  },
  "sessions.update": {
    "method": "PATCH",
    "path": "/session/:sessionId"
  },
  "sessions.children": {
    "method": "GET",
    "path": "/session/:sessionId/children"
  },
  "sessions.todo": {
    "method": "GET",
    "path": "/session/:sessionId/todo"
  },
  "sessions.init": {
    "method": "POST",
    "path": "/session/:sessionId/init"
  },
  "sessions.abort": {
    "method": "POST",
    "path": "/session/:sessionId/abort"
  },
  "sessions.fork": {
    "method": "POST",
    "path": "/session/:sessionId/fork"
  },
  "sessions.share": {
    "method": "POST",
    "path": "/session/:sessionId/share"
  },
  "sessions.unshare": {
    "method": "DELETE",
    "path": "/session/:sessionId/share"
  },
  "sessions.diff": {
    "method": "GET",
    "path": "/session/:sessionId/diff"
  },
  "sessions.compact": {
    "method": "POST",
    "path": "/session/:sessionId/summarize"
  },
  "sessions.revert": {
    "method": "POST",
    "path": "/session/:sessionId/revert"
  },
  "sessions.unrevert": {
    "method": "POST",
    "path": "/session/:sessionId/unrevert"
  },
  "messages.list": {
    "method": "GET",
    "path": "/session/:sessionId/message"
  },
  "messages.get": {
    "method": "GET",
    "path": "/session/:sessionId/message/:messageId"
  },
  "messages.send": {
    "method": "POST",
    "path": "/session/:sessionId/message"
  },
  "messages.enqueue": {
    "method": "POST",
    "path": "/session/:sessionId/prompt_async"
  },
  "messages.command": {
    "method": "POST",
    "path": "/session/:sessionId/command"
  },
  "messages.shell": {
    "method": "POST",
    "path": "/session/:sessionId/shell"
  },
  "permissions.list": {
    "method": "GET",
    "path": "/permission"
  },
  "permissions.reply": {
    "method": "POST",
    "path": "/permission/:requestId/reply"
  },
  "permissions.legacyReply": {
    "method": "POST",
    "path": "/session/:sessionId/permissions/:requestId"
  },
  "forms.list": {
    "method": "GET",
    "path": "/question"
  },
  "forms.reply": {
    "method": "POST",
    "path": "/question/:requestId/reply"
  },
  "forms.reject": {
    "method": "POST",
    "path": "/question/:requestId/reject"
  },
  "files.list": {
    "method": "GET",
    "path": "/file"
  },
  "files.read": {
    "method": "GET",
    "path": "/file/content"
  },
  "files.status": {
    "method": "GET",
    "path": "/file/status"
  },
  "files.findText": {
    "method": "GET",
    "path": "/find"
  },
  "files.find": {
    "method": "GET",
    "path": "/find/file"
  },
  "files.findSymbol": {
    "method": "GET",
    "path": "/find/symbol"
  },
  "configuration.agents": {
    "method": "GET",
    "path": "/agent"
  },
  "configuration.commands": {
    "method": "GET",
    "path": "/command"
  },
  "configuration.mcp": {
    "method": "GET",
    "path": "/mcp"
  },
  "configuration.mcpAdd": {
    "method": "POST",
    "path": "/mcp"
  },
  "lifecycle.lsp": {
    "method": "GET",
    "path": "/lsp"
  },
  "lifecycle.formatter": {
    "method": "GET",
    "path": "/formatter"
  },
  "lifecycle.tools": {
    "method": "GET",
    "path": "/experimental/tool"
  },
  "lifecycle.toolIds": {
    "method": "GET",
    "path": "/experimental/tool/ids"
  },
  "lifecycle.log": {
    "method": "POST",
    "path": "/log"
  },
  "lifecycle.dispose": {
    "method": "POST",
    "path": "/instance/dispose"
  },
  "providers.authorize": {
    "method": "POST",
    "path": "/provider/:providerId/oauth/authorize"
  },
  "providers.callback": {
    "method": "POST",
    "path": "/provider/:providerId/oauth/callback"
  },
  "providers.setAuth": {
    "method": "PUT",
    "path": "/auth/:providerId"
  },
  "tui.append-prompt": {
    "method": "POST",
    "path": "/tui/append-prompt"
  },
  "tui.submit-prompt": {
    "method": "POST",
    "path": "/tui/submit-prompt"
  },
  "tui.clear-prompt": {
    "method": "POST",
    "path": "/tui/clear-prompt"
  },
  "tui.execute-command": {
    "method": "POST",
    "path": "/tui/execute-command"
  },
  "tui.show-toast": {
    "method": "POST",
    "path": "/tui/show-toast"
  },
  "tui.open-help": {
    "method": "POST",
    "path": "/tui/open-help"
  },
  "tui.open-sessions": {
    "method": "POST",
    "path": "/tui/open-sessions"
  },
  "tui.open-models": {
    "method": "POST",
    "path": "/tui/open-models"
  },
  "tui.open-themes": {
    "method": "POST",
    "path": "/tui/open-themes"
  }
} as const;
export type Operation = keyof typeof v1Routes;
