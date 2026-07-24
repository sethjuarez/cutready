//! Legacy-only conversions between CutReady execution types and Agentive.

use super::execution::{
    ChatMessage, ContentPart, ContextItem, ContextKind, ContextScope, ContextSource, FunctionCall,
    ImageUrl, LargeContextRef, MemoryPromotionCandidate, MessageContent, ResourceOperation,
    RunResult, ToolCall, ToolOutput, TouchedResource, Usage, VerificationResult,
    VerificationStatus,
};
use super::tools::{ToolDefinition, ToolFunctionDefinition};

pub fn message_to_agentive(message: ChatMessage) -> agentive::ChatMessage {
    agentive::ChatMessage {
        role: message.role,
        content: message.content.map(message_content_to_agentive),
        tool_calls: message
            .tool_calls
            .map(|calls| calls.into_iter().map(tool_call_to_agentive).collect()),
        tool_call_id: message.tool_call_id,
    }
}

pub fn message_from_agentive(message: agentive::ChatMessage) -> ChatMessage {
    ChatMessage {
        role: message.role,
        content: message.content.map(message_content_from_agentive),
        tool_calls: message
            .tool_calls
            .map(|calls| calls.into_iter().map(tool_call_from_agentive).collect()),
        tool_call_id: message.tool_call_id,
    }
}

pub fn context_item_to_agentive(item: ContextItem) -> agentive::ContextItem {
    let mut converted = agentive::ContextItem::new(
        item.id,
        context_source_to_agentive(item.source),
        item.name,
        item.description,
    )
    .with_kind(context_kind_to_agentive(item.kind))
    .with_priority(item.priority)
    .with_scope(context_scope_to_agentive(item.scope))
    .with_estimates(item.estimated_tokens, item.estimated_bytes);
    converted.read_count = item.read_count;
    converted.metadata = item.metadata;
    if let (Some(content), Some(content_type)) = (item.content, item.content_type) {
        converted = converted.with_content(content, content_type);
    }
    if let Some(reference) = item.large_ref {
        converted = converted.with_large_ref(large_context_ref_to_agentive(reference));
    }
    converted
}

pub fn run_result_from_agentive(result: agentive::RunnerResult) -> RunResult {
    RunResult {
        messages: result
            .messages
            .into_iter()
            .map(message_from_agentive)
            .collect(),
        response: result.response,
        new_messages: result
            .new_messages
            .into_iter()
            .map(message_from_agentive)
            .collect(),
        total_usage: usage_from_agentive(result.total_usage),
        run_id: result.run_id,
        parent_run_id: result.parent_run_id,
    }
}

pub fn tool_definition_to_agentive(definition: ToolDefinition) -> agentive::Tool {
    let ToolFunctionDefinition {
        name,
        description,
        parameters,
    } = definition.function;
    agentive::Tool::function(&name, &description, parameters)
}

pub fn tool_call_from_agentive(call: agentive::ToolCall) -> ToolCall {
    ToolCall {
        id: call.id,
        call_type: call.call_type,
        function: FunctionCall {
            name: call.function.name,
            arguments: call.function.arguments,
        },
    }
}

pub fn tool_output_to_agentive(output: ToolOutput) -> agentive::ToolOutput {
    match output {
        ToolOutput::Text(text) => agentive::ToolOutput::from(text),
        ToolOutput::WithImages { text, images } => agentive::ToolOutput::with_images(
            text,
            images.into_iter().map(content_part_to_agentive).collect(),
        ),
        ToolOutput::WithMetadata {
            output,
            touched_resources,
            verification_results,
            memory_promotions,
        } => tool_output_to_agentive(*output).with_metadata(
            touched_resources
                .into_iter()
                .map(touched_resource_to_agentive)
                .collect(),
            verification_results
                .into_iter()
                .map(verification_to_agentive)
                .collect(),
            memory_promotions
                .into_iter()
                .map(memory_promotion_to_agentive)
                .collect(),
        ),
    }
}

fn message_content_to_agentive(content: MessageContent) -> agentive::MessageContent {
    match content {
        MessageContent::Text(text) => agentive::MessageContent::Text(text),
        MessageContent::Parts(parts) => agentive::MessageContent::Parts(
            parts.into_iter().map(content_part_to_agentive).collect(),
        ),
    }
}

fn message_content_from_agentive(content: agentive::MessageContent) -> MessageContent {
    match content {
        agentive::MessageContent::Text(text) => MessageContent::Text(text),
        agentive::MessageContent::Parts(parts) => {
            MessageContent::Parts(parts.into_iter().map(content_part_from_agentive).collect())
        }
    }
}

fn content_part_to_agentive(part: ContentPart) -> agentive::ContentPart {
    match part {
        ContentPart::Text { text } => agentive::ContentPart::Text { text },
        ContentPart::ImageUrl { image_url } => agentive::ContentPart::ImageUrl {
            image_url: agentive::ImageUrl {
                url: image_url.url,
                detail: image_url.detail,
            },
        },
    }
}

fn content_part_from_agentive(part: agentive::ContentPart) -> ContentPart {
    match part {
        agentive::ContentPart::Text { text } => ContentPart::Text { text },
        agentive::ContentPart::ImageUrl { image_url } => ContentPart::ImageUrl {
            image_url: ImageUrl {
                url: image_url.url,
                detail: image_url.detail,
            },
        },
    }
}

fn tool_call_to_agentive(call: ToolCall) -> agentive::ToolCall {
    agentive::ToolCall {
        id: call.id,
        call_type: call.call_type,
        function: agentive::FunctionCall {
            name: call.function.name,
            arguments: call.function.arguments,
        },
    }
}

fn usage_from_agentive(usage: agentive::Usage) -> Usage {
    Usage {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    }
}

fn context_source_to_agentive(source: ContextSource) -> agentive::ContextSource {
    match source {
        ContextSource::User => agentive::ContextSource::User,
        ContextSource::System => agentive::ContextSource::System,
        ContextSource::ToolResult => agentive::ContextSource::ToolResult,
        ContextSource::File => agentive::ContextSource::File,
        ContextSource::Search => agentive::ContextSource::Search,
        ContextSource::Checkpoint => agentive::ContextSource::Checkpoint,
        ContextSource::Memory => agentive::ContextSource::Memory,
        ContextSource::Host => agentive::ContextSource::Host,
        ContextSource::Custom => agentive::ContextSource::Custom,
    }
}

fn context_kind_to_agentive(kind: ContextKind) -> agentive::ContextKind {
    match kind {
        ContextKind::RecentTurn => agentive::ContextKind::RecentTurn,
        ContextKind::MemoryFact => agentive::ContextKind::MemoryFact,
        ContextKind::ReferenceDoc => agentive::ContextKind::ReferenceDoc,
        ContextKind::ToolObservation => agentive::ContextKind::ToolObservation,
        ContextKind::FileExcerpt => agentive::ContextKind::FileExcerpt,
        ContextKind::WebExcerpt => agentive::ContextKind::WebExcerpt,
        ContextKind::ErrorTrace => agentive::ContextKind::ErrorTrace,
        ContextKind::MediaSummary => agentive::ContextKind::MediaSummary,
        ContextKind::Other => agentive::ContextKind::Other,
    }
}

fn context_scope_to_agentive(scope: ContextScope) -> agentive::ContextScope {
    match scope {
        ContextScope::Session => agentive::ContextScope::Session,
        ContextScope::Project => agentive::ContextScope::Project,
        ContextScope::User => agentive::ContextScope::User,
        ContextScope::Global => agentive::ContextScope::Global,
    }
}

fn large_context_ref_to_agentive(reference: LargeContextRef) -> agentive::LargeContextRef {
    let mut converted = agentive::LargeContextRef::new(reference.id, reference.expand_tool);
    if let Some(bytes) = reference.bytes {
        converted = converted.with_bytes(bytes);
    }
    if let Some(hash) = reference.hash {
        converted = converted.with_hash(hash);
    }
    converted
}

fn resource_operation_to_agentive(operation: ResourceOperation) -> agentive::ResourceOperation {
    match operation {
        ResourceOperation::Read => agentive::ResourceOperation::Read,
        ResourceOperation::Write => agentive::ResourceOperation::Write,
        ResourceOperation::Create => agentive::ResourceOperation::Create,
        ResourceOperation::Update => agentive::ResourceOperation::Update,
        ResourceOperation::Delete => agentive::ResourceOperation::Delete,
        ResourceOperation::Execute => agentive::ResourceOperation::Execute,
        ResourceOperation::Search => agentive::ResourceOperation::Search,
        ResourceOperation::Inspect => agentive::ResourceOperation::Inspect,
        ResourceOperation::Reference => agentive::ResourceOperation::Reference,
        ResourceOperation::Custom => agentive::ResourceOperation::Custom,
    }
}

fn touched_resource_to_agentive(resource: TouchedResource) -> agentive::TouchedResource {
    agentive::TouchedResource {
        kind: resource.kind,
        id: resource.id,
        operation: resource_operation_to_agentive(resource.operation),
        metadata: resource.metadata,
    }
}

fn verification_to_agentive(result: VerificationResult) -> agentive::VerificationResult {
    agentive::VerificationResult::new(
        result.criterion,
        match result.status {
            VerificationStatus::Passed => agentive::VerificationStatus::Passed,
            VerificationStatus::Failed => agentive::VerificationStatus::Failed,
            VerificationStatus::Skipped => agentive::VerificationStatus::Skipped,
            VerificationStatus::Blocked => agentive::VerificationStatus::Blocked,
            VerificationStatus::Unknown => agentive::VerificationStatus::Unknown,
        },
        result.evidence_summary,
    )
}

fn memory_promotion_to_agentive(
    candidate: MemoryPromotionCandidate,
) -> agentive::MemoryPromotionCandidate {
    agentive::MemoryPromotionCandidate {
        content_summary: candidate.content_summary,
        category: candidate.category,
        tags: candidate.tags,
        confidence_basis_points: candidate.confidence_basis_points,
        metadata: candidate.metadata,
    }
}
