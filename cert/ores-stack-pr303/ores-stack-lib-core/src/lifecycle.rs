use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    #[must_use]
    pub fn new() -> Self {
        return Self::default();
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        return self.cancelled.load(Ordering::Acquire);
    }
}

#[derive(Clone, Debug)]
pub struct RequestContext {
    deadline: Instant,
    request_cancel: CancellationToken,
    shutdown_cancel: CancellationToken,
}

impl RequestContext {
    fn new(deadline: Instant, shutdown_cancel: CancellationToken) -> Self {
        return Self {
            deadline,
            request_cancel: CancellationToken::new(),
            shutdown_cancel,
        };
    }

    #[must_use]
    pub fn deadline(&self) -> Instant {
        return self.deadline;
    }

    #[must_use]
    pub fn remaining(&self) -> Duration {
        return self.deadline.saturating_duration_since(Instant::now());
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        return self.request_cancel.is_cancelled()
            || self.shutdown_cancel.is_cancelled()
            || Instant::now() >= self.deadline;
    }

    pub fn cancel(&self) {
        self.request_cancel.cancel();
    }

    /// Creates child work that cannot outlive its caller. The child receives
    /// the same request/shutdown cancellation signals, and its deadline is the
    /// earlier of the parent deadline and its requested local timeout.
    #[must_use]
    pub fn child_with_timeout(&self, timeout: Duration) -> Self {
        let now = Instant::now();
        let requested_deadline = now.checked_add(timeout).unwrap_or(self.deadline);
        let deadline = requested_deadline.min(self.deadline);
        return Self {
            deadline,
            request_cancel: self.request_cancel.clone(),
            shutdown_cancel: self.shutdown_cancel.clone(),
        };
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthSnapshot {
    pub live: bool,
    pub ready: bool,
    pub accepting: bool,
    pub dependency_ready: bool,
    pub in_flight: usize,
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum AdmissionRejection {
    #[error("server is draining and no longer admits new requests")]
    Draining,
    #[error("server dependencies are not ready")]
    NotReady,
    #[error("server is not live")]
    NotLive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainOutcome {
    Complete,
    TimedOut { remaining: usize },
}

#[derive(Clone, Debug)]
pub struct RuntimeLifecycle {
    inner: Arc<LifecycleInner>,
}

#[derive(Debug)]
struct LifecycleInner {
    accepting: AtomicBool,
    dependency_ready: AtomicBool,
    live: AtomicBool,
    in_flight: AtomicUsize,
    shutdown_cancel: CancellationToken,
    drain_mutex: Mutex<()>,
    drain_changed: Condvar,
}

impl Default for RuntimeLifecycle {
    fn default() -> Self {
        return Self::new();
    }
}

impl RuntimeLifecycle {
    #[must_use]
    pub fn new() -> Self {
        return Self {
            inner: Arc::new(LifecycleInner {
                accepting: AtomicBool::new(true),
                dependency_ready: AtomicBool::new(true),
                live: AtomicBool::new(true),
                in_flight: AtomicUsize::new(0),
                shutdown_cancel: CancellationToken::new(),
                drain_mutex: Mutex::new(()),
                drain_changed: Condvar::new(),
            }),
        };
    }

    #[must_use]
    pub fn health(&self) -> HealthSnapshot {
        let live = self.inner.live.load(Ordering::Acquire);
        let accepting = self.inner.accepting.load(Ordering::Acquire);
        let dependency_ready = self.inner.dependency_ready.load(Ordering::Acquire);
        return HealthSnapshot {
            live,
            ready: live && accepting && dependency_ready,
            accepting,
            dependency_ready,
            in_flight: self.inner.in_flight.load(Ordering::Acquire),
        };
    }

    /// Dependency outages remove readiness but deliberately preserve liveness.
    /// A supervisor should stop routing new work, not restart-loop a healthy
    /// process merely because an external database/RPC dependency is down.
    pub fn set_dependency_ready(&self, ready: bool) {
        self.inner.dependency_ready.store(ready, Ordering::Release);
    }

    /// Marks an unrecoverable process-local failure. This is intentionally a
    /// distinct operation from dependency readiness.
    pub fn mark_not_live(&self) {
        self.inner.live.store(false, Ordering::Release);
        self.inner.accepting.store(false, Ordering::Release);
        self.inner.shutdown_cancel.cancel();
        self.inner.drain_changed.notify_all();
    }

    pub fn try_admit(&self, timeout: Duration) -> Result<AdmittedRequest, AdmissionRejection> {
        self.preflight_admission()?;

        self.inner.in_flight.fetch_add(1, Ordering::AcqRel);

        // Re-check after incrementing so a concurrent drain/readiness change
        // cannot leave a newly admitted request on the wrong side of the gate.
        if let Err(error) = self.preflight_admission() {
            self.release_request();
            return Err(error);
        }

        let now = Instant::now();
        let deadline = now.checked_add(timeout).unwrap_or(now);
        return Ok(AdmittedRequest {
            context: RequestContext::new(deadline, self.inner.shutdown_cancel.clone()),
            permit: Some(RequestPermit {
                lifecycle: self.clone(),
            }),
        });
    }

    fn preflight_admission(&self) -> Result<(), AdmissionRejection> {
        if !self.inner.live.load(Ordering::Acquire) {
            return Err(AdmissionRejection::NotLive);
        }
        if !self.inner.accepting.load(Ordering::Acquire) {
            return Err(AdmissionRejection::Draining);
        }
        if !self.inner.dependency_ready.load(Ordering::Acquire) {
            return Err(AdmissionRejection::NotReady);
        }
        return Ok(());
    }

    pub fn begin_drain(&self) {
        self.inner.accepting.store(false, Ordering::Release);
        self.inner.drain_changed.notify_all();
    }

    /// Waits for admitted work to finish until `deadline`. If work remains at
    /// the deadline, the shared shutdown token is cancelled before returning,
    /// giving handlers, DB/RPC adapters, and child tasks one common signal to
    /// abort promptly.
    pub fn drain_until(&self, deadline: Instant) -> DrainOutcome {
        self.begin_drain();
        let mut guard = self
            .inner
            .drain_mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        loop {
            let remaining = self.inner.in_flight.load(Ordering::Acquire);
            if remaining == 0 {
                return DrainOutcome::Complete;
            }

            let now = Instant::now();
            if now >= deadline {
                self.inner.shutdown_cancel.cancel();
                return DrainOutcome::TimedOut { remaining };
            }

            let wait_for = deadline.saturating_duration_since(now);
            let waited = self.inner.drain_changed.wait_timeout(guard, wait_for);
            let (next_guard, _) = waited.unwrap_or_else(|poisoned| poisoned.into_inner());
            guard = next_guard;
        }
    }

    fn release_request(&self) {
        let previous = self.inner.in_flight.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "in-flight request counter underflow");
        self.inner.drain_changed.notify_all();
    }
}

#[derive(Debug)]
pub struct AdmittedRequest {
    context: RequestContext,
    permit: Option<RequestPermit>,
}

impl AdmittedRequest {
    #[must_use]
    pub fn context(&self) -> &RequestContext {
        return &self.context;
    }

    /// Explicit completion is equivalent to dropping the admission guard but
    /// makes handler adapters able to release in-flight accounting at a clear
    /// lifecycle boundary.
    pub fn complete(mut self) {
        self.permit.take();
    }
}

#[derive(Debug)]
struct RequestPermit {
    lifecycle: RuntimeLifecycle,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.lifecycle.release_request();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_outage_removes_readiness_without_removing_liveness() {
        let lifecycle = RuntimeLifecycle::new();
        lifecycle.set_dependency_ready(false);

        let health = lifecycle.health();
        assert!(health.live);
        assert!(!health.ready);
        assert!(health.accepting);
        assert!(!health.dependency_ready);
        assert!(matches!(
            lifecycle.try_admit(Duration::from_secs(1)),
            Err(AdmissionRejection::NotReady)
        ));
    }

    #[test]
    fn draining_stops_new_admission() {
        let lifecycle = RuntimeLifecycle::new();
        lifecycle.begin_drain();

        let health = lifecycle.health();
        assert!(health.live);
        assert!(!health.ready);
        assert!(!health.accepting);
        assert!(matches!(
            lifecycle.try_admit(Duration::from_secs(1)),
            Err(AdmissionRejection::Draining)
        ));
    }

    #[test]
    fn draining_completes_when_in_flight_work_finishes_before_deadline() {
        let lifecycle = RuntimeLifecycle::new();
        let request = lifecycle
            .try_admit(Duration::from_secs(10))
            .expect("request admitted");
        assert_eq!(lifecycle.health().in_flight, 1);

        request.complete();
        assert_eq!(
            lifecycle.drain_until(Instant::now() + Duration::from_millis(50)),
            DrainOutcome::Complete
        );
        assert_eq!(lifecycle.health().in_flight, 0);
    }

    #[test]
    fn drain_deadline_cancels_remaining_work() {
        let lifecycle = RuntimeLifecycle::new();
        let request = lifecycle
            .try_admit(Duration::from_secs(10))
            .expect("request admitted");
        let context = request.context().clone();

        assert_eq!(
            lifecycle.drain_until(Instant::now()),
            DrainOutcome::TimedOut { remaining: 1 }
        );
        assert!(context.is_cancelled());
        drop(request);
    }

    #[test]
    fn child_work_inherits_cancellation_and_cannot_extend_parent_deadline() {
        let lifecycle = RuntimeLifecycle::new();
        let request = lifecycle
            .try_admit(Duration::from_secs(10))
            .expect("request admitted");
        let parent = request.context().clone();
        let child = parent.child_with_timeout(Duration::from_secs(60));
        assert!(child.deadline() <= parent.deadline());

        parent.cancel();
        assert!(parent.is_cancelled());
        assert!(child.is_cancelled());
        drop(request);
    }

    #[test]
    fn shorter_child_deadline_is_preserved() {
        let lifecycle = RuntimeLifecycle::new();
        let request = lifecycle
            .try_admit(Duration::from_secs(10))
            .expect("request admitted");
        let parent = request.context().clone();
        let child = parent.child_with_timeout(Duration::from_millis(10));
        assert!(child.deadline() < parent.deadline());
        drop(request);
    }
}
