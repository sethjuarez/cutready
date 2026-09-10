//! Visual document normalization and validation.
//!
//! Pure, model-agnostic rules for canonicalizing Elucim DSL visual documents
//! into CutReady's stored v2 format, migrating legacy shapes, and validating
//! timelines and state machines. Both ordinary sketch commands and the agent
//! tool layer share this codec, so the durable visual-format policy is not
//! tied to the model-facing tool dispatcher.
//!
//! Extracted verbatim from `engine::agent::tools` (issue #267); behavior is
//! unchanged.

use serde_json::{json, Value};


// Valid elucim DSL root node types
const VALID_ROOT_TYPES: &[&str] = &["scene", "player", "presentation"];

// Valid elucim DSL child node types
const VALID_NODE_TYPES: &[&str] = &[
    "circle",
    "rect",
    "line",
    "arrow",
    "text",
    "group",
    "polygon",
    "image",
    "axes",
    "latex",
    "graph",
    "matrix",
    "barChart",
    "slide",
    "bezierCurve",
    "codeBlock",
];

const V2_LAYOUT_KEYS: &[&str] = &[
    "x",
    "y",
    "width",
    "height",
    "cx",
    "cy",
    "r",
    "x1",
    "y1",
    "x2",
    "y2",
    "rotation",
    "rotationOrigin",
    "scale",
    "translate",
    "zIndex",
];

pub(crate) fn normalize_visual_document_for_save(visual: &Value) -> Result<Value, String> {
    let mut normalized = normalize_visual_to_v2(visual)?;
    ensure_default_state_machine_for_timelines(&mut normalized)?;
    validate_agentic_visual(&normalized)?;
    Ok(normalized)
}

pub(crate) fn normalize_visual_to_v2(visual: &Value) -> Result<Value, String> {
    match visual.get("version") {
        Some(Value::String(version)) if version == "2.0" => {
            let mut normalized = visual.clone();
            sanitize_v2_scene_duration(&mut normalized);
            validate_v2_doc(&normalized)?;
            Ok(normalized)
        }
        Some(Value::String(version)) if version == "1.0" => migrate_v1_visual_to_v2(visual),
        Some(Value::Number(version))
            if version.as_i64() == Some(1) && visual.get("root").is_some() =>
        {
            let mut coerced = visual.clone();
            if let Some(obj) = coerced.as_object_mut() {
                obj.insert("version".into(), Value::String("1.0".into()));
            }
            migrate_v1_visual_to_v2(&coerced)
        }
        Some(Value::String(version)) if version == "1" && visual.get("root").is_some() => {
            let mut coerced = visual.clone();
            if let Some(obj) = coerced.as_object_mut() {
                obj.insert("version".into(), Value::String("1.0".into()));
            }
            migrate_v1_visual_to_v2(&coerced)
        }
        Some(Value::Number(version)) if version.as_i64() == Some(1) => {
            migrate_legacy_rootless_to_v2(visual)
        }
        Some(Value::String(version)) if version == "1" => migrate_legacy_rootless_to_v2(visual),
        Some(v) => Err(format!("version: expected \"2.0\" or \"1.0\", got {v}")),
        None if visual.get("root").is_some() => {
            let mut coerced = visual.clone();
            if let Some(obj) = coerced.as_object_mut() {
                obj.insert("version".into(), Value::String("1.0".into()));
            }
            migrate_v1_visual_to_v2(&coerced)
        }
        None if visual.get("scene").is_some() && visual.get("elements").is_some() => {
            let mut coerced = visual.clone();
            if let Some(obj) = coerced.as_object_mut() {
                obj.insert("version".into(), Value::String("2.0".into()));
            }
            validate_v2_doc(&coerced)?;
            Ok(coerced)
        }
        None => Err("missing required field \"version\"".into()),
    }
}

fn sanitize_v2_scene_duration(visual: &mut Value) {
    if let Some(scene) = visual.get_mut("scene").and_then(|v| v.as_object_mut()) {
        scene.remove("durationInFrames");
    }
}

fn ensure_default_state_machine_for_timelines(visual: &mut Value) -> Result<(), String> {
    let mut timeline_ids = visual
        .get("timelines")
        .and_then(|v| v.as_object())
        .map(|timelines| timelines.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    timeline_ids.sort();
    if timeline_ids.is_empty() {
        return Ok(());
    }

    let doc = visual
        .as_object_mut()
        .ok_or_else(|| "document: must be an object".to_string())?;
    let default_is_valid = doc
        .get("defaultStateMachine")
        .and_then(|v| v.as_str())
        .is_some_and(|id| {
            doc.get("stateMachines")
                .and_then(|v| v.as_object())
                .is_some_and(|machines| machines.contains_key(id))
        });
    if default_is_valid {
        return Ok(());
    }

    let existing_machine_ids = doc
        .get("stateMachines")
        .and_then(|v| v.as_object())
        .map(|machines| {
            machines
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();
    let machine_id = reserve_unique_id("main", &existing_machine_ids);
    let machines = doc
        .entry("stateMachines")
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| "stateMachines: must be an object".to_string())?;
    let mut states = serde_json::Map::new();
    let mut transitions = Vec::new();
    let mut state_ids = Vec::new();
    for timeline_id in timeline_ids {
        let state_id = reserve_unique_id(
            &reserve_state_id(&timeline_id),
            &state_ids.iter().cloned().collect(),
        );
        states.insert(state_id.clone(), json!({ "timeline": timeline_id }));
        state_ids.push(state_id);
    }
    let entry_state_id = state_ids
        .first()
        .cloned()
        .ok_or_else(|| "timelines: missing timeline ids".to_string())?;
    transitions.push(json!({
        "id": "entry-start",
        "from": "entry",
        "to": entry_state_id,
        "trigger": "onStart"
    }));
    for pair in state_ids.windows(2) {
        transitions.push(json!({
            "id": format!("{}-next", pair[0]),
            "from": pair[0],
            "to": pair[1],
            "exitTime": 1
        }));
    }
    machines.insert(
        machine_id.clone(),
        json!({
            "id": machine_id,
            "entry": entry_state_id,
            "states": states,
            "transitions": transitions
        }),
    );
    doc.insert("defaultStateMachine".into(), Value::String(machine_id));
    Ok(())
}

fn reserve_state_id(timeline_id: &str) -> String {
    let id = timeline_id
        .trim()
        .to_ascii_lowercase()
        .replace(
            |ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_',
            "-",
        )
        .trim_matches('-')
        .to_string();
    match id.as_str() {
        "" | "entry" | "any" | "exit" => "idle".into(),
        _ => id,
    }
}

fn reserve_unique_id(base: &str, existing: &std::collections::HashSet<String>) -> String {
    if !existing.contains(base) {
        return base.to_string();
    }
    let mut index = 2;
    loop {
        let candidate = format!("{base}-{index}");
        if !existing.contains(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

pub(crate) fn visual_to_renderable_v1(visual: &Value) -> Result<Value, String> {
    match visual.get("version").and_then(|v| v.as_str()) {
        Some("1.0") => Ok(visual.clone()),
        Some("2.0") => migrate_v2_visual_to_v1(visual),
        _ => {
            let normalized = normalize_visual_to_v2(visual)?;
            migrate_v2_visual_to_v1(&normalized)
        }
    }
}

fn migrate_v1_visual_to_v2(visual: &Value) -> Result<Value, String> {
    let root = visual
        .get("root")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "root: missing or invalid object".to_string())?;
    if root.get("type").and_then(|v| v.as_str()) == Some("presentation") {
        return Err("v1 presentation migration to v2 is not supported for row visuals".into());
    }
    let children = root
        .get("children")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "root.children: missing array".to_string())?;

    let mut used_ids = std::collections::HashSet::new();
    let mut elements = serde_json::Map::new();
    let child_ids = children
        .iter()
        .enumerate()
        .map(|(index, child)| {
            migrate_v1_element_to_v2(
                child,
                &format!(
                    "root.{}[{index}]",
                    child
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("element")
                ),
                None,
                &mut used_ids,
                &mut elements,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut scene = serde_json::Map::new();
    for key in [
        "type",
        "preset",
        "width",
        "height",
        "fps",
        "background",
        "controls",
        "loop",
        "autoPlay",
    ] {
        if let Some(value) = root.get(key) {
            scene.insert(key.into(), value.clone());
        }
    }
    scene.insert(
        "children".into(),
        Value::Array(child_ids.into_iter().map(Value::String).collect()),
    );

    let mut doc = serde_json::Map::new();
    doc.insert("version".into(), Value::String("2.0".into()));
    doc.insert("scene".into(), Value::Object(scene));
    doc.insert("elements".into(), Value::Object(elements));
    doc.insert(
        "metadata".into(),
        json!({
            "polishLevel": "draft",
            "notes": ["Migrated from Elucim v1 by CutReady."]
        }),
    );
    let doc = Value::Object(doc);
    validate_v2_doc(&doc)?;
    Ok(doc)
}

fn migrate_v1_element_to_v2(
    element: &Value,
    fallback_id: &str,
    parent_id: Option<&str>,
    used_ids: &mut std::collections::HashSet<String>,
    elements: &mut serde_json::Map<String, Value>,
) -> Result<String, String> {
    let obj = element
        .as_object()
        .ok_or_else(|| format!("{fallback_id}: element must be an object"))?;
    let element_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("group")
        .to_string();
    let base_id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|id| !id.trim().is_empty())
        .unwrap_or(fallback_id);
    let id = reserve_v2_id(base_id, used_ids);

    let child_ids = obj
        .get("children")
        .and_then(|v| v.as_array())
        .map(|children| {
            children
                .iter()
                .enumerate()
                .map(|(index, child)| {
                    migrate_v1_element_to_v2(
                        child,
                        &format!(
                            "{id}.{}[{index}]",
                            child
                                .get("type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("element")
                        ),
                        Some(&id),
                        used_ids,
                        elements,
                    )
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;

    let mut props = serde_json::Map::new();
    let mut layout = serde_json::Map::new();
    for (key, value) in obj {
        if key == "id" || key == "children" {
            continue;
        }
        props.insert(key.clone(), value.clone());
        if V2_LAYOUT_KEYS.contains(&key.as_str()) {
            layout.insert(key.clone(), value.clone());
        }
    }

    let mut v2 = serde_json::Map::new();
    v2.insert("id".into(), Value::String(id.clone()));
    v2.insert("type".into(), Value::String(element_type));
    if let Some(parent_id) = parent_id {
        v2.insert("parentId".into(), Value::String(parent_id.to_string()));
    }
    if let Some(child_ids) = child_ids {
        v2.insert(
            "children".into(),
            Value::Array(child_ids.into_iter().map(Value::String).collect()),
        );
    }
    if !layout.is_empty() {
        v2.insert("layout".into(), Value::Object(layout));
    }
    v2.insert("props".into(), Value::Object(props));
    elements.insert(id.clone(), Value::Object(v2));
    Ok(id)
}

fn reserve_v2_id(base_id: &str, used_ids: &mut std::collections::HashSet<String>) -> String {
    let mut id = base_id.trim().replace([' ', '/', '\\'], "-");
    if id.is_empty() {
        id = "element".into();
    }
    let original = id.clone();
    let mut suffix = 2;
    while used_ids.contains(&id) {
        id = format!("{original}-{suffix}");
        suffix += 1;
    }
    used_ids.insert(id.clone());
    id
}

fn migrate_legacy_rootless_to_v2(visual: &Value) -> Result<Value, String> {
    let elements = visual
        .get("elements")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "legacy rootless visual: expected elements array".to_string())?;
    let mut children = Vec::new();
    if let Some(title) = visual.get("title").and_then(|v| v.as_str()) {
        children.push(json!({
            "type": "text",
            "id": "title",
            "content": title,
            "x": 96,
            "y": 96,
            "fontSize": 48,
            "fill": "$title"
        }));
    }
    children.extend(elements.iter().cloned());
    let v1 = json!({
        "version": "1.0",
        "root": {
            "type": "player",
            "width": visual.get("width").and_then(|v| v.as_u64()).unwrap_or(1920),
            "height": visual.get("height").and_then(|v| v.as_u64()).unwrap_or(1080),
            "fps": visual.get("fps").and_then(|v| v.as_u64()).unwrap_or(30),
            "durationInFrames": visual.get("durationInFrames").and_then(|v| v.as_u64()).or_else(|| visual.get("duration").and_then(|v| v.as_u64())).unwrap_or(120),
            "background": visual.get("background").cloned().unwrap_or_else(|| Value::String("$background".into())),
            "children": children
        }
    });
    migrate_v1_visual_to_v2(&v1)
}

fn migrate_v2_visual_to_v1(visual: &Value) -> Result<Value, String> {
    validate_v2_doc(visual)?;
    let scene = visual
        .get("scene")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "scene: missing or invalid object".to_string())?;
    let children = scene
        .get("children")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "scene.children: missing array".to_string())?;
    let restored_children = children
        .iter()
        .map(|id| {
            id.as_str()
                .ok_or_else(|| "scene.children: child IDs must be strings".to_string())
                .and_then(|id| restore_v2_element_to_v1(visual, id))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut root = serde_json::Map::new();
    for key in [
        "type",
        "preset",
        "width",
        "height",
        "fps",
        "background",
        "controls",
        "loop",
        "autoPlay",
    ] {
        if let Some(value) = scene.get(key) {
            root.insert(key.into(), value.clone());
        }
    }
    root.insert(
        "durationInFrames".into(),
        Value::Number(v2_visual_duration_in_frames(visual).into()),
    );
    root.insert("children".into(), Value::Array(restored_children));
    Ok(json!({ "version": "1.0", "root": Value::Object(root) }))
}

fn v2_visual_duration_in_frames(visual: &Value) -> i64 {
    let timeline_max = visual
        .get("timelines")
        .and_then(|v| v.as_object())
        .and_then(|timelines| {
            timelines
                .values()
                .filter_map(|timeline| timeline.get("duration").and_then(|v| v.as_i64()))
                .filter(|duration| *duration > 0)
                .max()
        });
    timeline_max
        .or_else(|| {
            visual
                .pointer("/scene/durationInFrames")
                .and_then(|v| v.as_i64())
                .filter(|duration| *duration > 0)
        })
        .unwrap_or(120)
}

fn restore_v2_element_to_v1(visual: &Value, id: &str) -> Result<Value, String> {
    let elements = visual
        .get("elements")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "elements: missing or invalid object".to_string())?;
    let element = elements
        .get(id)
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("elements.{id}: missing element"))?;
    let mut restored = element
        .get("layout")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let props = element
        .get("props")
        .and_then(|v| v.as_object())
        .cloned()
        .ok_or_else(|| format!("elements.{id}.props: missing object"))?;
    for (key, value) in props {
        restored.insert(key, value);
    }
    restored.insert("id".into(), Value::String(id.to_string()));
    restored.insert(
        "type".into(),
        Value::String(
            element
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("group")
                .to_string(),
        ),
    );
    if let Some(children) = element.get("children").and_then(|v| v.as_array()) {
        let restored_children = children
            .iter()
            .map(|child| {
                child
                    .as_str()
                    .ok_or_else(|| format!("elements.{id}.children: child IDs must be strings"))
                    .and_then(|child_id| restore_v2_element_to_v1(visual, child_id))
            })
            .collect::<Result<Vec<_>, _>>()?;
        restored.insert("children".into(), Value::Array(restored_children));
    }
    Ok(Value::Object(restored))
}

fn validate_v2_doc(visual: &Value) -> Result<(), String> {
    let obj = visual
        .as_object()
        .ok_or_else(|| "document: must be an object".to_string())?;
    if obj.get("version").and_then(|v| v.as_str()) != Some("2.0") {
        return Err("version: expected \"2.0\"".into());
    }
    let scene = obj
        .get("scene")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "scene: missing or invalid object".to_string())?;
    match scene.get("type").and_then(|v| v.as_str()) {
        Some("scene" | "player") => {}
        Some(t) => {
            return Err(format!(
                "scene.type: expected \"scene\" or \"player\", got \"{t}\""
            ))
        }
        None => return Err("scene.type: missing".into()),
    }
    let scene_children = scene
        .get("children")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "scene.children: must be an array of element IDs".to_string())?;
    let elements = obj
        .get("elements")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "elements: missing or invalid object".to_string())?;

    for (index, child) in scene_children.iter().enumerate() {
        let id = child
            .as_str()
            .ok_or_else(|| format!("scene.children[{index}]: must be an element ID string"))?;
        if !elements.contains_key(id) {
            return Err(format!(
                "scene.children[{index}]: unknown element ID \"{id}\""
            ));
        }
    }
    for (id, element) in elements {
        let element = element
            .as_object()
            .ok_or_else(|| format!("elements.{id}: must be an object"))?;
        if element.get("id").and_then(|v| v.as_str()) != Some(id.as_str()) {
            return Err(format!("elements.{id}.id: must match map key \"{id}\""));
        }
        if element.get("type").and_then(|v| v.as_str()).is_none() {
            return Err(format!("elements.{id}.type: missing"));
        }
        if !element.get("props").is_some_and(|v| v.is_object()) {
            return Err(format!("elements.{id}.props: must be an object"));
        }
        if let Some(parent_id) = element.get("parentId").and_then(|v| v.as_str()) {
            if !elements.contains_key(parent_id) {
                return Err(format!(
                    "elements.{id}.parentId: unknown parent ID \"{parent_id}\""
                ));
            }
        }
        if let Some(children) = element.get("children").and_then(|v| v.as_array()) {
            for (index, child) in children.iter().enumerate() {
                let child_id = child.as_str().ok_or_else(|| {
                    format!("elements.{id}.children[{index}]: must be an element ID string")
                })?;
                if !elements.contains_key(child_id) {
                    return Err(format!(
                        "elements.{id}.children[{index}]: unknown element ID \"{child_id}\""
                    ));
                }
                if elements
                    .get(child_id)
                    .and_then(|v| v.get("parentId"))
                    .and_then(|v| v.as_str())
                    != Some(id.as_str())
                {
                    return Err(format!("elements.{id}.children[{index}]: child \"{child_id}\" must have parentId \"{id}\""));
                }
            }
        }
    }
    validate_v2_timelines(obj, elements)?;
    validate_v2_state_machines(obj)?;
    Ok(())
}

fn validate_v2_timelines(
    doc: &serde_json::Map<String, Value>,
    elements: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let Some(timelines) = doc.get("timelines") else {
        return Ok(());
    };
    let timelines = timelines
        .as_object()
        .ok_or_else(|| "timelines: must be an object".to_string())?;
    const VALID_PROPERTIES: &[&str] =
        &["opacity", "translate", "scale", "rotate", "fill", "stroke"];
    for (timeline_id, timeline) in timelines {
        let timeline = timeline
            .as_object()
            .ok_or_else(|| format!("timelines.{timeline_id}: must be an object"))?;
        if timeline.get("id").and_then(|v| v.as_str()) != Some(timeline_id.as_str()) {
            return Err(format!(
                "timelines.{timeline_id}.id: must match key \"{timeline_id}\""
            ));
        }
        let duration = timeline
            .get("duration")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("timelines.{timeline_id}.duration: must be positive"))?;
        if duration <= 0.0 || !duration.is_finite() {
            return Err(format!(
                "timelines.{timeline_id}.duration: must be positive"
            ));
        }
        let Some(tracks) = timeline.get("tracks") else {
            continue;
        };
        let tracks = tracks
            .as_array()
            .ok_or_else(|| format!("timelines.{timeline_id}.tracks: must be an array"))?;
        for (track_index, track) in tracks.iter().enumerate() {
            let track = track.as_object().ok_or_else(|| {
                format!("timelines.{timeline_id}.tracks[{track_index}]: must be an object")
            })?;
            let target = track
                .get("target")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    format!("timelines.{timeline_id}.tracks[{track_index}].target: missing")
                })?;
            if !elements.contains_key(target) {
                return Err(format!(
                    "timelines.{timeline_id}.tracks[{track_index}].target: unknown target \"{target}\""
                ));
            }
            let property = track
                .get("property")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    format!("timelines.{timeline_id}.tracks[{track_index}].property: missing")
                })?;
            if !VALID_PROPERTIES.contains(&property) {
                return Err(format!(
                    "timelines.{timeline_id}.tracks[{track_index}].property: unsupported animatable property \"{property}\""
                ));
            }
            let keyframes = track
                .get("keyframes")
                .and_then(|v| v.as_array())
                .ok_or_else(|| {
                    format!("timelines.{timeline_id}.tracks[{track_index}].keyframes: must be a non-empty array")
                })?;
            if keyframes.is_empty() {
                return Err(format!(
                    "timelines.{timeline_id}.tracks[{track_index}].keyframes: must be a non-empty array"
                ));
            }
            let mut previous_frame = -1_i64;
            for (keyframe_index, keyframe) in keyframes.iter().enumerate() {
                let keyframe = keyframe.as_object().ok_or_else(|| {
                    format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}]: must be an object")
                })?;
                let frame = keyframe
                    .get("frame")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| {
                        format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].frame: must be a non-negative integer")
                    })?;
                if frame < 0 {
                    return Err(format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].frame: must be a non-negative integer"));
                }
                if frame as f64 > duration {
                    return Err(format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].frame: cannot exceed timeline duration"));
                }
                if frame <= previous_frame {
                    return Err(format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].frame: frames must be strictly increasing"));
                }
                previous_frame = frame;
                if !keyframe.contains_key("value") {
                    return Err(format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].value: required"));
                }
            }
        }
    }
    Ok(())
}

fn validate_v2_state_machines(doc: &serde_json::Map<String, Value>) -> Result<(), String> {
    let timeline_ids = doc
        .get("timelines")
        .and_then(|v| v.as_object())
        .map(|timelines| {
            timelines
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();
    let Some(state_machines) = doc.get("stateMachines") else {
        return Ok(());
    };
    let state_machines = state_machines
        .as_object()
        .ok_or_else(|| "stateMachines: must be an object".to_string())?;
    for (machine_id, machine) in state_machines {
        let machine = machine
            .as_object()
            .ok_or_else(|| format!("stateMachines.{machine_id}: must be an object"))?;
        if machine.get("id").and_then(|v| v.as_str()) != Some(machine_id.as_str()) {
            return Err(format!(
                "stateMachines.{machine_id}.id: must match key \"{machine_id}\""
            ));
        }
        let entry = machine
            .get("entry")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("stateMachines.{machine_id}.entry: missing"))?;
        let states = machine
            .get("states")
            .and_then(|v| v.as_object())
            .ok_or_else(|| format!("stateMachines.{machine_id}.states: must be an object"))?;
        if !states.contains_key(entry) {
            return Err(format!(
                "stateMachines.{machine_id}.entry: entry state \"{entry}\" does not exist"
            ));
        }
        let transitions = machine
            .get("transitions")
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("stateMachines.{machine_id}.transitions: must be an array"))?;
        for (state_id, state) in states {
            let state = state.as_object().ok_or_else(|| {
                format!("stateMachines.{machine_id}.states.{state_id}: must be an object")
            })?;
            if let Some(timeline) = state.get("timeline").and_then(|v| v.as_str()) {
                if !timeline_ids.contains(timeline) {
                    return Err(format!(
                        "stateMachines.{machine_id}.states.{state_id}.timeline: unknown timeline \"{timeline}\""
                    ));
                }
            }
        }
        let entry_transitions = transitions
            .iter()
            .filter(|transition| transition.get("from").and_then(|v| v.as_str()) == Some("entry"))
            .collect::<Vec<_>>();
        if entry_transitions.len() != 1 {
            return Err(format!(
                "stateMachines.{machine_id}.transitions: Entry must have exactly one outgoing transition"
            ));
        }
        if entry_transitions[0].get("to").and_then(|v| v.as_str()) != Some(entry) {
            return Err(format!(
                "stateMachines.{machine_id}.entry: Machine entry must match the explicit Entry transition target"
            ));
        }

        let mut next_sources = std::collections::HashSet::new();
        let mut event_sources = std::collections::HashSet::new();
        for (index, transition) in transitions.iter().enumerate() {
            validate_v2_transition(machine_id, index, transition, states)?;
            let path = format!("stateMachines.{machine_id}.transitions[{index}]");
            let transition = transition
                .as_object()
                .ok_or_else(|| format!("{path}: must be an object"))?;
            let from = transition
                .get("from")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let to = transition.get("to").and_then(|v| v.as_str()).unwrap_or("");
            let trigger = transition.get("trigger").and_then(|v| v.as_str());
            let exit_time = transition.get("exitTime");

            if from == "entry" {
                if to == "entry" || to == "exit" {
                    return Err(format!(
                        "{path}.to: Entry transition must target a real state"
                    ));
                }
                if exit_time.is_some() {
                    return Err(format!(
                        "{path}.exitTime: Entry transitions cannot be Next transitions"
                    ));
                }
                match trigger {
                    Some("onStart" | "onClick" | "onKey") => {}
                    Some(value) => {
                        return Err(format!("{path}.trigger: unsupported entry trigger \"{value}\""))
                    }
                    None => {
                        return Err(format!(
                            "{path}.trigger: Entry transitions require a start event such as onStart or onClick"
                        ))
                    }
                }
                if trigger == Some("onKey")
                    && transition
                        .get("key")
                        .and_then(|v| v.as_str())
                        .is_none_or(|key| key.trim().is_empty())
                {
                    return Err(format!("{path}.key: onKey transitions require a key"));
                }
                continue;
            }

            if exit_time.is_some() {
                if trigger.is_some() {
                    return Err(format!(
                        "{path}.trigger: Next transitions must not have event names"
                    ));
                }
                if !next_sources.insert(from.to_string()) {
                    return Err(format!(
                        "{path}.from: State \"{from}\" can only have one Next transition"
                    ));
                }
                continue;
            }

            let trigger = trigger.ok_or_else(|| {
                format!("{path}.trigger: Event transitions require an event name")
            })?;
            let scoped_event_key = if trigger == "onKey" {
                let key = transition
                    .get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("{path}.key: onKey transitions require a key"))?;
                format!("{from}:{trigger}:{}", key.to_ascii_lowercase())
            } else {
                format!("{from}:{trigger}")
            };
            if !event_sources.insert(scoped_event_key) {
                return Err(format!(
                    "{path}.trigger: Duplicate event \"{trigger}\" from \"{from}\""
                ));
            }
        }
    }
    Ok(())
}

fn validate_v2_transition(
    machine_id: &str,
    transition_index: usize,
    transition: &Value,
    states: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let path = format!("stateMachines.{machine_id}.transitions[{transition_index}]");
    let transition = transition
        .as_object()
        .ok_or_else(|| format!("{path}: must be an object"))?;
    if transition
        .get("id")
        .and_then(|v| v.as_str())
        .is_none_or(|id| id.trim().is_empty())
    {
        return Err(format!("{path}.id: Transition id is required"));
    }
    let source = transition
        .get("from")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{path}.from: missing"))?;
    if source != "entry" && source != "any" && !states.contains_key(source) {
        return Err(format!("{path}.from: unknown source state \"{source}\""));
    }
    let target = transition
        .get("to")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{path}.to: missing"))?;
    if target != "entry" && target != "exit" && !states.contains_key(target) {
        return Err(format!("{path}.to: unknown target state \"{target}\""));
    }
    if let Some(exit_time) = transition.get("exitTime") {
        if !exit_time
            .as_f64()
            .is_some_and(|value| value.is_finite() && value >= 0.0)
        {
            return Err(format!(
                "{path}.exitTime: Exit time must be a non-negative number"
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_agentic_visual(visual: &Value) -> Result<(), String> {
    let mut errors = Vec::new();
    validate_dsl_doc(visual, &mut errors);
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    visual_to_renderable_v1(visual).map(|_| ())
}

fn validate_dsl_node(node: &Value, path: &str, errors: &mut Vec<String>) {
    let obj = match node.as_object() {
        Some(o) => o,
        None => {
            errors.push(format!(
                "{path}: expected object, got {}",
                node_type_name(node)
            ));
            return;
        }
    };

    if let Some(t) = obj.get("type").and_then(|v| v.as_str()) {
        if !VALID_ROOT_TYPES.contains(&t) && !VALID_NODE_TYPES.contains(&t) {
            errors.push(format!(
                "{path}.type: unknown node type \"{t}\". Valid types: {}",
                VALID_NODE_TYPES.join(", ")
            ));
        }
        // scene/player require width, height
        if (t == "scene" || t == "player")
            && path == "root"
            && (!obj.contains_key("width") || !obj.contains_key("height"))
        {
            errors.push(format!("{path}: {t} requires width and height"));
        }
        // player requires fps and durationInFrames
        if t == "player" && path == "root" {
            if !obj.contains_key("fps") {
                errors.push(format!("{path}: player requires fps"));
            }
            if !obj.contains_key("durationInFrames") {
                errors.push(format!("{path}: player requires durationInFrames"));
            }
        }
        // text nodes require the "content" property (NOT "text")
        if t == "text" && !obj.contains_key("content") {
            if obj.contains_key("text") {
                errors.push(format!(
                    "{path}: text node uses \"content\" not \"text\" for the string value"
                ));
            } else {
                errors.push(format!("{path}: text node requires a \"content\" string"));
            }
        }
        // polygon requires points array with ≥ 3 entries, each [number, number]
        if t == "polygon" {
            match obj.get("points").and_then(|v| v.as_array()) {
                Some(pts) => {
                    if pts.len() < 3 {
                        errors.push(format!(
                            "{path}.points: polygon requires at least 3 points (got {})",
                            pts.len()
                        ));
                    }
                    for (i, pt) in pts.iter().enumerate() {
                        if let Some(arr) = pt.as_array() {
                            if arr.len() != 2 || !arr[0].is_number() || !arr[1].is_number() {
                                errors.push(format!(
                                    "{path}.points[{i}]: each point must be [number, number]"
                                ));
                            }
                        } else {
                            errors.push(format!(
                                "{path}.points[{i}]: each point must be [number, number], got {}",
                                node_type_name(pt)
                            ));
                        }
                    }
                }
                None => {
                    if obj.contains_key("points") {
                        errors.push(format!(
                            "{path}.points: must be an array of [number, number] pairs"
                        ));
                    } else {
                        errors.push(format!("{path}: polygon requires a \"points\" array"));
                    }
                }
            }
        }
        // line requires x1, y1, x2, y2 as numbers
        if t == "line" || t == "arrow" {
            for coord in &["x1", "y1", "x2", "y2"] {
                match obj.get(*coord) {
                    Some(v) if v.is_number() => {}
                    Some(_) => errors.push(format!("{path}.{coord}: must be a number")),
                    None => errors.push(format!("{path}: {t} requires \"{coord}\"")),
                }
            }
        }
        // bezierCurve requires points array, each [number, number]
        if t == "bezierCurve" {
            if let Some(pts) = obj.get("points").and_then(|v| v.as_array()) {
                for (i, pt) in pts.iter().enumerate() {
                    if let Some(arr) = pt.as_array() {
                        if arr.len() != 2 || !arr[0].is_number() || !arr[1].is_number() {
                            errors.push(format!(
                                "{path}.points[{i}]: each point must be [number, number]"
                            ));
                        }
                    } else {
                        errors.push(format!(
                            "{path}.points[{i}]: each point must be [number, number], got {}",
                            node_type_name(pt)
                        ));
                    }
                }
            }
        }
        // fadeIn/fadeOut/draw must be positive (≥ 1), not zero
        for anim_prop in &["fadeIn", "fadeOut", "draw"] {
            if let Some(v) = obj.get(*anim_prop) {
                if let Some(n) = v.as_f64() {
                    if n < 1.0 {
                        errors.push(format!("{path}.{anim_prop}: must be ≥ 1 (got {n}). Omit the property for instant visibility at frame 0."));
                    }
                } else if !v.is_number() {
                    errors.push(format!("{path}.{anim_prop}: must be a positive number"));
                }
            }
        }
    } else if path != "root" {
        // Non-root nodes must have a type
        errors.push(format!("{path}: missing \"type\" property"));
    }

    // Recursively validate children
    if let Some(children) = obj.get("children").and_then(|v| v.as_array()) {
        for (i, child) in children.iter().enumerate() {
            validate_dsl_node(child, &format!("{path}.children[{i}]"), errors);
        }
    }
}

fn node_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Validate a DSL document object, collecting errors into the provided Vec.
pub(crate) fn validate_dsl_doc(visual: &Value, errors: &mut Vec<String>) {
    if visual.get("version").and_then(|v| v.as_str()) == Some("2.0") {
        if let Err(e) = validate_v2_doc(visual) {
            errors.push(e);
            return;
        }
        match visual_to_renderable_v1(visual) {
            Ok(renderable) => validate_dsl_doc(&renderable, errors),
            Err(e) => errors.push(e),
        }
        return;
    }

    // Check version
    match visual.get("version") {
        Some(v) if v.as_str() == Some("1.0") => {}
        Some(v) => errors.push(format!("version: expected \"1.0\", got {v}")),
        None => errors.push("missing required field \"version\" (must be \"1.0\")".into()),
    }

    // Check root
    match visual.get("root") {
        Some(root) if root.is_object() => {
            // Check root type
            match root.get("type").and_then(|v| v.as_str()) {
                Some(t) if VALID_ROOT_TYPES.contains(&t) => {}
                Some(t) => errors.push(format!(
                    "root.type: \"{t}\" is not a valid root type. Must be one of: {}",
                    VALID_ROOT_TYPES.join(", ")
                )),
                None => errors.push("root: missing \"type\" property".into()),
            }
            // Validate children recursively
            if let Some(children) = root.get("children").and_then(|v| v.as_array()) {
                for (i, child) in children.iter().enumerate() {
                    validate_dsl_node(child, &format!("root.children[{i}]"), &mut *errors);
                }
            }
            // Validate root-level requirements
            validate_dsl_node(root, "root", &mut *errors);
        }
        Some(_) => errors.push("root: must be an object".into()),
        None => errors.push("missing required field \"root\"".into()),
    }
}
