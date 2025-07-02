# MCP Client Implementation Plan for Chatbot

## Current Architecture Analysis

The chatbot currently has:
- **Frontend**: Next.js with TypeScript, terminal-themed UI in `/app/ama/page.tsx`
- **Backend**: API route at `/app/api/chatbot/route.ts` using Vercel AI SDK
- **AI Provider**: Direct OpenAI GPT-4o integration via `@ai-sdk/openai`
- **Context**: Fetches data from Contentful CMS for career/project information
- **UI**: Streaming chat interface with terminal aesthetics

## MCP Client Integration Plan

### Phase 1: Foundation Setup

#### 1.1 Install MCP Dependencies
```bash
# Core MCP client libraries
npm install @modelcontextprotocol/sdk @modelcontextprotocol/client-stdio @modelcontextprotocol/client-sse

# Additional transport layers if needed
npm install @modelcontextprotocol/client-websocket

# For process management if using stdio servers
npm install @types/node
```

#### 1.2 Create MCP Client Configuration
Create `/lib/mcp-client.ts`:
- Configuration for MCP server connections
- Connection management and error handling
- Tool discovery and registration

#### 1.3 Environment Configuration
Add to `.env.local`:
```
# MCP Server configurations
MCP_FILESYSTEM_SERVER_PATH=/path/to/filesystem-server
MCP_WEB_SERVER_URL=http://localhost:8080
MCP_DATABASE_SERVER_PATH=/path/to/database-server

# Enable/disable MCP features
ENABLE_MCP_TOOLS=true
```

### Phase 2: MCP Client Implementation

#### 2.1 Core MCP Client Service
Create `/lib/mcp-service.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn } from 'child_process'

export class MCPClientService {
  private clients: Map<string, Client> = new Map()
  private connectedServers: Set<string> = new Set()

  async connectToServer(serverName: string, serverPath: string) {
    // Implementation for connecting to MCP servers
  }

  async disconnectFromServer(serverName: string) {
    // Implementation for disconnecting from MCP servers
  }

  async listAvailableTools() {
    // Aggregate tools from all connected servers
  }

  async callTool(serverName: string, toolName: string, arguments: any) {
    // Call specific tool on specific server
  }

  async getResources(serverName: string) {
    // Get available resources from server
  }

  async readResource(serverName: string, uri: string) {
    // Read specific resource from server
  }
}
```

#### 2.2 Tool Integration Layer
Create `/lib/mcp-tools.ts`:

```typescript
interface MCPTool {
  name: string
  description: string
  inputSchema: object
  serverName: string
}

export class MCPToolManager {
  private mcpService: MCPClientService
  private availableTools: Map<string, MCPTool> = new Map()

  async refreshTools() {
    // Discover and register all available MCP tools
  }

  async executeTool(toolName: string, args: any) {
    // Execute MCP tool and handle response
  }

  getToolsForAI(): object[] {
    // Format tools for AI function calling
  }
}
```

### Phase 3: AI Integration Layer

#### 3.1 Enhanced AI Service
Create `/lib/ai-service.ts`:

```typescript
import { openai } from '@ai-sdk/openai'
import { generateText, streamText, tool } from 'ai'
import { MCPToolManager } from './mcp-tools'
import { z } from 'zod'

export class EnhancedAIService {
  private mcpToolManager: MCPToolManager

  constructor() {
    this.mcpToolManager = new MCPToolManager()
  }

  async generateResponse(messages: any[], enableTools: boolean = true) {
    const tools = enableTools ? await this.getMCPToolsForAI() : {}

    return await streamText({
      model: openai('gpt-4o'),
      messages,
      tools,
      maxTokens: 1000,
      temperature: 0.7,
    })
  }

  private async getMCPToolsForAI() {
    const mcpTools = await this.mcpToolManager.refreshTools()
    
    // Convert MCP tools to AI SDK tool format
    return mcpTools.reduce((acc, mcpTool) => {
      acc[mcpTool.name] = tool({
        description: mcpTool.description,
        parameters: z.object(mcpTool.inputSchema),
        execute: async (args) => {
          return await this.mcpToolManager.executeTool(mcpTool.name, args)
        }
      })
      return acc
    }, {})
  }
}
```

#### 3.2 Update Chatbot API Route
Modify `/app/api/chatbot/route.ts`:

```typescript
import { EnhancedAIService } from '@/lib/ai-service'

const aiService = new EnhancedAIService()

export async function POST(req: Request) {
  try {
    const { question, enableMCPTools = true } = await req.json()

    // Enhanced system prompt with MCP tool capabilities
    const systemPrompt = `
    You are a terminal-based AI assistant for Jonathan Segovia's personal website.
    You have access to various tools through MCP (Model Context Protocol) servers.
    
    Available capabilities:
    ${enableMCPTools ? '- File system operations (if filesystem server connected)' : ''}
    ${enableMCPTools ? '- Web browsing (if web server connected)' : ''}
    ${enableMCPTools ? '- Database queries (if database server connected)' : ''}
    
    Use tools when helpful, but focus on questions about Jonathan Segovia.
    `

    const result = await aiService.generateResponse([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question }
    ], enableMCPTools)

    return result.toTextStreamResponse()
  } catch (error) {
    console.error('[CHATBOT API] Error:', error)
    return new Response('Error processing request', { status: 500 })
  }
}
```

### Phase 4: MCP Server Configuration

#### 4.1 Server Connection Management
Create `/lib/mcp-config.ts`:

```typescript
export interface MCPServerConfig {
  name: string
  type: 'stdio' | 'sse' | 'websocket'
  path?: string // for stdio
  url?: string // for sse/websocket
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
}

export const MCP_SERVERS: MCPServerConfig[] = [
  {
    name: 'filesystem',
    type: 'stdio',
    path: process.env.MCP_FILESYSTEM_SERVER_PATH || './mcp-servers/filesystem/server.js',
    args: [],
    enabled: process.env.ENABLE_MCP_FILESYSTEM === 'true'
  },
  {
    name: 'web-browser',
    type: 'sse',
    url: process.env.MCP_WEB_SERVER_URL || 'http://localhost:8080',
    enabled: process.env.ENABLE_MCP_WEB === 'true'
  },
  {
    name: 'database',
    type: 'stdio',
    path: process.env.MCP_DATABASE_SERVER_PATH || './mcp-servers/database/server.js',
    args: [],
    enabled: process.env.ENABLE_MCP_DATABASE === 'true'
  }
]
```

#### 4.2 Connection Initialization
Create `/lib/mcp-init.ts`:

```typescript
import { MCPClientService } from './mcp-service'
import { MCP_SERVERS } from './mcp-config'

export async function initializeMCPConnections() {
  const mcpService = new MCPClientService()
  
  for (const serverConfig of MCP_SERVERS) {
    if (serverConfig.enabled) {
      try {
        await mcpService.connectToServer(serverConfig.name, serverConfig.path || serverConfig.url!)
        console.log(`✅ Connected to MCP server: ${serverConfig.name}`)
      } catch (error) {
        console.error(`❌ Failed to connect to ${serverConfig.name}:`, error)
      }
    }
  }
  
  return mcpService
}
```

### Phase 5: Frontend Enhancements

#### 5.1 Tool Usage Display
Update `/app/ama/page.tsx` to show when MCP tools are being used:

```typescript
interface Message {
  role: "user" | "assistant"
  content: string
  id: string
  toolCalls?: ToolCall[] // Add tool call tracking
  mcpTools?: string[] // Track which MCP tools were used
}

interface ToolCall {
  name: string
  args: any
  result: any
  serverName: string
}
```

#### 5.2 MCP Status Indicator
Add a component to show MCP server connection status:

```typescript
// components/mcp-status.tsx
export function MCPStatus() {
  const [servers, setServers] = useState<ServerStatus[]>([])
  
  useEffect(() => {
    // Fetch MCP server status
    fetch('/api/mcp/status')
      .then(res => res.json())
      .then(setServers)
  }, [])

  return (
    <div className="mcp-status">
      <h3>MCP Servers</h3>
      {servers.map(server => (
        <div key={server.name} className={`server-status ${server.connected ? 'connected' : 'disconnected'}`}>
          {server.name}: {server.connected ? '🟢' : '🔴'}
        </div>
      ))}
    </div>
  )
}
```

### Phase 6: Testing and Validation

#### 6.1 MCP Server Testing
Create `/app/api/mcp/test/route.ts`:

```typescript
export async function GET() {
  const mcpService = new MCPClientService()
  
  const testResults = {
    connectedServers: [],
    availableTools: [],
    testExecutions: []
  }
  
  // Test each connected server
  // Execute sample tool calls
  // Validate responses
  
  return NextResponse.json(testResults)
}
```

#### 6.2 Integration Tests
Create test scenarios for:
- MCP server connection/disconnection
- Tool discovery and execution
- Error handling and fallbacks
- Streaming response with tool usage

### Phase 7: Advanced Features

#### 7.1 Dynamic Server Discovery
- Auto-detect available MCP servers
- Hot-reload server connections
- Server capability negotiation

#### 7.2 Tool Chaining
- Enable AI to use multiple tools in sequence
- Context preservation across tool calls
- Intelligent tool selection

#### 7.3 Caching Layer
- Cache tool results for performance
- Implement smart cache invalidation
- Reduce redundant MCP server calls

#### 7.4 Security and Permissions
- Implement tool usage permissions
- Rate limiting for MCP calls
- Audit logging for tool executions

## Implementation Timeline

### Week 1: Foundation
- Install MCP dependencies
- Create basic MCP client service
- Set up server configurations

### Week 2: Core Integration
- Implement MCP tool manager
- Update AI service for tool calling
- Modify chatbot API route

### Week 3: Frontend & Testing
- Update UI for tool usage display
- Create MCP status indicators
- Implement testing endpoints

### Week 4: Polish & Advanced Features
- Add error handling and fallbacks
- Implement caching layer
- Performance optimization
- Documentation and deployment

## Potential MCP Servers to Integrate

1. **Filesystem Server**: File operations, reading project files
2. **Web Browser Server**: Web search, URL fetching
3. **Database Server**: Query personal data, analytics
4. **Git Server**: Repository operations, commit history
5. **Calendar Server**: Schedule information, availability
6. **Email Server**: Contact information, communication
7. **Custom Jonathan Server**: Specialized personal information tools

## Benefits of MCP Integration

1. **Extensibility**: Easy to add new capabilities via MCP servers
2. **Modularity**: Each server handles specific domain logic
3. **Standardization**: Uses industry-standard MCP protocol
4. **Scalability**: Can connect to multiple servers simultaneously
5. **Security**: Controlled access through MCP protocol
6. **Maintainability**: Separation of concerns between AI and tools

## Considerations and Challenges

1. **Performance**: Additional latency from MCP server communication
2. **Reliability**: Need robust error handling for server failures  
3. **Complexity**: More moving parts in the system
4. **Debugging**: Tool execution tracing and monitoring
5. **Security**: Proper validation of tool inputs/outputs
6. **Resource Management**: Connection pooling and cleanup

This plan provides a comprehensive roadmap for transforming the current chatbot into a full MCP client while maintaining the existing functionality and user experience.