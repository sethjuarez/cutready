// The CutReady edit contract this canvas speaks. It must equal
// `CONTRACT_VERSION` in crates/cutready-contracts/src/lib.rs; a test pins it.
export const CONTRACT_VERSION = 1;

// MCP protocol revision the canvas requests from `cutready-cli mcp`.
export const PROTOCOL_VERSION = "2025-06-18";

// JSON-RPC error codes `cutready-cli mcp` uses beyond the standard ones.
export const RPC = Object.freeze({
    CONTRACT_MISMATCH: -32001,
    NOT_INITIALIZED: -32002,
    INVALID_PARAMS: -32602,
});

// Error codes the canvas raises itself, alongside the contract's CmdErrorCode values.
export const CANVAS_ERRORS = Object.freeze({
    CLI_NOT_FOUND: "cli_not_found",
    CONTRACT_MISMATCH: "contract_mismatch",
    HANDSHAKE_FAILED: "handshake_failed",
    PROCESS_EXITED: "process_exited",
    TIMEOUT: "timeout",
    PROTOCOL: "protocol_error",
    INVALID_REQUEST: "invalid_request",
    NO_PROJECT: "no_project",
});
