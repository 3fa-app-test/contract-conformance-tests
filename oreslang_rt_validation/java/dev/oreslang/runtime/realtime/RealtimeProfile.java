package dev.oreslang.runtime.realtime;

import java.util.Objects;

/**
 * Backend-neutral admission skeleton for Java real-time execution.
 *
 * This class does not make the current JVM/Graal runtime hard real time.
 * It records fail-closed properties that a qualified RTSJ/off-heap backend
 * must establish before a path can be labelled java-hard-rt.
 */
public final class RealtimeProfile {
    public enum Scheduler {
        FIXED_PRIORITY,
        EDF
    }

    public enum Failure {
        NONE,
        MISSING_TIMING_BUDGET,
        MANAGED_HEAP_ACCESS,
        TRACING_GC_INTERFERENCE,
        RUNTIME_CODE_GENERATION,
        UNKNOWN_FFI,
        UNBOUNDED_ALLOCATION,
        UNBOUNDED_BLOCKING,
        UNBOUNDED_LOOP,
        UNBOUNDED_CLEANUP,
        PAGE_FAULT_RISK
    }

    public record Effects(
            boolean managedHeapAccess,
            boolean tracingCollectorMayPause,
            boolean runtimeCodeGeneration,
            boolean unknownFfi,
            boolean unboundedAllocation,
            boolean unboundedBlocking,
            boolean unboundedLoop,
            boolean unboundedCleanup,
            boolean pageFaultRisk) {}

    public record Budget(
            long deadlineNs,
            long wcetNs,
            long maxBlockingNs,
            long maxJitterNs,
            long periodNs,
            long maxMemoryBytes,
            Scheduler scheduler) {
        public Budget {
            Objects.requireNonNull(scheduler, "scheduler");
            if (deadlineNs < 0 || wcetNs < 0 || maxBlockingNs < 0
                    || maxJitterNs < 0 || periodNs < 0 || maxMemoryBytes < 0) {
                throw new IllegalArgumentException("real-time budgets must be non-negative");
            }
        }
    }

    public record Result(Failure failure) {
        public boolean admitted() {
            return failure == Failure.NONE;
        }

        public String diagnosticCode() {
            return switch (failure) {
                case NONE -> "OK";
                case MISSING_TIMING_BUDGET -> "RT003_WCET_UNPROVEN";
                case MANAGED_HEAP_ACCESS -> "RT004_MANAGED_HEAP_ESCAPE";
                case TRACING_GC_INTERFERENCE -> "RT011_COLLECTOR_INTERFERENCE";
                case RUNTIME_CODE_GENERATION -> "RT005_DYNAMIC_CODE";
                case UNKNOWN_FFI -> "RT007_UNKNOWN_FFI";
                case UNBOUNDED_ALLOCATION -> "RT001_UNBOUNDED_ALLOCATION";
                case UNBOUNDED_BLOCKING -> "RT002_UNBOUNDED_BLOCKING";
                case UNBOUNDED_LOOP -> "RT008_UNBOUNDED_LOOP";
                case UNBOUNDED_CLEANUP -> "RT006_UNBOUNDED_CLEANUP";
                case PAGE_FAULT_RISK -> "RT010_PAGE_FAULT_RISK";
            };
        }
    }

    private RealtimeProfile() {}

    public static Result admitJavaHardRt(Effects effects, Budget budget) {
        Objects.requireNonNull(effects, "effects");
        Objects.requireNonNull(budget, "budget");

        if (budget.deadlineNs() == 0 || budget.wcetNs() == 0) {
            return new Result(Failure.MISSING_TIMING_BUDGET);
        }
        if (effects.managedHeapAccess()) {
            return new Result(Failure.MANAGED_HEAP_ACCESS);
        }
        if (effects.tracingCollectorMayPause()) {
            return new Result(Failure.TRACING_GC_INTERFERENCE);
        }
        if (effects.runtimeCodeGeneration()) {
            return new Result(Failure.RUNTIME_CODE_GENERATION);
        }
        if (effects.unknownFfi()) {
            return new Result(Failure.UNKNOWN_FFI);
        }
        if (effects.unboundedAllocation()) {
            return new Result(Failure.UNBOUNDED_ALLOCATION);
        }
        if (effects.unboundedBlocking()) {
            return new Result(Failure.UNBOUNDED_BLOCKING);
        }
        if (effects.unboundedLoop()) {
            return new Result(Failure.UNBOUNDED_LOOP);
        }
        if (effects.unboundedCleanup()) {
            return new Result(Failure.UNBOUNDED_CLEANUP);
        }
        if (effects.pageFaultRisk()) {
            return new Result(Failure.PAGE_FAULT_RISK);
        }

        final long response;
        try {
            response = Math.addExact(
                    Math.addExact(budget.wcetNs(), budget.maxBlockingNs()),
                    budget.maxJitterNs());
        } catch (ArithmeticException overflow) {
            return new Result(Failure.MISSING_TIMING_BUDGET);
        }
        if (response > budget.deadlineNs()) {
            return new Result(Failure.MISSING_TIMING_BUDGET);
        }
        return new Result(Failure.NONE);
    }
}
