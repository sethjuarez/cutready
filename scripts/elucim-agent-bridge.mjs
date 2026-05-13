#!/usr/bin/env node
import process from "node:process";
import {
  normalizeDocument,
  summarizeDocument,
  toRenderableDocument,
  validate,
  validateForAgent,
} from "@elucim/dsl";
import * as agent from "@elucim/dsl/agent";

const COMPOSITE_HELPERS = {
  autoLayoutGroup: agent.createAutoLayoutGroupPreset,
  badge: agent.createBadgePreset,
  boundary: agent.createBoundaryPreset,
  cardGrid: agent.createCardGridPreset,
  comparisonTable: agent.createComparisonTablePreset,
  connector: agent.createConnectorPreset,
  decisionNode: agent.createDecisionNodePreset,
  progressiveRevealGroup: agent.createProgressiveRevealGroupPreset,
  queueStack: agent.createQueueStackPreset,
  stepCard: agent.createStepCardPreset,
  textBlock: agent.createTextBlockPreset,
  timelineRoadmap: agent.createTimelineRoadmapPreset,
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function normalizeInput(payload) {
  if (!payload.document) {
    throw new Error("payload.document is required");
  }
  return normalizeDocument(payload.document);
}

function ok(op, result, extra = {}) {
  return { ok: true, op, ...extra, result };
}

function fail(op, error) {
  return {
    ok: false,
    op,
    error: error instanceof Error ? error.message : String(error),
  };
}

function run(payload) {
  const op = payload.op ?? process.argv[2] ?? "catalog";
  switch (op) {
    case "catalog":
      return ok(op, {
        operations: agent.getAgentOperationCatalog(),
        composites: Object.keys(COMPOSITE_HELPERS),
      });
    case "normalize": {
      const normalized = normalizeInput(payload);
      return ok(op, normalized.document, {
        inputFormat: normalized.inputFormat,
        migrated: normalized.migrated,
        warnings: normalized.warnings,
      });
    }
    case "summarize": {
      const normalized = normalizeInput(payload);
      return ok(op, summarizeDocument(normalized.document));
    }
    case "validate": {
      const normalized = normalizeInput(payload);
      return ok(op, validateForAgent(normalized.document));
    }
    case "renderable": {
      const normalized = normalizeInput(payload);
      const renderable = toRenderableDocument(normalized.document);
      return ok(op, {
        document: renderable,
        validation: validate(renderable),
      });
    }
    case "evaluate": {
      const normalized = normalizeInput(payload);
      return ok(op, agent.evaluateSceneForAgent(normalized.document));
    }
    case "inspect": {
      const normalized = normalizeInput(payload);
      return ok(op, agent.inspectSceneForAgent(normalized.document, payload.options ?? {}));
    }
    case "repair": {
      const normalized = normalizeInput(payload);
      return ok(op, agent.repairDocumentForAgent(normalized.document));
    }
    case "suggestNudges": {
      const normalized = normalizeInput(payload);
      return ok(op, agent.suggestDocumentNudges(normalized.document));
    }
    case "applyNudge": {
      const normalized = normalizeInput(payload);
      const nudgeId = payload.nudgeId ?? payload.nudge_id;
      if (!nudgeId) throw new Error("payload.nudgeId is required");
      const nudge = agent.suggestDocumentNudges(normalized.document).find((candidate) => candidate.id === nudgeId);
      if (!nudge) throw new Error(`Nudge "${nudgeId}" is not available`);
      return ok(op, agent.applyNudge(normalized.document, nudge));
    }
    case "applyCommands": {
      const normalized = normalizeInput(payload);
      if (!Array.isArray(payload.commands)) {
        throw new Error("payload.commands must be an array");
      }
      return ok(op, agent.applyAgentCommands(normalized.document, payload.commands));
    }
    case "createDocument":
      return ok(op, agent.createDocument(payload.spec ?? {}));
    case "createComposite": {
      const kind = payload.kind;
      const helper = COMPOSITE_HELPERS[kind];
      if (!helper) {
        throw new Error(`Unknown composite kind "${kind}". Available: ${Object.keys(COMPOSITE_HELPERS).join(", ")}`);
      }
      return ok(op, helper(payload.spec ?? {}));
    }
    default:
      throw new Error(`Unknown op "${op}"`);
  }
}

async function main() {
  const raw = process.argv[2] ? "" : await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : { op: process.argv[2] ?? "catalog" };
  const op = payload.op ?? process.argv[2] ?? "catalog";
  const response = (() => {
    try {
      return run({ ...payload, op });
    } catch (error) {
      return fail(op, error);
    }
  })();
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify(fail(process.argv[2] ?? "unknown", error))}\n`);
  process.exitCode = 1;
});
