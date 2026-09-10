//! Per-run steering routing.
//!
//! Steering messages (typed into the composer while an agent run is in flight)
//! must reach *the run they were meant for* and no other. The Prompty engine
//! owns a per-run [`PromptySteering`] queue, but the host previously shared a
//! single queue across every run: two concurrent top-level runs both subscribed
//! to it and each drained the other's steering — a cross-run leak.
//!
//! [`SteeringRegistry`] fixes that by giving every active run its own private
//! queue, keyed by the frontend's client run id (the same identity used to
//! cancel a run). Delivery is explicit: [`SteeringRegistry::send`] targets one
//! run by key and drops the message if that key names no active run, so a
//! message can never fan out to — or be guessed onto — an unintended run or
//! project.
//!
//! ## Project-transition policy
//!
//! Runs are **detached** from the active project. A run captures its originating
//! repo/project roots at start (into the harness request) and keeps its private
//! steering queue for its whole lifetime. Switching the active project while a
//! run is in flight therefore neither cancels the run nor reattributes its
//! steering or output — both stay bound to the run that produced them. Steering
//! typed after a switch is routed by run id, so it still reaches the intended
//! (originating) run, or is dropped if that run has already ended.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use harness_prompty::PromptySteering;

/// Routes steering messages to the specific run that should receive them.
///
/// Cloneable and shared through `AppState`; all clones observe the same set of
/// active per-run queues.
#[derive(Clone, Default)]
pub struct SteeringRegistry {
    inner: Arc<Mutex<HashMap<String, PromptySteering>>>,
}

impl SteeringRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a fresh private steering queue for `run_key`.
    ///
    /// Returns the queue to hand to the harness for this run, plus a guard that
    /// deregisters the queue when the run ends (on drop). Registering the same
    /// key again replaces any stale queue, so a reused client run id can never
    /// drain a previous run's messages.
    pub fn register(&self, run_key: String) -> (PromptySteering, SteeringGuard) {
        let steering = PromptySteering::new();
        if let Ok(mut map) = self.inner.lock() {
            map.insert(run_key.clone(), steering.clone());
        }
        (
            steering,
            SteeringGuard {
                registry: self.inner.clone(),
                run_key,
            },
        )
    }

    /// Deliver `message` to a run's steering queue.
    ///
    /// Delivery is always explicit: the message reaches the run named by
    /// `run_key` and no other, and is dropped (returns `false`) when that run is
    /// unknown, ended, or unsubscribed. There is deliberately no "sole active
    /// run" convenience — one active run does not prove it belongs to the
    /// composer/project/window that sent the message, so a missing key must
    /// drop rather than risk steering the wrong run.
    pub fn send(&self, run_key: &str, message: &str) -> bool {
        let steering = {
            let Ok(map) = self.inner.lock() else {
                return false;
            };
            map.get(run_key).cloned()
        };
        match steering {
            Some(queue) => queue.send(message),
            None => false,
        }
    }

    /// Number of active per-run queues. Test/diagnostic aid.
    #[cfg(test)]
    pub fn active_len(&self) -> usize {
        self.inner.lock().map(|map| map.len()).unwrap_or(0)
    }
}

/// Deregisters a run's steering queue when dropped, so a finished run never
/// leaves a queue behind for a later reused id to inherit.
pub struct SteeringGuard {
    registry: Arc<Mutex<HashMap<String, PromptySteering>>>,
    run_key: String,
}

impl Drop for SteeringGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.registry.lock() {
            map.remove(&self.run_key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_runs_do_not_share_steering_messages() {
        let registry = SteeringRegistry::new();
        let (queue_a, _guard_a) = registry.register("run-a".to_string());
        let (queue_b, _guard_b) = registry.register("run-b".to_string());

        // Each run subscribes to its own queue, as the harness does at run start.
        let sub_a = queue_a.subscribe();
        let sub_b = queue_b.subscribe();

        // Steering addressed to run A must reach only run A.
        assert!(registry.send("run-a", "for A"));
        assert_eq!(sub_a.drain(), vec!["for A".to_string()]);
        assert!(
            sub_b.drain().is_empty(),
            "run B must not receive run A's steering"
        );

        // ...and vice versa.
        assert!(registry.send("run-b", "for B"));
        assert_eq!(sub_b.drain(), vec!["for B".to_string()]);
        assert!(sub_a.drain().is_empty());
    }

    #[test]
    fn send_to_unknown_run_is_not_delivered() {
        let registry = SteeringRegistry::new();
        let (_queue, _guard) = registry.register("run-a".to_string());
        assert!(
            !registry.send("run-missing", "hi"),
            "a message for an inactive run is dropped, not misrouted"
        );
    }

    #[test]
    fn delivery_requires_an_explicit_key_even_with_a_sole_run() {
        // A single active run must NOT be steered by a message that names a
        // different (or no) run: "exactly one run" does not prove the message
        // belongs to it, so an unmatched key drops rather than guessing.
        let registry = SteeringRegistry::new();
        let (queue_a, _guard_a) = registry.register("run-a".to_string());
        let sub_a = queue_a.subscribe();
        assert!(!registry.send("someone-else", "not for you"));
        assert!(
            sub_a.drain().is_empty(),
            "the sole run must not inherit a message addressed elsewhere"
        );
        // The correctly addressed message still reaches it.
        assert!(registry.send("run-a", "for you"));
        assert_eq!(sub_a.drain(), vec!["for you".to_string()]);
    }

    #[test]
    fn guard_drop_deregisters_the_queue() {
        let registry = SteeringRegistry::new();
        {
            let (_queue, _guard) = registry.register("run-a".to_string());
            assert_eq!(registry.active_len(), 1);
        }
        assert_eq!(registry.active_len(), 0, "guard drop must remove the queue");
        assert!(!registry.send("run-a", "gone"));
    }
}
