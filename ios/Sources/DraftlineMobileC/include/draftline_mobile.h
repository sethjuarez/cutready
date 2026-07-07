#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

typedef enum DraftlineMobileStatusCode {
  Ok = 0,
  NullArgument = 1,
  InvalidUtf8 = 2,
  InvalidContentPolicy = 3,
  DraftlineError = 4,
  Panic = 5,
  CredentialRejected = 6,
} DraftlineMobileStatusCode;

typedef enum DraftlineMobileCredentialKind {
  Default = 0,
  UsernamePassword = 1,
  SshAgent = 2,
  SshKey = 3,
} DraftlineMobileCredentialKind;

typedef struct DraftlineMobileWorkspace DraftlineMobileWorkspace;

typedef struct DraftlineMobileStatus {
  enum DraftlineMobileStatusCode code;
  char *message;
} DraftlineMobileStatus;

typedef struct DraftlineMobileWorkspaceResult {
  struct DraftlineMobileStatus status;
  struct DraftlineMobileWorkspace *workspace;
} DraftlineMobileWorkspaceResult;

typedef struct DraftlineMobileContentPolicy {
  const char *const *include_paths;
  uintptr_t include_path_count;
  const char *const *exclude_paths;
  uintptr_t exclude_path_count;
  const char *const *include_extensions;
  uintptr_t include_extension_count;
  uint64_t large_file_threshold_bytes;
} DraftlineMobileContentPolicy;

typedef struct DraftlineMobileCredentialRequest {
  const char *url;
  const char *username_from_url;
  bool allows_default;
  bool allows_username_password;
  bool allows_ssh_key;
} DraftlineMobileCredentialRequest;

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

typedef struct DraftlineMobileStringResult {
  struct DraftlineMobileStatus status;
  char *value;
} DraftlineMobileStringResult;

void draftline_mobile_string_free(char *value);
void draftline_mobile_workspace_free(struct DraftlineMobileWorkspace *workspace);

struct DraftlineMobileWorkspaceResult draftline_mobile_workspace_open_or_init(const char *path,
                                                                              const struct DraftlineMobileContentPolicy *policy);

struct DraftlineMobileWorkspaceResult draftline_mobile_workspace_clone(const char *remote_url,
                                                                       const char *path,
                                                                       const struct DraftlineMobileContentPolicy *policy,
                                                                       DraftlineMobileCredentialCallback credential_callback,
                                                                       void *credential_user_data);

struct DraftlineMobileStringResult draftline_mobile_workspace_read_file(struct DraftlineMobileWorkspace *workspace,
                                                                        const char *path);

struct DraftlineMobileStatus draftline_mobile_workspace_write_file(struct DraftlineMobileWorkspace *workspace,
                                                                   const char *path,
                                                                   const uint8_t *content,
                                                                   uintptr_t content_len);

struct DraftlineMobileStringResult draftline_mobile_workspace_save_version_json(struct DraftlineMobileWorkspace *workspace,
                                                                                const char *label);

struct DraftlineMobileStringResult draftline_mobile_workspace_status_json(struct DraftlineMobileWorkspace *workspace);

struct DraftlineMobileStatus draftline_mobile_workspace_fetch_remote(struct DraftlineMobileWorkspace *workspace,
                                                                     const char *remote,
                                                                     DraftlineMobileCredentialCallback credential_callback,
                                                                     void *credential_user_data);

struct DraftlineMobileStringResult draftline_mobile_workspace_sync_status_json(struct DraftlineMobileWorkspace *workspace,
                                                                               const char *remote);

struct DraftlineMobileStringResult draftline_mobile_workspace_preflight_apply_incoming_json(struct DraftlineMobileWorkspace *workspace,
                                                                                            const char *remote);

struct DraftlineMobileStringResult draftline_mobile_workspace_apply_incoming_json(struct DraftlineMobileWorkspace *workspace,
                                                                                  const char *remote,
                                                                                  DraftlineMobileCredentialCallback credential_callback,
                                                                                  void *credential_user_data);

struct DraftlineMobileStringResult draftline_mobile_workspace_preflight_publish_json(struct DraftlineMobileWorkspace *workspace,
                                                                                     const char *remote,
                                                                                     DraftlineMobileCredentialCallback credential_callback,
                                                                                     void *credential_user_data);

struct DraftlineMobileStringResult draftline_mobile_workspace_publish_json(struct DraftlineMobileWorkspace *workspace,
                                                                           const char *publish_token_json,
                                                                           DraftlineMobileCredentialCallback credential_callback,
                                                                           void *credential_user_data);
