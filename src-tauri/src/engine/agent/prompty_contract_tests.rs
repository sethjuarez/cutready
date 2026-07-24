//! CutReady-owned contract tests for the pinned low-level Prompty turn engine.
//!
//! These tests intentionally avoid Prompty's high-level live wrapper and Agentive.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use prompty::{
    AppendContextPackingStrategy, CancellationToken, Clock, ContextCandidate, ContextError,
    ContextPipeline, ContextRequest, ContextSource, DefaultConversationPort, DurabilityPort,
    EngineCheckpoint, EngineEvent, EngineEventKind, EnginePermissionDecision, EngineToolRequest,
    EngineToolResult, FinalOutputPolicyRequest, FinalOutputPolicyResult, HostPolicyError,
    HostPolicyPort, HostPolicyRequest, HostPolicyResult, IdGenerator, Message,
    ModelInvocationRequest, ModelInvocationResponse, ModelPort, ModelStreamChunk, ModelStreamPort,
    NoopHostPolicyPort, NoopRetryPolicyPort, PermissionPort, PortError, PostCommitPort, Role,
    ToolOutcome, ToolPort, TurnCommit, TurnEngine, TurnEngineEffects, TurnEngineError,
    TurnEngineRequest, TurnStatus,
};
use serde_json::{json, Value};

enum ModelStep {
    Success {
        chunks: Vec<ModelStreamChunk>,
        response: ModelInvocationResponse,
    },
    Failure {
        chunks: Vec<ModelStreamChunk>,
        message: String,
        indeterminate: bool,
    },
}

impl ModelStep {
    fn success(response: ModelInvocationResponse) -> Self {
        Self::Success {
            chunks: Vec::new(),
            response,
        }
    }

    fn failure(message: &str) -> Self {
        Self::Failure {
            chunks: Vec::new(),
            message: message.into(),
            indeterminate: false,
        }
    }
}

struct ScriptedModel {
    steps: Mutex<VecDeque<ModelStep>>,
    requests: Mutex<Vec<ModelInvocationRequest>>,
    calls: AtomicUsize,
}

impl ScriptedModel {
    fn new(steps: impl IntoIterator<Item = ModelStep>) -> Arc<Self> {
        Arc::new(Self {
            steps: Mutex::new(steps.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
            calls: AtomicUsize::new(0),
        })
    }
}

#[async_trait]
impl ModelPort for ScriptedModel {
    async fn invoke(
        &self,
        request: &ModelInvocationRequest,
        _cancellation: &CancellationToken,
        stream: &dyn ModelStreamPort,
    ) -> Result<ModelInvocationResponse, PortError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push(request.clone());
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted model step");
        match step {
            ModelStep::Success { chunks, response } => {
                for chunk in chunks {
                    stream.emit(chunk).await;
                }
                Ok(response)
            }
            ModelStep::Failure {
                chunks,
                message,
                indeterminate,
            } => {
                for chunk in chunks {
                    stream.emit(chunk).await;
                }
                if indeterminate {
                    Err(PortError::indeterminate(message))
                } else {
                    Err(PortError::new(message))
                }
            }
        }
    }
}

fn final_response(text: &str) -> ModelInvocationResponse {
    ModelInvocationResponse {
        output: Some(Value::String(text.into())),
        usage: None,
        assistant_messages: vec![Message::with_text(Role::Assistant, text)],
        tool_requests: Vec::new(),
        next_portability: None,
        delegated_state: None,
        metadata: Value::Null,
    }
}

fn tool_request(id: &str, name: &str, arguments: Value) -> EngineToolRequest {
    EngineToolRequest {
        id: id.into(),
        name: name.into(),
        arguments,
        metadata: Value::Null,
    }
}

fn tool_response(requests: Vec<EngineToolRequest>) -> ModelInvocationResponse {
    let tool_calls = requests
        .iter()
        .map(|request| {
            json!({
                "id": request.id,
                "type": "function",
                "function": {
                    "name": request.name,
                    "arguments": request.arguments.to_string(),
                },
            })
        })
        .collect::<Vec<_>>();
    ModelInvocationResponse {
        output: None,
        usage: None,
        assistant_messages: vec![Message {
            role: Role::Assistant,
            parts: Vec::new(),
            metadata: json!({ "tool_calls": tool_calls }),
        }],
        tool_requests: requests,
        next_portability: None,
        delegated_state: None,
        metadata: Value::Null,
    }
}

#[derive(Default)]
struct RecordingStream(Mutex<Vec<ModelStreamChunk>>);

#[async_trait]
impl ModelStreamPort for RecordingStream {
    async fn emit(&self, chunk: ModelStreamChunk) {
        self.0.lock().unwrap().push(chunk);
    }
}

struct RecordingPermissions {
    denied: HashSet<String>,
    decisions: Mutex<Vec<(String, bool)>>,
}

#[async_trait]
impl PermissionPort for RecordingPermissions {
    async fn authorize(
        &self,
        request: &EngineToolRequest,
        _cancellation: &CancellationToken,
    ) -> Result<EnginePermissionDecision, PortError> {
        let approved = !self.denied.contains(&request.id);
        self.decisions
            .lock()
            .unwrap()
            .push((request.id.clone(), approved));
        Ok(EnginePermissionDecision {
            approved,
            reason: (!approved).then(|| "Denied by CutReady audit policy".into()),
            metadata: json!({ "errorKind": "permission_denied" }),
        })
    }
}

struct RecordingTools {
    outputs: HashMap<String, String>,
    calls: Mutex<Vec<EngineToolRequest>>,
}

#[async_trait]
impl ToolPort for RecordingTools {
    async fn execute(
        &self,
        request: &EngineToolRequest,
        _cancellation: &CancellationToken,
    ) -> Result<EngineToolResult, PortError> {
        self.calls.lock().unwrap().push(request.clone());
        Ok(EngineToolResult {
            request_id: request.id.clone(),
            name: request.name.clone(),
            outcome: ToolOutcome::Success,
            output: Value::String(
                self.outputs
                    .get(&request.id)
                    .cloned()
                    .unwrap_or_else(|| "ok".into()),
            ),
            error_kind: None,
            metadata: Value::Null,
        })
    }
}

#[derive(Default)]
struct RecordingDurability {
    events: Mutex<Vec<EngineEvent>>,
    checkpoints: Mutex<Vec<EngineCheckpoint>>,
    fail_append: AtomicBool,
    fail_checkpoint_call: AtomicUsize,
    checkpoint_calls: AtomicUsize,
}

impl RecordingDurability {
    fn failing_append() -> Arc<Self> {
        Arc::new(Self {
            fail_append: AtomicBool::new(true),
            ..Self::default()
        })
    }

    fn failing_checkpoint(call: usize) -> Arc<Self> {
        Arc::new(Self {
            fail_checkpoint_call: AtomicUsize::new(call),
            ..Self::default()
        })
    }
}

#[async_trait]
impl DurabilityPort for RecordingDurability {
    async fn append(&self, event: &EngineEvent) -> Result<(), PortError> {
        if self.fail_append.swap(false, Ordering::SeqCst) {
            return Err(PortError::new("injected append failure"));
        }
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }

    async fn append_with_checkpoint(
        &self,
        events: &[EngineEvent],
        checkpoint: &EngineCheckpoint,
    ) -> Result<(), PortError> {
        let call = self.checkpoint_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_checkpoint_call.load(Ordering::SeqCst) == call {
            return Err(PortError::new("injected checkpoint failure"));
        }
        self.events.lock().unwrap().extend_from_slice(events);
        self.checkpoints.lock().unwrap().push(checkpoint.clone());
        Ok(())
    }
}

struct FailingPostCommit;

#[async_trait]
impl PostCommitPort for FailingPostCommit {
    async fn after_commit(
        &self,
        _effect_id: &str,
        _commit: &TurnCommit,
        _cancellation: &CancellationToken,
    ) -> Result<(), PortError> {
        Err(PortError::new("injected callback failure"))
    }
}

struct NoopTools;

#[async_trait]
impl ToolPort for NoopTools {
    async fn execute(
        &self,
        request: &EngineToolRequest,
        _cancellation: &CancellationToken,
    ) -> Result<EngineToolResult, PortError> {
        panic!("unexpected tool invocation: {}", request.id);
    }
}

struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> String {
        "2026-07-22T00:00:00Z".into()
    }
}

#[derive(Default)]
struct SequentialIds(AtomicU64);

impl IdGenerator for SequentialIds {
    fn next_id(&self, kind: &str) -> String {
        format!("{kind}-{}", self.0.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

fn engine(
    model: Arc<dyn ModelPort>,
    tools: Arc<dyn ToolPort>,
    permission: Arc<dyn PermissionPort>,
    durability: Arc<dyn DurabilityPort>,
    stream: Arc<dyn ModelStreamPort>,
    policy: Arc<dyn HostPolicyPort>,
    post_commit: Arc<dyn PostCommitPort>,
) -> TurnEngine {
    engine_with_context(
        ContextPipeline::new(Arc::new(AppendContextPackingStrategy)),
        model,
        tools,
        permission,
        durability,
        stream,
        policy,
        post_commit,
    )
}

#[allow(clippy::too_many_arguments)]
fn engine_with_context(
    context: ContextPipeline,
    model: Arc<dyn ModelPort>,
    tools: Arc<dyn ToolPort>,
    permission: Arc<dyn PermissionPort>,
    durability: Arc<dyn DurabilityPort>,
    stream: Arc<dyn ModelStreamPort>,
    policy: Arc<dyn HostPolicyPort>,
    post_commit: Arc<dyn PostCommitPort>,
) -> TurnEngine {
    TurnEngine::new(
        context,
        TurnEngineEffects {
            model,
            stream,
            policy,
            retry: Arc::new(NoopRetryPolicyPort),
            conversation: Arc::new(DefaultConversationPort),
            permission,
            tools,
            durability,
            post_commit,
            clock: Arc::new(FixedClock),
            ids: Arc::new(SequentialIds::default()),
        },
    )
}

fn allow_all() -> Arc<RecordingPermissions> {
    Arc::new(RecordingPermissions {
        denied: HashSet::new(),
        decisions: Mutex::new(Vec::new()),
    })
}

fn request(session_id: &str, turn_id: &str) -> TurnEngineRequest {
    TurnEngineRequest::new(
        session_id,
        turn_id,
        vec![Message::with_text(Role::User, "run the contract")],
    )
}

#[tokio::test]
async fn prompty_multi_round_permissions_arguments_and_post_commit_are_durable() {
    let first = tool_request(
        "call-read",
        "read",
        json!({ "path": "storyboard.cut", "limit": 4 }),
    );
    let denied = tool_request(
        "call-write",
        "write",
        json!({ "path": "storyboard.cut", "value": "blocked" }),
    );
    let model = ScriptedModel::new([
        ModelStep::success(tool_response(vec![first.clone()])),
        ModelStep::success(tool_response(vec![denied.clone()])),
        ModelStep::success(final_response("done")),
    ]);
    let tools = Arc::new(RecordingTools {
        outputs: HashMap::from([("call-read".into(), "four clips".into())]),
        calls: Mutex::new(Vec::new()),
    });
    let permission = Arc::new(RecordingPermissions {
        denied: HashSet::from(["call-write".into()]),
        decisions: Mutex::new(Vec::new()),
    });
    let durability = Arc::new(RecordingDurability::default());
    let result = engine(
        model.clone(),
        tools.clone(),
        permission.clone(),
        durability.clone(),
        Arc::new(RecordingStream::default()),
        Arc::new(NoopHostPolicyPort),
        Arc::new(FailingPostCommit),
    )
    .run(
        request("cutready-session", "cutready-turn"),
        CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(result.commit.status, TurnStatus::Success);
    assert_eq!(result.commit.session_id, "cutready-session");
    assert_eq!(result.commit.turn_id, "cutready-turn");
    assert_eq!(result.commit.output, Some(Value::String("done".into())));
    assert_eq!(
        result.post_commit_error.as_deref(),
        Some("injected callback failure")
    );
    assert_eq!(
        permission.decisions.lock().unwrap().as_slice(),
        &[("call-read".into(), true), ("call-write".into(), false)]
    );
    let calls = tools.calls.lock().unwrap();
    assert_eq!(calls.len(), 1, "denied tools must never execute");
    assert_eq!(calls[0].id, "call-read");
    assert_eq!(calls[0].arguments, first.arguments);
    drop(calls);

    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests[1].context.messages[1].metadata["tool_calls"][0]["id"],
        "call-read"
    );
    assert_eq!(
        requests[1].context.messages[2].metadata["tool_call_id"],
        "call-read"
    );
    assert_eq!(
        requests[2].context.messages[3].metadata["tool_calls"][0]["id"],
        "call-write"
    );
    assert_eq!(
        requests[2].context.messages[4].metadata["tool_call_id"],
        "call-write"
    );
    assert_eq!(
        requests[2].context.messages[4].text_content(),
        "Denied by CutReady audit policy"
    );
    drop(requests);

    let committed_results = durability
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.kind == EngineEventKind::ToolResultCommitted)
        .map(|event| {
            event.payload["toolResult"]["request_id"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(committed_results, ["call-read", "call-write"]);
}

#[tokio::test]
async fn prompty_persistence_failures_resume_without_duplicate_model_or_tool_effects() {
    let append_model = ScriptedModel::new([ModelStep::success(final_response("unused"))]);
    let append_error = engine(
        append_model.clone(),
        Arc::new(NoopTools),
        allow_all(),
        RecordingDurability::failing_append(),
        Arc::new(RecordingStream::default()),
        Arc::new(NoopHostPolicyPort),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(
        request("append-session", "append-turn"),
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        append_error,
        TurnEngineError::Port {
            stage: "event journal",
            ..
        }
    ));
    assert_eq!(append_model.calls.load(Ordering::SeqCst), 0);

    let initial_model =
        ScriptedModel::new([ModelStep::success(tool_response(vec![tool_request(
            "call-once",
            "write-once",
            json!({ "value": 7 }),
        )]))]);
    let tools = Arc::new(RecordingTools {
        outputs: HashMap::from([("call-once".into(), "persisted".into())]),
        calls: Mutex::new(Vec::new()),
    });
    let failing_durability = RecordingDurability::failing_checkpoint(2);
    let error = engine(
        initial_model.clone(),
        tools.clone(),
        allow_all(),
        failing_durability.clone(),
        Arc::new(RecordingStream::default()),
        Arc::new(NoopHostPolicyPort),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(
        request("resume-session", "resume-turn"),
        CancellationToken::new(),
    )
    .await
    .unwrap_err();

    let checkpoint = match error {
        TurnEngineError::RecoveryRequired {
            stage, checkpoint, ..
        } => {
            assert_eq!(stage, "tool result");
            *checkpoint
        }
        other => panic!("expected recovery checkpoint, got {other}"),
    };
    assert_eq!(checkpoint.session_id, "resume-session");
    assert_eq!(checkpoint.turn_id, "resume-turn");
    assert_eq!(checkpoint.completed_tool_results.len(), 1);
    assert!(checkpoint.pending_model_response.is_some());
    assert_eq!(initial_model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(tools.calls.lock().unwrap().len(), 1);

    let last_persisted_sequence = failing_durability
        .events
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .sequence;
    let resumed_model = ScriptedModel::new([ModelStep::success(final_response("resumed"))]);
    let resumed_durability = Arc::new(RecordingDurability::default());
    let resumed = engine(
        resumed_model.clone(),
        tools.clone(),
        allow_all(),
        resumed_durability.clone(),
        Arc::new(RecordingStream::default()),
        Arc::new(NoopHostPolicyPort),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(
        TurnEngineRequest::resume_from(&checkpoint, 3, last_persisted_sequence),
        CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(resumed.commit.status, TurnStatus::Success);
    assert_eq!(resumed.commit.session_id, "resume-session");
    assert_eq!(resumed.commit.turn_id, "resume-turn");
    assert_eq!(initial_model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        resumed_model.calls.load(Ordering::SeqCst),
        1,
        "only the next model iteration should run"
    );
    assert_eq!(
        tools.calls.lock().unwrap().len(),
        1,
        "the committed tool effect must not replay"
    );
    assert_eq!(
        resumed_model.requests.lock().unwrap()[0].context.iteration,
        1
    );
    assert!(resumed_model.requests.lock().unwrap()[0]
        .context
        .messages
        .iter()
        .any(|message| message.text_content() == "persisted"));

    let events = resumed_durability.events.lock().unwrap();
    assert!(events
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
    assert!(events
        .iter()
        .all(|event| event.session_id == "resume-session" && event.turn_id == "resume-turn"));
    assert!(events[0].sequence > checkpoint.last_sequence);
    for checkpoint in resumed_durability.checkpoints.lock().unwrap().iter() {
        let marker = events
            .iter()
            .find(|event| {
                event.kind == EngineEventKind::CheckpointCreated
                    && event.payload["checkpointId"] == checkpoint.id
            })
            .unwrap();
        assert_eq!(marker.sequence, checkpoint.last_sequence + 1);
        assert_eq!(
            marker.payload["includedThroughSequence"].as_u64(),
            Some(checkpoint.last_sequence)
        );
    }
}

#[tokio::test]
async fn prompty_indeterminate_partial_model_output_reconciles_without_reinvocation() {
    let model = ScriptedModel::new([ModelStep::Failure {
        chunks: vec![ModelStreamChunk::Text("partial".into())],
        message: "provider outcome unknown".into(),
        indeterminate: true,
    }]);
    let stream = Arc::new(RecordingStream::default());
    let durability = Arc::new(RecordingDurability::default());
    let result = engine(
        model.clone(),
        Arc::new(NoopTools),
        allow_all(),
        durability.clone(),
        stream.clone(),
        Arc::new(NoopHostPolicyPort),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(
        request("reconcile-session", "reconcile-turn"),
        CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(result.commit.status, TurnStatus::ReconciliationRequired);
    assert_eq!(
        result.commit.output.as_ref().unwrap()["errorKind"],
        "model_outcome_unknown"
    );
    assert_eq!(
        stream.0.lock().unwrap().as_slice(),
        &[ModelStreamChunk::Text("partial".into())]
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let checkpoint = durability
        .checkpoints
        .lock()
        .unwrap()
        .iter()
        .find(|checkpoint| checkpoint.model_reconciliation.is_some())
        .unwrap()
        .clone();
    let never_invoke = ScriptedModel::new([ModelStep::failure("must not invoke")]);
    let resumed_request = TurnEngineRequest::resume_after_model_reconciliation(
        &checkpoint,
        3,
        result.commit.last_sequence,
        final_response("host-confirmed response"),
    )
    .unwrap();
    let resumed = engine(
        never_invoke.clone(),
        Arc::new(NoopTools),
        allow_all(),
        Arc::new(RecordingDurability::default()),
        Arc::new(RecordingStream::default()),
        Arc::new(NoopHostPolicyPort),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(resumed_request, CancellationToken::new())
    .await
    .unwrap();

    assert_eq!(resumed.commit.status, TurnStatus::Success);
    assert_eq!(
        resumed.commit.output,
        Some(Value::String("host-confirmed response".into()))
    );
    assert_eq!(resumed.commit.session_id, "reconcile-session");
    assert_eq!(resumed.commit.turn_id, "reconcile-turn");
    assert_eq!(never_invoke.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn prompty_retries_reuse_snapshot_and_exhaustion_never_commits_partial_output() {
    let recovered = ScriptedModel::new([
        ModelStep::failure("retry me"),
        ModelStep::success(final_response("recovered")),
    ]);
    let recovered_result = engine(
        recovered.clone(),
        Arc::new(NoopTools),
        allow_all(),
        Arc::new(RecordingDurability::default()),
        Arc::new(RecordingStream::default()),
        Arc::new(NoopHostPolicyPort),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(
        request("retry-session", "retry-turn"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(recovered_result.commit.status, TurnStatus::Success);
    assert_eq!(recovered_result.snapshots.len(), 1);
    {
        let requests = recovered.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].context, requests[1].context);
    }

    let stream = Arc::new(RecordingStream::default());
    let exhausted = ScriptedModel::new([
        ModelStep::Failure {
            chunks: vec![ModelStreamChunk::Text("not durable".into())],
            message: "first failure".into(),
            indeterminate: false,
        },
        ModelStep::failure("second failure"),
    ]);
    let mut exhausted_request = request("exhausted-session", "exhausted-turn");
    exhausted_request.max_model_attempts = 2;
    let exhausted_result = engine(
        exhausted.clone(),
        Arc::new(NoopTools),
        allow_all(),
        Arc::new(RecordingDurability::default()),
        stream.clone(),
        Arc::new(NoopHostPolicyPort),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(exhausted_request, CancellationToken::new())
    .await
    .unwrap();
    assert_eq!(exhausted_result.commit.status, TurnStatus::Failed);
    assert_eq!(
        exhausted_result.commit.output.as_ref().unwrap()["errorKind"],
        "model_error"
    );
    assert_ne!(
        exhausted_result.commit.output,
        Some(Value::String("not durable".into()))
    );
    assert_eq!(exhausted.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        stream.0.lock().unwrap().as_slice(),
        &[ModelStreamChunk::Text("not durable".into())]
    );
}

struct ContractPolicy {
    steering: Option<&'static str>,
    input_failure: bool,
    output_failure: bool,
}

#[async_trait]
impl HostPolicyPort for ContractPolicy {
    async fn before_model(
        &self,
        mut request: HostPolicyRequest,
        _cancellation: &CancellationToken,
    ) -> Result<HostPolicyResult, HostPolicyError> {
        if self.input_failure {
            return Err(HostPolicyError::new(
                "input_guardrail_denied",
                "input rejected",
            ));
        }
        if let Some(steering) = self.steering {
            request
                .messages
                .push(Message::with_text(Role::User, steering));
        }
        Ok(HostPolicyResult {
            messages: request.messages,
            stable_prefix_messages: request.stable_prefix_messages,
            metadata: json!({ "steeringApplied": self.steering.is_some() }),
        })
    }

    async fn before_commit(
        &self,
        request: FinalOutputPolicyRequest,
        _cancellation: &CancellationToken,
    ) -> Result<FinalOutputPolicyResult, HostPolicyError> {
        if self.output_failure {
            return Err(HostPolicyError::new(
                "output_guardrail_denied",
                "output rejected",
            ));
        }
        Ok(FinalOutputPolicyResult {
            output: request.output,
            metadata: Value::Null,
        })
    }
}

struct AuditContextSource;

#[async_trait]
impl ContextSource for AuditContextSource {
    fn name(&self) -> &str {
        "cutready-audit"
    }

    async fn load(&self, _request: &ContextRequest) -> Result<Vec<ContextCandidate>, ContextError> {
        Ok(vec![ContextCandidate {
            id: "context-1".into(),
            source: "cutready".into(),
            messages: vec![Message::with_text(Role::System, "packed CutReady context")],
            metadata: Value::Null,
        }])
    }
}

#[tokio::test]
async fn prompty_policy_guardrails_steering_and_context_have_typed_effects() {
    let model = ScriptedModel::new([ModelStep::success(final_response("accepted"))]);
    let result = engine_with_context(
        ContextPipeline::new(Arc::new(AppendContextPackingStrategy))
            .with_source(Arc::new(AuditContextSource)),
        model.clone(),
        Arc::new(NoopTools),
        allow_all(),
        Arc::new(RecordingDurability::default()),
        Arc::new(RecordingStream::default()),
        Arc::new(ContractPolicy {
            steering: Some("steer toward the selected clip"),
            input_failure: false,
            output_failure: false,
        }),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(
        request("policy-session", "policy-turn"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.commit.status, TurnStatus::Success);
    let messages = model.requests.lock().unwrap()[0].context.messages.clone();
    assert!(messages
        .iter()
        .any(|message| message.text_content() == "steer toward the selected clip"));
    assert!(messages
        .iter()
        .any(|message| message.text_content() == "packed CutReady context"));

    let denied_model = ScriptedModel::new([ModelStep::success(final_response("unused"))]);
    let denied = engine(
        denied_model.clone(),
        Arc::new(NoopTools),
        allow_all(),
        Arc::new(RecordingDurability::default()),
        Arc::new(RecordingStream::default()),
        Arc::new(ContractPolicy {
            steering: None,
            input_failure: true,
            output_failure: false,
        }),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(
        request("input-policy-session", "input-policy-turn"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(denied.commit.status, TurnStatus::Failed);
    assert_eq!(
        denied.commit.output.as_ref().unwrap()["errorKind"],
        "input_guardrail_denied"
    );
    assert_eq!(denied_model.calls.load(Ordering::SeqCst), 0);

    let output_denied = engine(
        ScriptedModel::new([ModelStep::success(final_response("blocked output"))]),
        Arc::new(NoopTools),
        allow_all(),
        Arc::new(RecordingDurability::default()),
        Arc::new(RecordingStream::default()),
        Arc::new(ContractPolicy {
            steering: None,
            input_failure: false,
            output_failure: true,
        }),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(
        request("output-policy-session", "output-policy-turn"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(output_denied.commit.status, TurnStatus::Failed);
    assert_eq!(
        output_denied.commit.output.as_ref().unwrap()["errorKind"],
        "output_guardrail_denied"
    );
}

#[tokio::test]
async fn prompty_cancellation_before_invocation_has_no_model_or_tool_effects() {
    let model = ScriptedModel::new([ModelStep::success(final_response("unused"))]);
    let tools = Arc::new(RecordingTools {
        outputs: HashMap::new(),
        calls: Mutex::new(Vec::new()),
    });
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let result = engine(
        model.clone(),
        tools.clone(),
        allow_all(),
        Arc::new(RecordingDurability::default()),
        Arc::new(RecordingStream::default()),
        Arc::new(NoopHostPolicyPort),
        Arc::new(prompty::NoopPostCommitPort),
    )
    .run(request("cancel-session", "cancel-turn"), cancellation)
    .await
    .unwrap();

    assert_eq!(result.commit.status, TurnStatus::Cancelled);
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    assert!(tools.calls.lock().unwrap().is_empty());
}
