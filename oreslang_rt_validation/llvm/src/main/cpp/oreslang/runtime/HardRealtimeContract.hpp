#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace oreslang::runtime::rt {

enum class SchedulingPolicy : std::uint8_t {
    FixedPriority,
    EarliestDeadlineFirst,
};

enum class AdmissionFailure : std::uint8_t {
    None,
    MissingTimingBudget,
    ManagedHeap,
    TracingGc,
    RuntimeCodeGeneration,
    UnknownFfi,
    UnboundedAllocation,
    UnboundedBlocking,
    UnboundedLoop,
    UnboundedCleanup,
    PageFaultRisk,
};

struct Effects final {
    bool managed_heap = false;
    bool tracing_gc = false;
    bool runtime_codegen = false;
    bool unknown_ffi = false;
    bool unbounded_allocation = false;
    bool unbounded_blocking = false;
    bool unbounded_loop = false;
    bool unbounded_cleanup = false;
    bool page_fault_risk = false;
};

struct TimingBudget final {
    std::uint64_t deadline_ns = 0;
    std::uint64_t wcet_ns = 0;
    std::uint64_t max_blocking_ns = 0;
    std::uint64_t max_jitter_ns = 0;
    std::uint64_t period_ns = 0;
    std::size_t max_memory_bytes = 0;
    SchedulingPolicy scheduler = SchedulingPolicy::FixedPriority;
};

struct AdmissionResult final {
    AdmissionFailure failure = AdmissionFailure::None;

    constexpr explicit operator bool() const noexcept {
        return failure == AdmissionFailure::None;
    }
};

constexpr AdmissionResult admit_native_hard_rt(
    const Effects effects,
    const TimingBudget budget) noexcept {

    if (budget.deadline_ns == 0 || budget.wcet_ns == 0)
        return {AdmissionFailure::MissingTimingBudget};

    if (effects.managed_heap)
        return {AdmissionFailure::ManagedHeap};
    if (effects.tracing_gc)
        return {AdmissionFailure::TracingGc};
    if (effects.runtime_codegen)
        return {AdmissionFailure::RuntimeCodeGeneration};
    if (effects.unknown_ffi)
        return {AdmissionFailure::UnknownFfi};
    if (effects.unbounded_allocation)
        return {AdmissionFailure::UnboundedAllocation};
    if (effects.unbounded_blocking)
        return {AdmissionFailure::UnboundedBlocking};
    if (effects.unbounded_loop)
        return {AdmissionFailure::UnboundedLoop};
    if (effects.unbounded_cleanup)
        return {AdmissionFailure::UnboundedCleanup};
    if (effects.page_fault_risk)
        return {AdmissionFailure::PageFaultRisk};

    // Compare by subtraction instead of summing the terms. This is both
    // the response-time bound check and an overflow-safe implementation.
    if (budget.wcet_ns > budget.deadline_ns)
        return {AdmissionFailure::MissingTimingBudget};
    auto remaining = budget.deadline_ns - budget.wcet_ns;
    if (budget.max_blocking_ns > remaining)
        return {AdmissionFailure::MissingTimingBudget};
    remaining -= budget.max_blocking_ns;
    if (budget.max_jitter_ns > remaining)
        return {AdmissionFailure::MissingTimingBudget};

    return {};
}

constexpr std::string_view diagnostic_code(
    const AdmissionFailure failure) noexcept {
    switch (failure) {
        case AdmissionFailure::None: return "OK";
        case AdmissionFailure::MissingTimingBudget: return "RT003_WCET_UNPROVEN";
        case AdmissionFailure::ManagedHeap: return "RT004_MANAGED_HEAP_ESCAPE";
        case AdmissionFailure::TracingGc: return "RT011_COLLECTOR_INTERFERENCE";
        case AdmissionFailure::RuntimeCodeGeneration: return "RT005_DYNAMIC_CODE";
        case AdmissionFailure::UnknownFfi: return "RT007_UNKNOWN_FFI";
        case AdmissionFailure::UnboundedAllocation: return "RT001_UNBOUNDED_ALLOCATION";
        case AdmissionFailure::UnboundedBlocking: return "RT002_UNBOUNDED_BLOCKING";
        case AdmissionFailure::UnboundedLoop: return "RT008_UNBOUNDED_LOOP";
        case AdmissionFailure::UnboundedCleanup: return "RT006_UNBOUNDED_CLEANUP";
        case AdmissionFailure::PageFaultRisk: return "RT010_PAGE_FAULT_RISK";
    }
    return "RT_UNKNOWN";
}

} // namespace oreslang::runtime::rt
