// One error type for everything the canvas reports: CmdError codes from
// `cutready-cli` (stale_document, locked_cell, ...) and the canvas's own
// codes (contract_mismatch, cli_not_found, ...).
export class CutReadyError extends Error {
    constructor(code, message, details = undefined) {
        super(message);
        this.name = "CutReadyError";
        this.code = code;
        if (details !== undefined) this.details = details;
    }

    toJSON() {
        const out = { code: this.code, message: this.message };
        if (this.details !== undefined) out.details = this.details;
        return out;
    }

    // A CommandFailure (`{ error: CmdError }`) from a tool result.
    static fromCommandFailure(failure) {
        const error = failure && typeof failure === "object" ? failure.error : undefined;
        if (!error || typeof error.code !== "string") {
            return new CutReadyError("protocol_error", "cutready-cli returned an error without a CmdError");
        }
        return new CutReadyError(error.code, String(error.message ?? error.code), error.details);
    }
}

export function asCutReadyError(err) {
    if (err instanceof CutReadyError) return err;
    return new CutReadyError("internal", err instanceof Error ? err.message : String(err));
}
