#include "oreslang/runtime/HardRealtimeContract.hpp"

#include <cassert>
#include <cstdint>
#include <limits>

using namespace oreslang::runtime::rt;

int main() {
    TimingBudget good{};
    good.deadline_ns = 1'000'000;
    good.wcet_ns = 500'000;
    good.max_blocking_ns = 100'000;
    good.max_jitter_ns = 50'000;
    good.period_ns = 10'000'000;
    good.max_memory_bytes = 64 * 1024;

    assert(admit_native_hard_rt({}, good));

    Effects managed{};
    managed.managed_heap = true;
    assert(admit_native_hard_rt(managed, good).failure ==
           AdmissionFailure::ManagedHeap);

    Effects ffi{};
    ffi.unknown_ffi = true;
    assert(admit_native_hard_rt(ffi, good).failure ==
           AdmissionFailure::UnknownFfi);

    Effects tracing{};
    tracing.tracing_gc = true;
    assert(admit_native_hard_rt(tracing, good).failure ==
           AdmissionFailure::TracingGc);
    assert(diagnostic_code(AdmissionFailure::TracingGc) ==
           "RT011_COLLECTOR_INTERFERENCE");

    Effects cleanup{};
    cleanup.unbounded_cleanup = true;
    assert(admit_native_hard_rt(cleanup, good).failure ==
           AdmissionFailure::UnboundedCleanup);

    TimingBudget impossible = good;
    impossible.wcet_ns = 950'000;
    impossible.max_blocking_ns = 100'000;
    assert(!admit_native_hard_rt({}, impossible));

    TimingBudget overflow = good;
    overflow.deadline_ns = std::numeric_limits<std::uint64_t>::max();
    overflow.wcet_ns = std::numeric_limits<std::uint64_t>::max() - 10;
    overflow.max_blocking_ns = 8;
    overflow.max_jitter_ns = 8;
    assert(admit_native_hard_rt({}, overflow).failure ==
           AdmissionFailure::MissingTimingBudget);

    TimingBudget exact = good;
    exact.deadline_ns = 650'000;
    assert(admit_native_hard_rt({}, exact));

    TimingBudget missing{};
    assert(admit_native_hard_rt({}, missing).failure ==
           AdmissionFailure::MissingTimingBudget);

    static_assert(diagnostic_code(AdmissionFailure::UnboundedLoop) ==
                  "RT008_UNBOUNDED_LOOP");

    return 0;
}
