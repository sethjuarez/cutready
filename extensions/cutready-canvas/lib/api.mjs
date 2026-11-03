// JSON endpoints the panel's web view calls. User edits are kept at once;
// every change tells the other panels on the project to refresh.
import { listDocuments, pendingReviews, readDocument, resolveReview, userEdit } from "./documents.mjs";

/** @param {import("./instances.mjs").Instances} instances */
export function apiRoutes(instances) {
    return {
        "GET /api/project": async (instance) => ({ project: instance.project, cli: instance.session.cli ?? null }),

        "GET /api/documents": (instance) => listDocuments(instance.session),

        "GET /api/document": (instance, { path }) => readDocument(instance.session, path),

        "POST /api/edit": async (instance, { path, expectedVersion, ops }) => {
            const applied = await userEdit(instance.session, { path, expectedVersion, ops });
            instances.emit(instance, "changed", { path, by: "user" });
            return applied;
        },

        "GET /api/reviews": (instance) => pendingReviews(instance.session),

        "POST /api/review": async (instance, { decision, runId, path, throughSeq }) => {
            const result = await resolveReview(instance.session, { decision, runId, path, throughSeq });
            instances.emit(instance, "changed", { path, by: "review" });
            return result;
        },
    };
}
