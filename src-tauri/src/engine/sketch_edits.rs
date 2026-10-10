//! Structured `.sk` edits and their lock policy.
//!
//! This is the desktop binding for the `SketchDocument` contract in
//! `contracts/edits.tsp`. The UI command, the agent tools, and the
//! contract vectors all go through these functions so every edit path
//! applies the same rules as the iOS companion.

use chrono::{DateTime, Utc};

use crate::models::sketch::{PlanningRow, Sketch};

/// Why an edit was rejected. Row indices are zero-based; `Display` reports
/// them one-based for people.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SketchEditError {
    #[error("This sketch is locked. Unlock it before editing.")]
    LockedDocument,
    #[error("Cannot add, remove, or reorder planning rows while a row or cell is locked.")]
    LockedRowCount,
    #[error("Planning row {} is locked. Unlock it before editing.", .row_index + 1)]
    LockedRow { row_index: usize },
    #[error(
        "Planning row {} {} cell is locked. Unlock it before editing.",
        .row_index + 1,
        .field.replace('_', " ")
    )]
    LockedCell {
        row_index: usize,
        field: &'static str,
    },
    #[error("Planning row {} does not exist.", .row_index + 1)]
    RowNotFound { row_index: usize },
    #[error("Row order must list every planning row exactly once.")]
    InvalidReorder,
}

impl SketchEditError {
    /// Stable code shared with the iOS companion (`SketchEditErrorCode`).
    pub fn code(&self) -> &'static str {
        match self {
            Self::LockedDocument => "locked_document",
            Self::LockedRowCount => "locked_row_count",
            Self::LockedRow { .. } => "locked_row",
            Self::LockedCell { .. } => "locked_cell",
            Self::RowNotFound { .. } => "row_not_found",
            Self::InvalidReorder => "invalid_reorder",
        }
    }
}

/// Text cells to replace on one row. `None` leaves a cell untouched.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RowTextUpdate {
    pub row_index: usize,
    pub time: Option<String>,
    pub narrative: Option<String>,
    pub demo_actions: Option<String>,
}

/// Lockable cells in column order; errors report the first locked cell that changed.
const LOCKABLE_FIELDS: [&str; 6] = [
    "time",
    "narrative",
    "demo_actions",
    "screenshot",
    "visual",
    "design_plan",
];

pub fn ensure_unlocked(sketch: &Sketch) -> Result<(), SketchEditError> {
    if sketch.locked {
        return Err(SketchEditError::LockedDocument);
    }
    Ok(())
}

/// Checks a proposed replacement row list against the locks on the current
/// rows, position by position. Unchanged values on locked content are allowed.
pub fn check_rows_update(
    existing: &[PlanningRow],
    updated: &[PlanningRow],
) -> Result<(), SketchEditError> {
    let has_locks = existing.iter().any(|row| row.locked || row.locks.any());
    if has_locks && existing.len() != updated.len() {
        return Err(SketchEditError::LockedRowCount);
    }

    for (row_index, (old, new)) in existing.iter().zip(updated.iter()).enumerate() {
        if old.locked && !row_content_matches(old, new) {
            return Err(SketchEditError::LockedRow { row_index });
        }
        for field in LOCKABLE_FIELDS {
            if old.locks.is_locked(field) && !field_matches(old, new, field) {
                return Err(SketchEditError::LockedCell { row_index, field });
            }
        }
    }

    Ok(())
}

/// Lock state belongs to the position, not to the row content that moves through it.
pub fn apply_locked_row_metadata(existing: &[PlanningRow], updated: &mut [PlanningRow]) {
    for (old, new) in existing.iter().zip(updated.iter_mut()) {
        new.locked = old.locked;
        new.locks = old.locks.clone();
    }
}

/// Replace the whole planning table, enforcing locks.
pub fn replace_rows(
    sketch: &mut Sketch,
    mut rows: Vec<PlanningRow>,
    now: DateTime<Utc>,
) -> Result<(), SketchEditError> {
    ensure_unlocked(sketch)?;
    check_rows_update(&sketch.rows, &rows)?;
    apply_locked_row_metadata(&sketch.rows, &mut rows);
    sketch.rows = rows;
    sketch.updated_at = now;
    Ok(())
}

/// `SketchDocument.updateRowText`.
pub fn update_row_text(
    sketch: &mut Sketch,
    update: &RowTextUpdate,
    now: DateTime<Utc>,
) -> Result<(), SketchEditError> {
    ensure_unlocked(sketch)?;
    let mut rows = sketch.rows.clone();
    let row = rows
        .get_mut(update.row_index)
        .ok_or(SketchEditError::RowNotFound {
            row_index: update.row_index,
        })?;
    if let Some(time) = &update.time {
        row.time = time.clone();
    }
    if let Some(narrative) = &update.narrative {
        row.narrative = narrative.clone();
    }
    if let Some(demo_actions) = &update.demo_actions {
        row.demo_actions = demo_actions.clone();
    }
    replace_rows(sketch, rows, now)
}

/// `SketchDocument.reorderRows`. `order[i]` is the current index of the row
/// that moves to position `i`.
pub fn reorder_rows(
    sketch: &mut Sketch,
    order: &[usize],
    now: DateTime<Utc>,
) -> Result<(), SketchEditError> {
    ensure_unlocked(sketch)?;
    let mut seen = vec![false; sketch.rows.len()];
    if order.len() != sketch.rows.len() {
        return Err(SketchEditError::InvalidReorder);
    }
    for &index in order {
        match seen.get_mut(index) {
            Some(slot) if !*slot => *slot = true,
            _ => return Err(SketchEditError::InvalidReorder),
        }
    }
    let rows = order
        .iter()
        .map(|&index| sketch.rows[index].clone())
        .collect();
    replace_rows(sketch, rows, now)
}

/// A locked row protects everything except its lock state, including
/// desktop-only and unknown fields.
fn row_content_matches(old: &PlanningRow, new: &PlanningRow) -> bool {
    row_content(old) == row_content(new)
}

fn row_content(row: &PlanningRow) -> serde_json::Value {
    let mut value = serde_json::to_value(row).unwrap_or_default();
    if let Some(fields) = value.as_object_mut() {
        fields.remove("locked");
        fields.remove("locks");
    }
    value
}

fn field_matches(old: &PlanningRow, new: &PlanningRow, field: &str) -> bool {
    match field {
        "time" => old.time == new.time,
        "narrative" => old.narrative == new.narrative,
        "demo_actions" => old.demo_actions == new.demo_actions,
        "screenshot" | "visual" => old.screenshot == new.screenshot && old.visual == new.visual,
        "design_plan" => old.design_plan == new.design_plan,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sketch_with(rows: Vec<PlanningRow>) -> Sketch {
        let mut sketch = Sketch::new("Edits");
        sketch.rows = rows;
        sketch
    }

    fn row(narrative: &str) -> PlanningRow {
        let mut row = PlanningRow::new();
        row.narrative = narrative.into();
        row
    }

    #[test]
    fn messages_match_the_legacy_project_errors() {
        assert_eq!(
            SketchEditError::LockedCell {
                row_index: 0,
                field: "demo_actions"
            }
            .to_string(),
            "Planning row 1 demo actions cell is locked. Unlock it before editing."
        );
        assert_eq!(
            SketchEditError::LockedRow { row_index: 2 }.to_string(),
            "Planning row 3 is locked. Unlock it before editing."
        );
    }

    #[test]
    fn rejected_edit_leaves_the_sketch_untouched() {
        let mut locked = row("Keep");
        locked.locks.narrative = true;
        let mut sketch = sketch_with(vec![locked]);
        let before = sketch.updated_at;

        let err = update_row_text(
            &mut sketch,
            &RowTextUpdate {
                row_index: 0,
                narrative: Some("Changed".into()),
                ..Default::default()
            },
            Utc::now(),
        )
        .unwrap_err();

        assert_eq!(err.code(), "locked_cell");
        assert_eq!(sketch.rows[0].narrative, "Keep");
        assert_eq!(sketch.updated_at, before);
    }

    #[test]
    fn replace_rows_rejects_count_changes_when_locked() {
        let mut locked = row("Keep");
        locked.locked = true;
        let mut sketch = sketch_with(vec![locked.clone()]);

        let err = replace_rows(&mut sketch, vec![locked, row("New")], Utc::now()).unwrap_err();

        assert_eq!(err, SketchEditError::LockedRowCount);
    }
}
