# Resources Reference

Resources expose project data through MCP reads. They are independent of tool calls and return valid JSON, including when large data must be shortened. This server does **not** implement resource subscriptions or change notifications; read a resource again to refresh it.

## Static Resources

These URIs read the OpenCode server's default project. Reading a project-scoped tool with `directory` does not change their scope.

| URI | Data |
|---|---|
| `opencode://project/current` | Current project |
| `opencode://config` | Configuration with sensitive fields redacted |
| `opencode://providers` | Providers and models with sensitive fields redacted |
| `opencode://agents` | Available agents |
| `opencode://commands` | Available commands |
| `opencode://health` | Server health and version |
| `opencode://vcs` | Version control information returned by OpenCode |
| `opencode://sessions` | Sessions in the default project |
| `opencode://mcp-servers` | Configured MCP server status |
| `opencode://file-status` | Version control file status |

## Project and Session Templates

Use these templates to select a different project without changing server defaults:

| URI template | Data |
|---|---|
| `opencode://projects/{directory}/current` | Project metadata |
| `opencode://projects/{directory}/sessions` | Project sessions |
| `opencode://projects/{directory}/sessions/{sessionId}` | One session |
| `opencode://projects/{directory}/sessions/{sessionId}/messages` | Session messages |

Encode the entire absolute server directory as one URI component with `encodeURIComponent`. The server decodes it once and validates it using the same absolute-path rules as project tools. For example:

```javascript
const directory = encodeURIComponent("/home/user/my-project");
const uri = `opencode://projects/${directory}/sessions`;
// opencode://projects/%2Fhome%2Fuser%2Fmy-project/sessions
```

Windows drive and UNC paths work the same way. Encode `%` characters too; do not repeatedly decode the path or substitute an MCP-host path for a remote server path.

## Large Responses

When serialized data exceeds the response budget, the JSON content is an envelope:

```json
{
  "truncated": true,
  "originalLength": 70000,
  "omittedCharacters": 20000,
  "preview": "A prefix of the serialized data..."
}
```

The numbers above illustrate the fields. `preview` is a string prefix, not a complete document to parse as JSON. Use narrower project/session resources or tool limits to retrieve manageable data. Reading resources never grants permission to mutate their underlying sessions or project.
