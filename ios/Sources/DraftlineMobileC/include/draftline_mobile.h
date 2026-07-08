#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

/**
 * Stable status codes returned by mobile bridge functions.
 */
typedef enum DraftlineMobileStatusCode {
  Ok = 0,
  NullArgument = 1,
  InvalidUtf8 = 2,
  InvalidContentPolicy = 3,
  DraftlineError = 4,
  Panic = 5,
  CredentialRejected = 6,
} DraftlineMobileStatusCode;

/**
 * Credential kinds a mobile host can return to Draftline.
 */
typedef enum DraftlineMobileCredentialKind {
  Default = 0,
  UsernamePassword = 1,
  SshAgent = 2,
  SshKey = 3,
} DraftlineMobileCredentialKind;

/**
 * Opaque workspace handle owned by Draftline and passed across the C ABI.
 */
typedef struct DraftlineMobileWorkspace DraftlineMobileWorkspace;

/**
 * C-safe status with an optional heap-allocated error message.
 */
typedef struct DraftlineMobileStatus {
  enum DraftlineMobileStatusCode code;
  char *message;
} DraftlineMobileStatus;

/**
 * Result for functions that create or return a workspace handle.
 */
typedef struct DraftlineMobileWorkspaceResult {
  struct DraftlineMobileStatus status;
  struct DraftlineMobileWorkspace *workspace;
} DraftlineMobileWorkspaceResult;

/**
 * Host-owned content policy passed to open/clone.
 */
typedef struct DraftlineMobileContentPolicy {
  const char *const *include_paths;
  uintptr_t include_path_count;
  const char *const *exclude_paths;
  uintptr_t exclude_path_count;
  const char *const *include_extensions;
  uintptr_t include_extension_count;
  /**
   * Zero keeps Draftline's default threshold.
   */
  uint64_t large_file_threshold_bytes;
} DraftlineMobileContentPolicy;

/**
 * Credential request passed to the host callback.
 */
typedef struct DraftlineMobileCredentialRequest {
  const char *url;
  const char *username_from_url;
  bool allows_default;
  bool allows_username_password;
  bool allows_ssh_key;
} DraftlineMobileCredentialRequest;

/**
 * Credential material written by the host callback.
 *
 * Pointers are borrowed only for the duration of the callback invocation.
 */
typedef struct DraftlineMobileCredential {
  enum DraftlineMobileCredentialKind kind;
  const char *username;
  const char *password;
  const char *public_key_path;
  const char *private_key_path;
  const char *passphrase;
} DraftlineMobileCredential;

typedef enum DraftlineMobileStatusCode (*DraftlineMobileCredentialCallback)(const struct DraftlineMobileCredentialRequest *request,
                                                                            struct DraftlineMobileCredential *credential_out,
                                                                            void *user_data);

/**
 * Result for functions that return a heap-allocated UTF-8 string.
 */
typedef struct DraftlineMobileStringResult {
  struct DraftlineMobileStatus status;
  char *value;
} DraftlineMobileStringResult;

/**
 * Frees strings returned in `DraftlineMobileStatus.message` or
 * `DraftlineMobileStringResult.value`.
 *
 * # Safety
 *
 * `value` must be null or a pointer returned by Draftline mobile bridge string
 * allocation. Passing any other pointer is undefined behavior.
 */
void draftline_mobile_string_free(char *value);

/**
 * Frees an opaque workspace handle returned by Draftline.
 *
 * # Safety
 *
 * `workspace` must be null or a pointer returned by a Draftline mobile bridge
 * workspace creation function. It must not be used after this call.
 */
void draftline_mobile_workspace_free(struct DraftlineMobileWorkspace *workspace);

/**
 * Opens an existing workspace or initializes a new one at `path`.
 *
 * # Safety
 *
 * `path` must be a valid null-terminated UTF-8 string. `policy`, when non-null,
 * must point to a valid `DraftlineMobileContentPolicy` whose arrays remain valid
 * for the duration of this call.
 */
struct DraftlineMobileWorkspaceResult draftline_mobile_workspace_open_or_init(const char *path,
                                                                              const struct DraftlineMobileContentPolicy *policy);

/**
 * Clones a shared workspace from `remote_url` into `path`.
 *
 * # Safety
 *
 * String pointers must be valid null-terminated UTF-8. `policy`, when non-null,
 * and callback pointers must remain valid for the duration of this call.
 */
struct DraftlineMobileWorkspaceResult draftline_mobile_workspace_clone(const char *remote_url,
                                                                       const char *path,
                                                                       const struct DraftlineMobileContentPolicy *policy,
                                                                       DraftlineMobileCredentialCallback credential_callback,
                                                                       void *credential_user_data);

/**
 * Reads a policy-tracked UTF-8 file from the workspace.
 *
 * # Safety
 *
 * `workspace` must be a valid Draftline handle and `path` must be a valid
 * null-terminated UTF-8 workspace-relative path.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_read_file(struct DraftlineMobileWorkspace *workspace,
                                                                        const char *path);

/**
 * Writes bytes to a policy-tracked workspace-relative file.
 *
 * # Safety
 *
 * `workspace` must be a valid Draftline handle. `path` must be valid UTF-8.
 * `content` must point to `content_len` readable bytes unless `content_len` is
 * zero.
 */
struct DraftlineMobileStatus draftline_mobile_workspace_write_file(struct DraftlineMobileWorkspace *workspace,
                                                                   const char *path,
                                                                   const uint8_t *content,
                                                                   uintptr_t content_len);

/**
 * Saves current policy-tracked changes as a Draftline version and returns JSON.
 *
 * # Safety
 *
 * `workspace` must be a valid Draftline handle and `label` must be valid
 * null-terminated UTF-8.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_save_version_json(struct DraftlineMobileWorkspace *workspace,
                                                                                const char *label);

/**
 * Returns local workspace diagnostics/status as JSON.
 *
 * # Safety
 *
 * `workspace` must be a valid Draftline handle.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_status_json(struct DraftlineMobileWorkspace *workspace);

/**
 * Fetches remote-tracking state without changing workspace files.
 *
 * # Safety
 *
 * `workspace` must be valid and `remote` must be valid null-terminated UTF-8.
 * Callback pointers must remain valid for the duration of this call.
 */
struct DraftlineMobileStatus draftline_mobile_workspace_fetch_remote(struct DraftlineMobileWorkspace *workspace,
                                                                     const char *remote,
                                                                     DraftlineMobileCredentialCallback credential_callback,
                                                                     void *credential_user_data);

/**
 * Returns current variation sync status for a fetched remote as JSON.
 *
 * # Safety
 *
 * `workspace` must be valid and `remote` must be valid null-terminated UTF-8.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_sync_status_json(struct DraftlineMobileWorkspace *workspace,
                                                                               const char *remote);

/**
 * Returns apply-incoming preflight JSON using cached remote-tracking state.
 *
 * # Safety
 *
 * `workspace` must be valid and `remote` must be valid null-terminated UTF-8.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_preflight_apply_incoming_json(struct DraftlineMobileWorkspace *workspace,
                                                                                            const char *remote);

/**
 * Applies fast-forward incoming remote changes and returns result JSON.
 *
 * # Safety
 *
 * `workspace` must be valid and `remote` must be valid null-terminated UTF-8.
 * Callback pointers must remain valid for the duration of this call.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_apply_incoming_json(struct DraftlineMobileWorkspace *workspace,
                                                                                  const char *remote,
                                                                                  DraftlineMobileCredentialCallback credential_callback,
                                                                                  void *credential_user_data);

/**
 * Preflights shelving selected policy-tracked files, or all dirty files when `paths_json` is null.
 *
 * # Safety
 *
 * `workspace` must be valid and `name` must be valid null-terminated UTF-8.
 * `paths_json`, when non-null, must be a valid UTF-8 JSON array of workspace-relative path strings.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_preflight_shelve_json(struct DraftlineMobileWorkspace *workspace,
                                                                                    const char *name,
                                                                                    const char *paths_json);

/**
 * Shelves selected policy-tracked files, or all dirty files when `paths_json` is null.
 *
 * # Safety
 *
 * `workspace` must be valid and `name` must be valid null-terminated UTF-8.
 * `paths_json`, when non-null, must be a valid UTF-8 JSON array of workspace-relative path strings.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_shelve_json(struct DraftlineMobileWorkspace *workspace,
                                                                          const char *name,
                                                                          const char *paths_json);

/**
 * Lists local shelves as JSON.
 *
 * # Safety
 *
 * `workspace` must be a valid Draftline handle.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_list_shelves_json(struct DraftlineMobileWorkspace *workspace);

/**
 * Previews a shelf as JSON without mutating the workspace.
 *
 * # Safety
 *
 * `workspace` must be valid and `shelf_id` must be valid null-terminated UTF-8.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_preview_shelf_json(struct DraftlineMobileWorkspace *workspace,
                                                                                 const char *shelf_id);

/**
 * Preflights applying a shelf as JSON without mutating the workspace.
 *
 * # Safety
 *
 * `workspace` must be valid and `shelf_id` must be valid null-terminated UTF-8.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_preflight_apply_shelf_json(struct DraftlineMobileWorkspace *workspace,
                                                                                         const char *shelf_id);

/**
 * Applies a shelf as workspace content, preserving the shelf, and returns JSON.
 *
 * # Safety
 *
 * `workspace` must be valid and `shelf_id` must be valid null-terminated UTF-8.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_apply_shelf_json(struct DraftlineMobileWorkspace *workspace,
                                                                               const char *shelf_id);

/**
 * Deletes a shelf and returns JSON.
 *
 * # Safety
 *
 * `workspace` must be valid and `shelf_id` must be valid null-terminated UTF-8.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_delete_shelf_json(struct DraftlineMobileWorkspace *workspace,
                                                                                const char *shelf_id);

/**
 * Returns merge-incoming preflight JSON using cached remote-tracking state.
 *
 * # Safety
 *
 * `workspace` must be valid and `remote` must be valid null-terminated UTF-8.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_preflight_merge_incoming_json(struct DraftlineMobileWorkspace *workspace,
                                                                                            const char *remote);

/**
 * Converts merge-incoming preflight JSON into grouped conflict-view JSON.
 *
 * # Safety
 *
 * `merge_report_json` must be a valid null-terminated UTF-8 JSON
 * `MergeIncomingReport` returned by Draftline.
 */
struct DraftlineMobileStringResult draftline_mobile_merge_conflict_view_model_json(const char *merge_report_json);

/**
 * Writes a clean incoming merge using a preflight token and returns result JSON.
 *
 * # Safety
 *
 * `workspace` must be valid. String pointers must be valid null-terminated UTF-8.
 * Callback pointers must remain valid for this call.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_merge_incoming_json(struct DraftlineMobileWorkspace *workspace,
                                                                                  const char *token_json,
                                                                                  const char *label,
                                                                                  DraftlineMobileCredentialCallback credential_callback,
                                                                                  void *credential_user_data);

/**
 * Writes an incoming merge with explicit resolution JSON and returns result JSON.
 *
 * # Safety
 *
 * `workspace` must be valid. String pointers must be valid null-terminated UTF-8.
 * `resolutions_json` must be a JSON array of `MergeConflictResolution` values.
 * Callback pointers must remain valid for this call.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_merge_incoming_with_resolutions_json(struct DraftlineMobileWorkspace *workspace,
                                                                                                   const char *token_json,
                                                                                                   const char *label,
                                                                                                   const char *resolutions_json,
                                                                                                   DraftlineMobileCredentialCallback credential_callback,
                                                                                                   void *credential_user_data);

/**
 * Preflights guarded publication and returns JSON containing the publish token.
 *
 * # Safety
 *
 * `workspace` must be valid and `remote` must be valid null-terminated UTF-8.
 * Callback pointers must remain valid for the duration of this call.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_preflight_publish_json(struct DraftlineMobileWorkspace *workspace,
                                                                                     const char *remote,
                                                                                     DraftlineMobileCredentialCallback credential_callback,
                                                                                     void *credential_user_data);

/**
 * Publishes with a JSON token returned by preflight publish.
 *
 * # Safety
 *
 * `workspace` must be valid and `publish_token_json` must be valid
 * null-terminated UTF-8. Callback pointers must remain valid for this call.
 */
struct DraftlineMobileStringResult draftline_mobile_workspace_publish_json(struct DraftlineMobileWorkspace *workspace,
                                                                           const char *publish_token_json,
                                                                           DraftlineMobileCredentialCallback credential_callback,
                                                                           void *credential_user_data);
