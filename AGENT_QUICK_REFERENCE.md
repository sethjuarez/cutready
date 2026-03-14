# QUICK REFERENCE: CutReady Agent System

## KEY FILES

### Frontend (TypeScript/React)
1. src/components/ChatPanel.tsx
   - Lines 49-120: BUILT_IN_AGENTS definition (Planner, Writer, Editor)
   - Lines 123-128: resolveAgentPrompt() - resolve custom/builtin agents
   - Lines 870-895: Agent selection and system prompt building
   - Lines 985-995: invoke("agent_chat_with_tools") call
   - Lines 475-560: listen("agent-event") - real-time event handling
   - Lines 1000-1050: Response processing and auto-refresh

### Backend (Rust)
1. src-tauri/src/commands/agent.rs (lines 79-133)
   - agent_chat_with_tools: Main Tauri command entry point

2. src-tauri/src/engine/agent/runner.rs (lines 174-421)
   - run(): Main agentic loop with streaming
   - Lines 204-210: Drain pending messages
   - Lines 228-311: Stream LLM response
   - Lines 314-327: Convert tool_calls
   - Lines 360-417: Execute tools, append results, loop

3. src-tauri/src/engine/agent/tools.rs (lines 130-727)
   - Lines 130-307: all_tools() - tool registry
   - Lines 461-532: exec_set_planning_rows() - CREATE/REPLACE sketches
   - Lines 534-575: exec_update_planning_row() - EDIT single row
   - Lines 325-347: execute_tool() - tool dispatcher

---

## AGENT DEFINITIONS (ChatPanel.tsx lines 49-120)

### Planner
- **ID**: "planner" (default)
- **System Prompt**: Instructs LLM to:
  1. Read referenced files (list_project_files, read_note, read_sketch)
  2. Plan approach before making changes
  3. USE set_planning_rows to create sketches (full generation)
  4. USE update_planning_row for targeted edits
- **Primary Output**: Full planning tables

### Writer
- **ID**: "writer"
- **System Prompt**: Focus on narrative refinement
  - Write for spoken delivery
  - Ensure smooth transitions
  - Use update_planning_row for narrative edits
- **Primary Output**: Improved voiceover scripts

### Editor
- **ID**: "editor"
- **System Prompt**: Make surgical edits
  - Use update_planning_row (preferred) for single-cell changes
  - Keep responses brief
- **Primary Output**: Concise confirmations

---

## COMPLETE DATA FLOW

1. USER INTERACTION (Frontend)
   └─ User selects agent (Planner/Writer/Editor)
   └─ User types message
   └─ Frontend builds:
      - System message = resolveAgentPrompt(agentId)
      - User message = user's text
      - Context = current sketch/note references

2. INVOKE BACKEND
   └─ invoke("agent_chat_with_tools", {
        messages: [system, user, ...context],
        agent_prompts: {custom agent definitions},
        config: {LLM provider, model, API key},
        ...other_settings
      })

3. BACKEND RECEIVES (agent.rs:agent_chat_with_tools)
   └─ Extract project_root
   └─ Setup vision_config
   └─ Call runner::run()

4. AGENTIC LOOP (runner.rs:run_with_depth)
   └─ ROUND 1:
      ├─ Drain pending_chat_messages queue
      ├─ Trim messages if exceeding context window
      ├─ Call LLM with tool_definitions
      ├─ Stream response: collect text + tool_calls
      ├─ Emit events: Delta, Thinking, Status
      ├─ If tool_calls:
      │  ├─ For each tool_call:
      │  │  ├─ Emit ToolCall event
      │  │  ├─ Execute (tools::execute_tool)
      │  │  ├─ Emit ToolResult event
      │  │  └─ Append tool_result message
      │  └─ Go to ROUND 2
      └─ Else: Emit Done event, return

5. TOOL EXECUTION (tools.rs:execute_tool)
   └─ Match tool name:
      ├─ "set_planning_rows": exec_set_planning_rows()
      │  ├─ Load or create sketch
      │  ├─ Replace rows
      │  ├─ Call project::write_sketch()
      │  └─ Return "Set X rows in path"
      ├─ "update_planning_row": exec_update_planning_row()
      │  ├─ Load sketch
      │  ├─ Validate index
      │  ├─ Patch specific fields
      │  ├─ Call project::write_sketch()
      │  └─ Return "Updated row X in path"
      ├─ "read_sketch": exec_read_sketch()
      ├─ "list_project_files": exec_list_project_files()
      └─ ...other tools...

6. RESPONSE PROCESSING (Frontend)
   └─ Receive AgentChatResult {
        messages: [full conversation],
        response: "final assistant text"
      }
   └─ Display in chat
   └─ Auto-refresh sidebar if sketch changed
   └─ Emit completion event

---

## SKETCH MODIFICATION FLOW

### Creating a New Sketch (via set_planning_rows)

Agent → tool_call("set_planning_rows", {
  path: "new-sketch.sk",
  title: "New Sketch",
  rows: [
    { time: "~20s", narrative: "...", demo_actions: "..." },
    { time: "~30s", narrative: "...", demo_actions: "..." }
  ]
})
  ↓
tools::execute_tool("set_planning_rows", args)
  ↓
1. Resolve "new-sketch.sk" → /project/root/new-sketch.sk
2. Try read_sketch() → doesn't exist, create new Sketch struct
3. Parse rows array → Vec<PlanningRow>
4. Call project::write_sketch(&sketch, &path, root)
   └─ Writes sketch.json to disk
   └─ Updates .cutready metadata
5. Return "Set 2 planning rows in new-sketch.sk"
  ↓
Frontend receives ToolResult
  ↓
Auto-refresh: appStore.setCurrentSketch("new-sketch.sk")
  ↓
Sidebar shows new sketch, editor opens it

### Editing Existing Row (via update_planning_row)

Agent → tool_call("update_planning_row", {
  path: "my-sketch.sk",
  index: 1,
  narrative: "Improved voiceover text"
})
  ↓
tools::execute_tool("update_planning_row", args)
  ↓
1. Resolve path → /project/root/my-sketch.sk
2. Load existing sketch via read_sketch()
3. Validate index < sketch.rows.len()
4. Patch: sketch.rows[1].narrative = "Improved voiceover text"
5. Call project::write_sketch()
   └─ Writes updated sketch.json to disk
6. Return "Updated row 1 in my-sketch.sk"
  ↓
Frontend receives ToolResult
  ↓
Auto-refresh if that sketch is currently open
  ↓
User sees updated row immediately

---

## KEY TOOL SCHEMAS

### set_planning_rows
{
  "path": "string",         // Required: relative path (new or existing)
  "title": "string",        // Optional: new/override title
  "description": "string",  // Optional: description
  "rows": [                 // Required: array of rows
    {
      "time": "string",           // "~30s", "1:00", etc.
      "narrative": "string",      // Voiceover
      "demo_actions": "string",   // Actions
      "screenshot": "string"      // Optional: image path
    }
  ]
}

### update_planning_row
{
  "path": "string",         // Required: relative path
  "index": "integer",       // Required: 0-based row index
  "time": "string",         // Optional
  "narrative": "string",    // Optional
  "demo_actions": "string", // Optional
  "screenshot": "string"    // Optional
}

---

## AGENT EVENT TYPES (emitted to frontend)

- "delta": Text chunk streamed from LLM
- "thinking": Reasoning chunk (if model supports)
- "status": Status message ("Thinking...", "Running X tool calls...")
- "tool_call": Tool is being invoked (name, arguments)
- "tool_result": Tool finished (name, result)
- "agent_start": Sub-agent delegated to (agent_id, task)
- "agent_done": Sub-agent finished (agent_id)
- "done": Agentic loop finished (final response)
- "error": Error occurred (message)

---

## IMPORTANT BEHAVIORS

1. **Agents don't write sketches directly** — they call tools
2. **Tools persist to disk immediately** — no staging
3. **Sketch updates are atomic** — entire file rewritten
4. **Context windowing is automatic** — messages trimmed if over limit
5. **Tool results added to conversation** — agent can reason about them
6. **Sub-agents can delegate** — but max depth is 2
7. **Max 10 tool rounds** — prevents infinite loops
8. **Frontend auto-refreshes** on set_planning_rows or update_planning_row
9. **Vision mode** optionally encodes images in tool results
10. **Pending messages** can be queued while agent is running

---

## DEBUGGING TIPS

1. Check browser console for invoke() results
2. Check stderr for Rust backend logs ("[agent]", "[tool]" prefixes)
3. Agent events streamed in real-time → listen to "agent-event"
4. Tool call arguments are JSON strings → parse in backend
5. Sketch path validation happens in tools (not frontend)
6. Vision images embedded as [VISION_IMAGES] markers in tool results
