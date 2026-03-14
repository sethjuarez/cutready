# CutReady Agent Architecture

## Overview
CutReady implements an agentic AI system where specialized AI agents (Planner, Writer, Editor) help users create and refine demo video sketches. The system uses function calling to let agents read/write project files and modify sketch data.

---

## 1. Agent Definitions

### Built-in Agents

Three core agents are defined in src/components/ChatPanel.tsx (lines 49-120):

#### **Planner** (id: "planner")
- **Role**: Help users create and refine sketches from scratch
- **Capabilities**: 
  - Reasons step-by-step about user requests
  - Reads project context via list_project_files, read_note, read_sketch
  - **Creates/generates sketches** using set_planning_rows
  - Makes surgical edits with update_planning_row
- **Key tools**: set_planning_rows, update_planning_row
- **Output**: Full planning tables with time, narrative, demo_actions columns

#### **Writer** (id: "writer")
- **Role**: Specialize in narrative and script refinement
- **Capabilities**:
  - Reviews sketches and refines voiceover scripts
  - Focuses on storytelling, pacing, audience engagement
  - Applies changes via update_planning_row or set_planning_rows
- **Key instruction**: "Write for spoken delivery — short sentences, natural rhythm"

#### **Editor** (id: "editor")
- **Role**: Make precise, surgical edits to existing sketches
- **Capabilities**: Targeted changes to specific cells
- **Preferred tool**: update_planning_row for single-cell changes
- **Output**: Concise confirmation of changes

---

## 2. How Agents Work: The Agentic Loop

### Data Flow
User sends message
  ↓
agent_chat_with_tools invoked (frontend → backend)
  ↓
LLM called with tools available
  ↓
Does LLM return tool_calls?
  ├─ NO: Return final response → Done
  └─ YES:
    Execute tools (set_planning_rows, update_planning_row, etc.)
    Tool results appended as tool messages
    Re-call LLM with extended message history
    (repeat until max rounds or no more tool_calls)

---

## 3. Backend Implementation

### agent_chat_with_tools Command
File: src-tauri/src/commands/agent.rs (lines 79-133)

Tauri command entry point that:
1. Receives messages (full chat history including system prompt)
2. Extracts project root from state
3. Configures vision mode
4. Calls runner::run() to execute the agentic loop
5. Returns AgentChatResult with messages and final response

### Agentic Loop: runner::run()
File: src-tauri/src/engine/agent/runner.rs (lines 174-421)

Loop structure (max 10 rounds):
1. Drain pending messages from queue
2. Call LLM with streaming
3. Accumulate response (text + tool_calls)
4. Check finish reason - if no tool_calls, done
5. Execute each tool:
   - Emit ToolCall event
   - Call tools::execute_tool()
   - Emit ToolResult event
   - Append tool_result message
   - Loop back to step 2

---

## 4. Tools: How Agents Modify Data

### set_planning_rows (lines 161-184, impl 461-532)
- **Purpose**: Replace ALL planning rows in a sketch, or create new sketch
- **When used**: Planner creating full sketches from scratch
- **Parameters**:
  path: "relative/path.sk" (new or existing sketch path)
  title: "Optional title"
  rows: [
    {
      "time": "~30s",
      "narrative": "Voiceover text",
      "demo_actions": "On-screen actions",
      "screenshot": "Optional path to image"
    }
  ]
- **Implementation**:
  1. Resolve path to absolute file path
  2. Try to load existing sketch; if not found, create new one
  3. Extract rows array and convert to PlanningRow structs
  4. Update title/description if provided
  5. Call project::write_sketch() to persist to disk
  6. Return success message

### update_planning_row (lines 195-209, impl 534-575)
- **Purpose**: Update a single planning row by index (surgical edit)
- **When used**: Writer/Editor making targeted changes
- **Parameters**:
  path: "relative/path.sk"
  index: 0 (0-based row index)
  time: "Optional new time"
  narrative: "Optional new narrative"
  demo_actions: "Optional new actions"
  screenshot: "Optional new screenshot path"
- **Implementation**:
  1. Load existing sketch
  2. Validate index is within bounds
  3. Patch only provided fields
  4. Call project::write_sketch() to persist
  5. Return confirmation message

### Other Key Tools
- **read_sketch**: Read a sketch's full content for analysis
- **list_project_files**: List all sketches, notes, storyboards
- **read_note**: Read markdown note content
- **delegate_to_agent**: Call another agent from within an agent
- **update_note**, **create_note**: Modify/create markdown notes

---

## 5. Tool Execution Flow

File: src-tauri/src/engine/runner.rs (lines 366-417)

For each tool_call:
1. Emit ToolCall event
2. Route to appropriate handler:
   - delegate_to_agent → exec_delegation (sub-agent loop)
   - fetch_url → exec_fetch_url (HTTP request)
   - Others → tools::execute_tool()
3. Emit ToolResult event
4. Append tool_result message to conversation
5. LLM can reason about what happened
6. Loop back (if more rounds available)

---

## 6. Frontend → Backend Communication

### User Selects Agent

File: src/components/ChatPanel.tsx (lines 870-895)

`	ypescript
const selectedAgent = useMemo(() => {
  const agentId = settings.aiSelectedAgent || "planner";
  return allAgents.find(a => a.id === agentId) || BUILT_IN_AGENTS[0];
}, [settings.aiSelectedAgent, allAgents]);

// Resolve agent's system prompt
let prompt = resolveAgentPrompt(agentId, customAgents);

// Send to backend with agent prompt as system message
const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
  messages: fullMessages,  // Includes system prompt with agent's instructions
  agent_prompts: agentPromptsMap,
  ...otherConfig
});
`

### Frontend Listens to Real-time Events

File: src/components/ChatPanel.tsx (lines 475-560)

`	ypescript
const unlisten = listen<AgentEvent>("agent-event", (event) => {
  switch (event.type) {
    case "agent_start":
      // Another agent was delegated to
      break;
      
    case "tool_call":
      // Tool is being executed
      setStreamingStatus(Calling ...);
      break;
      
    case "tool_result":
      // Tool finished
      addActivityEntries([{
        source: 	ool:,
        content: ev.result
      }]);
      
      // AUTO-REFRESH if sketch/note modified
      if (toolName === "set_planning_rows" || toolName === "update_planning_row") {
        const args = JSON.parse(pendingToolArgsRef.current[toolName] ?? "{}");
        appStore.setCurrentSketch(args.path);  // Refresh UI
      }
      break;
  }
});
`

### Response Processing

After agent finishes:
1. Receive AgentChatResult with full messages + response
2. Display tool calls and results in activity log
3. Auto-refresh sidebar to show modified sketches
4. Display agent's final message in chat

---

## 7. Sketch Data Model

### PlanningRow
`	ypescript
export interface PlanningRow {
  time: string;           // e.g., "~30s", "1:00"
  narrative: string;      // Voiceover script
  demo_actions: string;   // On-screen actions
  screenshot?: string;    // Optional path to screenshot
}

export interface Sketch {
  title: string;
  description?: any;
  rows: PlanningRow[];
  state: SketchState;
  created_at: string;
  updated_at: string;
}
`

### ChatMessage
`	ypescript
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  tool_calls?: ToolCall[];    // For assistant messages with function calls
  tool_call_id?: string;      // For tool result messages
}

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}
`

---

## 8. Complete User Flow Example: Planner Agent

1. User opens CutReady → Defaults to "Planner" agent
2. User types: "Create a sketch for a demo of the login feature"
3. Frontend:
   - Constructs system message with Planner's prompt
   - Sends message to agent_chat_with_tools
4. Backend (runner.rs):
   - LLM receives: [system=Planner prompt, user="Create sketch for login demo"]
   - LLM thinks: "I should create a sketch with set_planning_rows"
   - LLM returns: tool_call to set_planning_rows with rows data
5. Backend (tools.rs):
   - execute_tool("set_planning_rows", {...}) called
   - project::write_sketch() saves sketch file to disk
   - Returns: "Set 2 planning rows in login-demo.sk"
6. Backend (runner.rs):
   - Appends tool_result message
   - Re-calls LLM
   - LLM: "I successfully created the sketch. Here's what I did..."
   - LLM finishes response (no more tool_calls)
7. Frontend:
   - Receives AgentChatResult with full conversation
   - Displays tool call and result in activity log
   - Auto-refreshes sidebar to show new "login-demo.sk"
   - Displays agent's final message in chat

---

## 9. Key Design Principles

1. **Agents don't directly modify state** — they call tools
2. **Tools always write to disk** — no in-memory state mutations
3. **Frontend auto-refreshes** when tool results affect current documents
4. **Streaming** provides real-time feedback (deltas + tool calls + results)
5. **Tool results go back to LLM** — agent can reason about what happened
6. **Max 10 tool rounds** prevents infinite loops
7. **Max 2 delegation levels** prevents sub-agent loops
8. **Vision mode** allows agents to analyze sketch screenshots and note images
9. **Messages trimmed to context window** with automatic summarization
