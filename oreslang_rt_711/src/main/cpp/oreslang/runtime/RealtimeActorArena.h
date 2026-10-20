#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Strict hard-real-time actor arena.
 *
 * The caller owns both this control object and the backing byte region.
 * This implementation never calls malloc/calloc/realloc/free, never takes a
 * lock, and never performs runtime code generation. It is intentionally
 * single-carrier: the scheduler must guarantee that only the admitted carrier
 * touches an arena while a turn is active.
 *
 * Initialization and seal/prefault occur before the hard-RT window. After
 * sealing, allocations are fixed-capacity O(1) free-stack operations; drop and
 * turn-leave zeroization are bounded by slot_bytes and scratch_bytes.
 */
typedef enum OresRtArenaStatus {
    ORES_RT_ARENA_OK = 0,
    ORES_RT_ARENA_INVALID = 1,
    ORES_RT_ARENA_ALIGNMENT = 2,
    ORES_RT_ARENA_CAPACITY = 3,
    ORES_RT_ARENA_NOT_SEALED = 4,
    ORES_RT_ARENA_BUSY = 5,
    ORES_RT_ARENA_WRONG_OWNER = 6,
    ORES_RT_ARENA_STALE = 7,
    ORES_RT_ARENA_RETIRED = 8,
    ORES_RT_ARENA_GENERATION_EXHAUSTED = 9
} OresRtArenaStatus;

typedef struct OresRtArenaTurn {
    uint64_t domain;
    uint64_t epoch;
} OresRtArenaTurn;

typedef struct OresRtArenaHandle {
    uint64_t domain;
    uint64_t index;
    uint64_t generation;
} OresRtArenaHandle;

typedef struct OresRtArenaScratch {
    uint64_t domain;
    uint64_t epoch;
    uint64_t offset;
    uint64_t length;
} OresRtArenaScratch;

typedef struct OresRealtimeArenaSlot {
    uint64_t generation;
    size_t length;
    unsigned char live;
} OresRealtimeArenaSlot;

typedef struct OresRealtimeActorArena {
    uint64_t domain;
    uint64_t owner;
    uint64_t incarnation;
    uint64_t epoch;
    size_t slot_count;
    size_t slot_bytes;
    size_t scratch_bytes;
    size_t scratch_top;
    size_t free_count;
    size_t arena_bytes;
    int active;
    int sealed;
    int retired;
    unsigned char* backing;
    OresRealtimeArenaSlot* slots;
    size_t* free_slots;
    unsigned char* slab;
    unsigned char* scratch;
} OresRealtimeActorArena;

/* Returns 0 on invalid dimensions or arithmetic overflow. */
size_t ores_rt_actor_arena_required_bytes(
    size_t slot_count,
    size_t slot_bytes,
    size_t scratch_bytes);

/*
 * Initializes an arena inside caller-owned, max_align_t-aligned storage.
 * The entire required region is zeroed here, before the hard-RT window.
 */
OresRtArenaStatus ores_rt_actor_arena_init(
    OresRealtimeActorArena* arena,
    void* backing,
    size_t backing_bytes,
    uint64_t domain,
    uint64_t owner,
    uint64_t incarnation,
    size_t slot_count,
    size_t slot_bytes,
    size_t scratch_bytes);

/*
 * Final preparation step. Touches one byte per supplied page plus the final
 * byte and seals the arena against reconfiguration. OS memory locking and CPU
 * reservation remain deployment responsibilities.
 */
OresRtArenaStatus ores_rt_actor_arena_seal(
    OresRealtimeActorArena* arena,
    size_t page_bytes);

OresRtArenaStatus ores_rt_actor_arena_enter(
    OresRealtimeActorArena* arena,
    uint64_t owner,
    uint64_t incarnation,
    OresRtArenaTurn* out_turn);

OresRtArenaStatus ores_rt_actor_arena_leave(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn);

OresRtArenaStatus ores_rt_actor_arena_alloc(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    size_t bytes,
    OresRtArenaHandle* out_handle);

OresRtArenaStatus ores_rt_actor_arena_read(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaHandle handle,
    size_t offset,
    void* out,
    size_t bytes);

OresRtArenaStatus ores_rt_actor_arena_write(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaHandle handle,
    size_t offset,
    const void* src,
    size_t bytes);

OresRtArenaStatus ores_rt_actor_arena_drop(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaHandle handle);

OresRtArenaStatus ores_rt_actor_arena_scratch_alloc(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    size_t bytes,
    size_t alignment,
    OresRtArenaScratch* out_scratch);

OresRtArenaStatus ores_rt_actor_arena_scratch_read(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaScratch scratch,
    size_t offset,
    void* out,
    size_t bytes);

OresRtArenaStatus ores_rt_actor_arena_scratch_write(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaScratch scratch,
    size_t offset,
    const void* src,
    size_t bytes);

/*
 * Bounded teardown. No storage is freed because the scheduler owns backing.
 * Retirement is legal only between turns and zeroes all arena-owned bytes.
 */
OresRtArenaStatus ores_rt_actor_arena_retire(
    OresRealtimeActorArena* arena);

#ifdef __cplusplus
}
#endif
