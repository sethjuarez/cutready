//! The write transaction every host uses for project documents: lock,
//! reconcile, edit, log pending, write, commit. Documents are the truth; the
//! op log records which run wrote what so review can diff, keep or undo it.

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::contracts::{
    CmdError, CmdErrorCode, CmdErrorDetails, DocumentKind, DocumentReview, RunReview, UndoConflict,
    UndoWrite,
};
use crate::document::DocumentError;
use crate::edit_ops::{self, ContentEditError, NoteLock};
use crate::notes::{self, LOCKS_PATH};
use crate::path::project_relative;
use crate::ports::{
    Baseline, Clock, Files, Images, Lock, NewOpLogEntry, OpLogEntry, OpLogState, OpLogStore,
    PortError, PortErrorKind, Resolution, ReviewEffect,
};
use crate::review::{self, UndoError};

/// The app's own edits: kept as they commit, never up for review.
pub const USER_ACTOR: &str = "user";
/// Runs that write review undos.
pub const REVIEW_ACTOR: &str = "review";

/// What the caller believes is on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expected {
    /// The file's bytes must have this version (`sha256:…`).
    Version(String),
    /// The file must not exist yet.
    Absent,
    /// Whatever is on disk now. For callers that don't track versions; not
    /// optimistic concurrency.
    Unchecked,
}

/// Whether a note edit follows the lock manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteLockPolicy {
    /// Locked notes reject edits; `set_lock` ops update the manifest.
    Enforce,
    /// Import and create paths: the note is treated as unlocked and the
    /// manifest is left alone.
    Ignore,
}

/// A write's outcome. `seq` is the document's op-log entry, `None` when its
/// bytes didn't change (nothing is logged or written for it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub content: String,
    pub version: String,
    pub changed: bool,
    pub note_lock: Option<NoteLock>,
    pub seq: Option<u64>,
}

/// Pending entries settled by [`EditSession::reconcile`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reconciled {
    pub committed: Vec<u64>,
    pub abandoned: Vec<u64>,
}

/// An app save's outcome: what was written, and whether it was merged onto
/// changes someone else made since the save's base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rebased {
    pub applied: Applied,
    pub merged: bool,
    /// When merged, the save's own document (`base` with its ops applied):
    /// what the caller's editor holds, and so its base for the next save.
    pub local: Option<String>,
}

/// Why [`EditSession::apply_rebased`] wrote nothing.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RebaseError {
    /// The file changed since the base in a way the save can't merge onto:
    /// overlapping changes (`conflicts`), a lock, or a base that isn't the
    /// expected version.
    #[error("The document changed since it was opened.")]
    Stale {
        current_version: Option<String>,
        conflicts: Vec<UndoConflict>,
    },
    #[error(transparent)]
    Edit(#[from] ContentEditError),
}

impl From<DocumentError> for RebaseError {
    fn from(err: DocumentError) -> Self {
        Self::Edit(err.into())
    }
}

/// `stale_document` carries the version on disk and any conflicting paths.
impl TryFrom<&RebaseError> for CmdError {
    type Error = String;

    fn try_from(err: &RebaseError) -> Result<Self, String> {
        match err {
            RebaseError::Stale {
                current_version,
                conflicts,
            } => Ok(CmdError {
                code: CmdErrorCode::StaleDocument,
                message: err.to_string(),
                details: Some(CmdErrorDetails {
                    current_version: current_version.clone(),
                    conflicts: (!conflicts.is_empty()).then(|| conflicts.clone()),
                    ..Default::default()
                }),
            }),
            RebaseError::Edit(edit) => CmdError::try_from(edit),
        }
    }
}

/// Hash recorded as `before_hash` when the document didn't exist.
pub const ABSENT_HASH: &str = "";

/// Why Keep or Undo failed. Nothing changed.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ReviewError {
    #[error("The run changed this document again; review its latest changes.")]
    Stale,
    #[error(transparent)]
    Undo(#[from] UndoError),
}

impl From<DocumentError> for ReviewError {
    fn from(err: DocumentError) -> Self {
        Self::Undo(UndoError::Document(err))
    }
}

impl From<PortError> for ReviewError {
    fn from(err: PortError) -> Self {
        DocumentError::from(err).into()
    }
}

/// The contract's CmdError; unreadable documents surface as their message.
impl TryFrom<&ReviewError> for CmdError {
    type Error = String;

    fn try_from(err: &ReviewError) -> Result<Self, String> {
        match err {
            ReviewError::Stale => Ok(CmdError {
                code: CmdErrorCode::StaleReview,
                message: err.to_string(),
                details: None,
            }),
            ReviewError::Undo(undo) => CmdError::try_from(undo),
        }
    }
}

/// The project document kind for a path's extension.
pub fn kind_of(doc: &str) -> Result<DocumentKind, DocumentError> {
    match Path::new(doc).extension().and_then(|ext| ext.to_str()) {
        Some("sk") => Ok(DocumentKind::Sketch),
        Some("sb") => Ok(DocumentKind::Storyboard),
        Some("md") => Ok(DocumentKind::Note),
        _ => Err(PortError::new(
            PortErrorKind::InvalidPath,
            format!("Not a project document: {doc}"),
        )
        .into()),
    }
}

/// One file write inside a transaction.
struct Write {
    doc: String,
    ops: Value,
    before: Option<String>,
    after: String,
    effect: ReviewEffect,
}

/// One project's write path over its ports. Cheap to build per call.
pub struct EditSession<'a> {
    files: &'a dyn Files,
    lock: &'a dyn Lock,
    log: &'a dyn OpLogStore,
    clock: &'a dyn Clock,
}

impl<'a> EditSession<'a> {
    pub fn new(
        files: &'a dyn Files,
        lock: &'a dyn Lock,
        log: &'a dyn OpLogStore,
        clock: &'a dyn Clock,
    ) -> Self {
        Self {
            files,
            lock,
            log,
            clock,
        }
    }

    /// Starts a run for `actor` (`user`, `agent:<name>`, `cli`, `mcp`).
    pub fn begin_run(&self, actor: &str) -> Result<String, PortError> {
        self.log.begin_run(actor, self.clock.now())
    }

    /// Applies `ops` to the project-relative `doc` (`.sk`, `.sb` or `.md`)
    /// as part of `run_id`, following note locks.
    pub fn apply(
        &self,
        run_id: &str,
        doc: &str,
        expected: Expected,
        ops: &[Value],
    ) -> Result<Applied, ContentEditError> {
        self.apply_with(run_id, doc, expected, ops, NoteLockPolicy::Enforce)
    }

    /// [`Self::apply`] with an explicit note-lock policy.
    ///
    /// Holds the project lock for the whole transaction. Hosts whose callers
    /// already hold it must make [`Lock::acquire`] reentrant per thread.
    pub fn apply_with(
        &self,
        run_id: &str,
        doc: &str,
        expected: Expected,
        ops: &[Value],
        policy: NoteLockPolicy,
    ) -> Result<Applied, ContentEditError> {
        let doc = normalize(doc)?;
        let kind = kind_of(&doc)?;
        let _guard = self.lock.acquire().map_err(DocumentError::from)?;
        self.reconcile_locked().map_err(DocumentError::from)?;
        let current = self.read(&doc)?;
        self.apply_locked(run_id, &doc, kind, current, expected, ops, policy)
    }

    /// [`Self::apply_with`] once the lock is held and `doc` read.
    #[allow(clippy::too_many_arguments)]
    fn apply_locked(
        &self,
        run_id: &str,
        doc: &str,
        kind: DocumentKind,
        current: Option<String>,
        expected: Expected,
        ops: &[Value],
        policy: NoteLockPolicy,
    ) -> Result<Applied, ContentEditError> {
        let doc = doc.to_string();
        let run = self.log.run(run_id).map_err(DocumentError::from)?;
        let expected_version = match expected {
            Expected::Version(version) => Some(version),
            Expected::Absent => None,
            Expected::Unchecked => match &current {
                Some(content) => Some(edit_ops::document_version(content.as_bytes())),
                None if starts_with_replacement(ops) => None,
                None => {
                    return Err(DocumentError::from(PortError::new(
                        PortErrorKind::NotFound,
                        doc.clone(),
                    ))
                    .into())
                }
            },
        };
        let follows_locks = kind == DocumentKind::Note && policy == NoteLockPolicy::Enforce;
        let note_locked = follows_locks && notes::get_note_lock(self.files, &doc)?.locked;
        let now = self.clock.now();
        let edit = edit_ops::edit_document(
            kind,
            current.as_deref(),
            expected_version.as_deref(),
            ops,
            now,
            note_locked,
        )?;
        let changed = edit.changes(current.as_deref());

        let mut writes = Vec::new();
        if changed {
            writes.push(Write {
                doc: doc.clone(),
                ops: Value::Array(ops.to_vec()),
                before: current,
                after: edit.content.clone(),
                effect: ReviewEffect::Review,
            });
        }
        if let Some(lock) = edit.note_lock.filter(|lock| lock.changed && follows_locks) {
            let before = self.read(LOCKS_PATH)?;
            let mut manifest = match &before {
                Some(json) => notes::lock_manifest_from_json(json)?,
                None => Default::default(),
            };
            manifest.set_note_lock(&notes::normalize_lock_path(&doc), lock.locked);
            writes.push(Write {
                doc: LOCKS_PATH.to_string(),
                ops: json!([{ "kind": "set_lock", "note": doc, "locked": lock.locked }]),
                before,
                after: notes::lock_manifest_to_json(&manifest)?,
                effect: ReviewEffect::Review,
            });
        }

        let seqs = self
            .commit_writes(&run.id, &run.actor, now, writes)
            .map_err(DocumentError::from)?;
        Ok(Applied {
            content: edit.content,
            version: edit.version,
            changed,
            note_lock: edit.note_lock,
            seq: changed.then(|| seqs[0]),
        })
    }

    /// An app save: `ops` were made against `base`, which the caller last
    /// synced to and whose version is `expected_version`. When the file
    /// still has that version the ops apply as usual. When someone changed
    /// it since, the save's changes (`base` → `base + ops`) are merged onto
    /// the file with [`review::undo_document`] and the result is written
    /// as-is; overlapping changes or a lock the merge would break reject the
    /// save with nothing written.
    pub fn apply_rebased(
        &self,
        run_id: &str,
        doc: &str,
        expected_version: &str,
        base: &str,
        ops: &[Value],
    ) -> Result<Rebased, RebaseError> {
        let doc = normalize(doc)?;
        let kind = kind_of(&doc)?;
        let _guard = self.lock.acquire().map_err(DocumentError::from)?;
        self.reconcile_locked().map_err(DocumentError::from)?;
        let current = self.read(&doc)?;
        let current_version = current
            .as_deref()
            .map(|c| edit_ops::document_version(c.as_bytes()));
        let stale = |conflicts| RebaseError::Stale {
            current_version: current_version.clone(),
            conflicts,
        };
        if edit_ops::document_version(base.as_bytes()) != expected_version {
            return Err(stale(Vec::new()));
        }
        if current_version.as_deref() == Some(expected_version) {
            let applied = self.apply_locked(
                run_id,
                &doc,
                kind,
                current,
                Expected::Version(expected_version.to_string()),
                ops,
                NoteLockPolicy::Enforce,
            )?;
            return Ok(Rebased {
                applied,
                merged: false,
                local: None,
            });
        }
        let Some(on_disk) = current else {
            return Err(stale(Vec::new()));
        };
        let run = self.log.run(run_id).map_err(DocumentError::from)?;
        let note_locked =
            kind == DocumentKind::Note && notes::get_note_lock(self.files, &doc)?.locked;
        let now = self.clock.now();
        let local = edit_ops::edit_document(
            kind,
            Some(base),
            Some(expected_version),
            ops,
            now,
            note_locked,
        )?;
        if local.note_lock.is_some_and(|lock| lock.changed) {
            return Err(stale(Vec::new()));
        }
        let merged = review::undo_document(
            kind,
            Some(&on_disk),
            &[UndoWrite {
                before: Some(local.content.clone()),
                after: Some(base.to_string()),
            }],
            note_locked,
            now,
        )
        .map_err(|err| match err {
            UndoError::Conflicts(conflicts) => stale(conflicts),
            UndoError::Locked(_) | UndoError::LockedStoryboard | UndoError::LockedNote => {
                stale(Vec::new())
            }
            UndoError::Document(err) => RebaseError::Edit(err.into()),
        })?;
        let Some(content) = merged.content else {
            return Err(stale(Vec::new()));
        };
        let changed = content != on_disk;
        let mut seq = None;
        if changed {
            let seqs = self
                .commit_writes(
                    &run.id,
                    &run.actor,
                    now,
                    vec![Write {
                        doc: doc.clone(),
                        ops: json!([{
                            "kind": "rebase",
                            "base_version": expected_version,
                            "ops": ops,
                        }]),
                        before: Some(on_disk),
                        after: content.clone(),
                        effect: ReviewEffect::Review,
                    }],
                )
                .map_err(DocumentError::from)?;
            seq = Some(seqs[0]);
        }
        let version = edit_ops::document_version(content.as_bytes());
        Ok(Rebased {
            applied: Applied {
                content,
                version,
                changed,
                note_lock: None,
                seq,
            },
            merged: true,
            local: Some(local.content),
        })
    }

    /// Runs with changes nobody has kept or undone, oldest first.
    pub fn pending_reviews(&self) -> Result<Vec<RunReview>, PortError> {
        let mut runs: Vec<RunReview> = Vec::new();
        let mut docs: BTreeMap<(String, String), Vec<OpLogEntry>> = BTreeMap::new();
        let mut order: Vec<(String, String)> = Vec::new();
        for entry in self.log.unreviewed()? {
            let key = (entry.write.run_id.clone(), entry.write.doc.clone());
            if !docs.contains_key(&key) {
                order.push(key.clone());
            }
            docs.entry(key).or_default().push(entry);
        }
        for key in order {
            let entries = &docs[&key];
            let (first, last) = (&entries[0], &entries[entries.len() - 1]);
            let document = DocumentReview {
                doc: key.1.clone(),
                through_seq: last.seq,
                writes: entries.len() as u32,
                created: first.write.before_hash == ABSENT_HASH,
                last_at: timestamp(last.write.at),
            };
            match runs.iter_mut().find(|run| run.run_id == key.0) {
                Some(run) => run.documents.push(document),
                None => {
                    let run = self.log.run(&key.0)?;
                    runs.push(RunReview {
                        run_id: run.id,
                        actor: run.actor,
                        started_at: timestamp(run.started_at),
                        documents: vec![document],
                    });
                }
            }
        }
        Ok(runs)
    }

    /// Keeps `run_id`'s changes to `doc` up to `through_seq`, the
    /// [`DocumentReview`] token. Stale if the run wrote to `doc` since.
    pub fn keep(&self, run_id: &str, doc: &str, through_seq: u64) -> Result<(), ReviewError> {
        let doc = normalize(doc)?;
        let _guard = self.lock.acquire()?;
        self.reconcile_locked()?;
        self.reviewed_entries(run_id, &doc, through_seq)?;
        self.log
            .resolve(run_id, &doc, through_seq, Resolution::Kept)?;
        Ok(())
    }

    /// Reverts `run_id`'s changes to `doc` up to `through_seq`, keeping
    /// later edits by others where they don't overlap. The revert is itself
    /// a write in a `review` run, so it is logged and crash-safe.
    pub fn undo(&self, run_id: &str, doc: &str, through_seq: u64) -> Result<(), ReviewError> {
        let doc = normalize(doc)?;
        let _guard = self.lock.acquire()?;
        self.reconcile_locked()?;
        let entries = self.reviewed_entries(run_id, &doc, through_seq)?;
        let current = self.read(&doc)?;
        let content = if doc == LOCKS_PATH {
            undo_whole_file(current.as_deref(), &entries)?
        } else {
            self.undo_document(&doc, current.as_deref(), &entries)?
        };
        if content == current {
            self.log
                .resolve(run_id, &doc, through_seq, Resolution::Undone)?;
            return Ok(());
        }
        let Some(after) = content else {
            // Undoing a document the run created. Deletes aren't logged; a
            // crash before resolving leaves it up for review, and undoing
            // again finds it already gone.
            self.files.remove(Path::new(&doc))?;
            self.log
                .resolve(run_id, &doc, through_seq, Resolution::Undone)?;
            return Ok(());
        };
        let now = self.clock.now();
        let review_run = self.log.begin_run(REVIEW_ACTOR, now)?;
        self.commit_writes(
            &review_run,
            REVIEW_ACTOR,
            now,
            vec![Write {
                doc: doc.clone(),
                ops: json!([{ "kind": "undo_run", "run_id": run_id, "through_seq": through_seq }]),
                before: current,
                after,
                effect: ReviewEffect::Undo {
                    run_id: run_id.to_string(),
                    doc,
                    through_seq,
                },
            }],
        )?;
        Ok(())
    }

    /// The run's unresolved writes to `doc`, checking `through_seq` is the
    /// newest of them.
    fn reviewed_entries(
        &self,
        run_id: &str,
        doc: &str,
        through_seq: u64,
    ) -> Result<Vec<OpLogEntry>, ReviewError> {
        let entries: Vec<_> = self
            .log
            .entries_for_run(run_id)?
            .into_iter()
            .filter(|e| {
                e.write.doc == doc && e.state == OpLogState::Committed && e.resolution.is_none()
            })
            .collect();
        match entries.last() {
            Some(last) if last.seq == through_seq => Ok(entries),
            _ => Err(ReviewError::Stale),
        }
    }

    fn undo_document(
        &self,
        doc: &str,
        current: Option<&str>,
        entries: &[OpLogEntry],
    ) -> Result<Option<String>, ReviewError> {
        let kind = kind_of(doc)?;
        let writes = match entries
            .iter()
            .map(|e| e.write.images.clone())
            .collect::<Option<Vec<_>>>()
        {
            Some(images) => images
                .into_iter()
                .map(|images| UndoWrite {
                    before: images.before,
                    after: images.after,
                })
                .collect::<Vec<_>>(),
            None => return legacy_undo(current, entries),
        };
        let note_locked =
            kind == DocumentKind::Note && notes::get_note_lock(self.files, doc)?.locked;
        Ok(review::undo_document(kind, current, &writes, note_locked, self.clock.now())?.content)
    }

    /// Logs every write pending, replaces the files, then commits them. A
    /// crash in between is settled by [`Self::reconcile`], file by file.
    fn commit_writes(
        &self,
        run_id: &str,
        actor: &str,
        at: DateTime<Utc>,
        writes: Vec<Write>,
    ) -> Result<Vec<u64>, PortError> {
        let run_entries = if writes.is_empty() {
            Vec::new()
        } else {
            self.log.entries_for_run(run_id)?
        };
        let mut seqs = Vec::with_capacity(writes.len());
        for write in &writes {
            let first_write = !run_entries
                .iter()
                .any(|e| e.write.doc == write.doc && e.state == OpLogState::Committed);
            let baseline = first_write.then(|| match &write.before {
                Some(content) => Baseline::Content(content.clone()),
                None => Baseline::Absent,
            });
            seqs.push(
                self.log.append_pending(NewOpLogEntry {
                    run_id: run_id.to_string(),
                    doc: write.doc.clone(),
                    actor: actor.to_string(),
                    ops: write.ops.clone(),
                    before_hash: write
                        .before
                        .as_deref()
                        .map(|c| edit_ops::document_version(c.as_bytes()))
                        .unwrap_or_else(|| ABSENT_HASH.to_string()),
                    after_hash: edit_ops::document_version(write.after.as_bytes()),
                    at,
                    baseline,
                    images: Some(Images {
                        before: write.before.clone(),
                        after: Some(write.after.clone()),
                    }),
                    effect: if actor == USER_ACTOR {
                        ReviewEffect::AutoKeep
                    } else {
                        write.effect.clone()
                    },
                })?,
            );
        }
        for write in &writes {
            self.files
                .write_atomic(Path::new(&write.doc), write.after.as_bytes())?;
        }
        for seq in &seqs {
            self.log.commit(*seq)?;
        }
        Ok(seqs)
    }

    /// Settles writes interrupted by a crash: a pending entry whose document
    /// has its `after_hash` landed; any other didn't.
    pub fn reconcile(&self) -> Result<Reconciled, PortError> {
        let _guard = self.lock.acquire()?;
        self.reconcile_locked()
    }

    fn reconcile_locked(&self) -> Result<Reconciled, PortError> {
        let mut settled = Reconciled::default();
        for entry in self.log.pending()? {
            let on_disk = match self.files.read(Path::new(&entry.write.doc)) {
                Ok(bytes) => Some(edit_ops::document_version(&bytes)),
                Err(err) if err.kind == PortErrorKind::NotFound => None,
                Err(err) => return Err(err),
            };
            if on_disk.as_deref() == Some(entry.write.after_hash.as_str()) {
                self.log.commit(entry.seq)?;
                settled.committed.push(entry.seq);
            } else {
                self.log.abandon(entry.seq)?;
                settled.abandoned.push(entry.seq);
            }
        }
        Ok(settled)
    }

    fn read(&self, doc: &str) -> Result<Option<String>, DocumentError> {
        match self.files.read(Path::new(doc)) {
            // Matches std::fs::read_to_string: invalid UTF-8 is an I/O failure.
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
                DocumentError::Port(PortError::new(
                    PortErrorKind::Io,
                    "stream did not contain valid UTF-8",
                ))
            }),
            Err(err) if err.kind == PortErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }
}

/// Undo for writes logged before review kept images: only a clean revert to
/// the run's baseline, when nothing changed the document since.
fn legacy_undo(
    current: Option<&str>,
    entries: &[OpLogEntry],
) -> Result<Option<String>, ReviewError> {
    let on_disk = current.map(|c| edit_ops::document_version(c.as_bytes()));
    let chained = entries
        .windows(2)
        .all(|pair| pair[1].write.before_hash == pair[0].write.after_hash);
    let last = &entries[entries.len() - 1].write;
    let clean = chained && on_disk.as_deref() == Some(last.after_hash.as_str());
    match (&entries[0].write.baseline, clean) {
        (Some(Baseline::Content(content)), true) => Ok(Some(content.clone())),
        (Some(Baseline::Absent), true) => Ok(None),
        _ => Err(conflict(Some(last.after_hash.clone()), on_disk)),
    }
}

/// Files without entity structure (the lock manifest) undo only cleanly.
fn undo_whole_file(
    current: Option<&str>,
    entries: &[OpLogEntry],
) -> Result<Option<String>, ReviewError> {
    let images: Option<Vec<_>> = entries.iter().map(|e| e.write.images.clone()).collect();
    let Some(images) = images else {
        return legacy_undo(current, entries);
    };
    let chained = images
        .windows(2)
        .all(|pair| pair[1].before == pair[0].after);
    let last = images[images.len() - 1].after.as_deref();
    if chained && current == last {
        return Ok(images[0].before.clone());
    }
    let version = |c: Option<&str>| c.map(|c| edit_ops::document_version(c.as_bytes()));
    Err(conflict(version(last), version(current)))
}

fn conflict(expected: Option<String>, current: Option<String>) -> ReviewError {
    ReviewError::Undo(UndoError::Conflicts(vec![UndoConflict {
        path: String::new(),
        expected_version: expected,
        current_version: current,
    }]))
}

fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

/// The canonical project-relative form (`/`-separated) the op log keys on.
fn normalize(doc: &str) -> Result<String, DocumentError> {
    let path = project_relative(doc)?;
    let parts: Vec<_> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Ok(parts.join("/"))
}

fn starts_with_replacement(ops: &[Value]) -> bool {
    matches!(
        ops.first()
            .and_then(|op| op.get("kind"))
            .and_then(Value::as_str),
        Some("replace_sketch" | "replace_storyboard" | "replace_note")
    )
}
#[cfg(test)]
#[path = "edit_session_tests.rs"]
mod tests;
