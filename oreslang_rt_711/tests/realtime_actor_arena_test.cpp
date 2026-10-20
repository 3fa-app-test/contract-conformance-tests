#include "oreslang/runtime/RealtimeActorArena.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>

namespace {

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

} // namespace

int main() {
    constexpr std::size_t kStorageBytes = 64 * 1024;
    alignas(std::max_align_t) std::array<unsigned char, kStorageBytes> storage{};

    const std::size_t required =
        ores_rt_actor_arena_required_bytes(4, 64, 4096);
    require(required > 0 && required <= storage.size(),
            "required byte calculation");

    OresRealtimeActorArena arena{};
    require(ores_rt_actor_arena_init(
                &arena, storage.data(), storage.size(),
                77, 11, 3, 4, 64, 4096) == ORES_RT_ARENA_OK,
            "arena init");

    OresRtArenaTurn turn{};
    require(ores_rt_actor_arena_enter(&arena, 11, 3, &turn) ==
                ORES_RT_ARENA_NOT_SEALED,
            "unsealed arena must reject entry");
    require(ores_rt_actor_arena_seal(&arena, 4096) == ORES_RT_ARENA_OK,
            "arena seal");
    require(ores_rt_actor_arena_enter(&arena, 99, 3, &turn) ==
                ORES_RT_ARENA_WRONG_OWNER,
            "wrong owner");
    require(ores_rt_actor_arena_enter(&arena, 11, 3, &turn) ==
                ORES_RT_ARENA_OK,
            "enter");

    OresRtArenaTurn second{};
    require(ores_rt_actor_arena_enter(&arena, 11, 3, &second) ==
                ORES_RT_ARENA_BUSY,
            "double enter");

    std::array<OresRtArenaHandle, 4> handles{};
    for (auto& handle : handles) {
        require(ores_rt_actor_arena_alloc(&arena, turn, 16, &handle) ==
                    ORES_RT_ARENA_OK,
                "slot allocation");
    }
    OresRtArenaHandle overflow{};
    require(ores_rt_actor_arena_alloc(&arena, turn, 8, &overflow) ==
                ORES_RT_ARENA_CAPACITY,
            "fixed capacity exhaustion");

    const std::uint64_t value = 0x1122334455667788ULL;
    require(ores_rt_actor_arena_write(
                &arena, turn, handles[0], 0, &value, sizeof(value)) ==
                ORES_RT_ARENA_OK,
            "persistent write");
    std::uint64_t observed = 0;
    require(ores_rt_actor_arena_read(
                &arena, turn, handles[0], 0, &observed, sizeof(observed)) ==
                ORES_RT_ARENA_OK,
            "persistent read");
    require(observed == value, "persistent value");

    const OresRtArenaHandle stale = handles[0];
    require(ores_rt_actor_arena_drop(&arena, turn, handles[0]) ==
                ORES_RT_ARENA_OK,
            "drop");
    require(ores_rt_actor_arena_read(
                &arena, turn, stale, 0, &observed, sizeof(observed)) ==
                ORES_RT_ARENA_STALE,
            "stale generation rejected");

    OresRtArenaHandle reused{};
    require(ores_rt_actor_arena_alloc(&arena, turn, 16, &reused) ==
                ORES_RT_ARENA_OK,
            "slot reuse");
    require(reused.index == stale.index &&
                reused.generation == stale.generation + 1,
            "generation increments on reuse");
    observed = std::numeric_limits<std::uint64_t>::max();
    require(ores_rt_actor_arena_read(
                &arena, turn, reused, 0, &observed, sizeof(observed)) ==
                ORES_RT_ARENA_OK,
            "reused read");
    require(observed == 0, "dropped storage must be zeroized");

    OresRtArenaScratch scratch{};
    require(ores_rt_actor_arena_scratch_alloc(
                &arena, turn, 32, alignof(std::uint64_t), &scratch) ==
                ORES_RT_ARENA_OK,
            "scratch allocation");
    require((scratch.offset % alignof(std::uint64_t)) == 0,
            "scratch alignment");
    require(ores_rt_actor_arena_scratch_write(
                &arena, turn, scratch, 0, &value, sizeof(value)) ==
                ORES_RT_ARENA_OK,
            "scratch write");
    observed = 0;
    require(ores_rt_actor_arena_scratch_read(
                &arena, turn, scratch, 0, &observed, sizeof(observed)) ==
                ORES_RT_ARENA_OK,
            "scratch read");
    require(observed == value, "scratch value");

    require(ores_rt_actor_arena_retire(&arena) == ORES_RT_ARENA_BUSY,
            "active arena cannot retire");
    require(ores_rt_actor_arena_leave(&arena, turn) == ORES_RT_ARENA_OK,
            "leave");

    OresRtArenaTurn next{};
    require(ores_rt_actor_arena_enter(&arena, 11, 3, &next) ==
                ORES_RT_ARENA_OK,
            "next turn");
    require(ores_rt_actor_arena_scratch_read(
                &arena, next, scratch, 0, &observed, sizeof(observed)) ==
                ORES_RT_ARENA_STALE,
            "scratch cannot cross turns");
    require(ores_rt_actor_arena_leave(&arena, next) == ORES_RT_ARENA_OK,
            "second leave");

    require(ores_rt_actor_arena_retire(&arena) == ORES_RT_ARENA_OK,
            "retire");
    require(ores_rt_actor_arena_enter(&arena, 11, 3, &next) ==
                ORES_RT_ARENA_RETIRED,
            "retired arena cannot reenter");

    require(ores_rt_actor_arena_required_bytes(
                std::numeric_limits<std::size_t>::max(), 2, 1) == 0,
            "dimension overflow must reject");

    alignas(std::max_align_t) std::array<unsigned char, 1024> tiny{};
    OresRealtimeActorArena tiny_arena{};
    require(ores_rt_actor_arena_init(
                &tiny_arena, tiny.data() + 1, tiny.size() - 1,
                1, 1, 1, 1, 8, 8) == ORES_RT_ARENA_ALIGNMENT,
            "misaligned backing must reject");

    alignas(std::max_align_t)
        std::array<unsigned char, sizeof(OresRealtimeActorArena) + 1024> overlap{};
    auto* overlapping_control =
        reinterpret_cast<OresRealtimeActorArena*>(overlap.data());
    require(ores_rt_actor_arena_init(
                overlapping_control,
                overlap.data(),
                overlap.size(),
                2, 2, 2, 1, 8, 8) == ORES_RT_ARENA_INVALID,
            "control object cannot overlap backing memory");

    return 0;
}
