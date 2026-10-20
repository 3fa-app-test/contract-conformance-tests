#include "oreslang/runtime/RealtimeActorArena.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static _Thread_local OresRealtimeActorArena* ores_rt_carrier_arena;
static _Thread_local uint64_t ores_rt_carrier_epoch;

static int checked_add(size_t a, size_t b, size_t* out) {
    if (!out || b > SIZE_MAX - a) return 0;
    *out = a + b;
    return 1;
}

static int checked_mul(size_t a, size_t b, size_t* out) {
    if (!out || (a != 0 && b > SIZE_MAX / a)) return 0;
    *out = a * b;
    return 1;
}

static int align_up(size_t value, size_t alignment, size_t* out) {
    size_t with_mask;
    if (!out || alignment == 0 || (alignment & (alignment - 1)) != 0) return 0;
    if (!checked_add(value, alignment - 1, &with_mask)) return 0;
    *out = with_mask & ~(alignment - 1);
    return 1;
}

size_t ores_rt_actor_arena_required_bytes(
    size_t slot_count,
    size_t slot_bytes,
    size_t scratch_bytes) {
    if (slot_count == 0 || slot_bytes == 0 || scratch_bytes == 0) return 0;

    const size_t alignment = _Alignof(max_align_t);
    size_t offset = 0;
    size_t bytes = 0;

    if (!align_up(offset, alignment, &offset)) return 0;
    if (!checked_mul(slot_count, sizeof(OresRealtimeArenaSlot), &bytes) ||
        !checked_add(offset, bytes, &offset)) return 0;

    if (!align_up(offset, alignment, &offset)) return 0;
    if (!checked_mul(slot_count, sizeof(size_t), &bytes) ||
        !checked_add(offset, bytes, &offset)) return 0;

    if (!align_up(offset, alignment, &offset)) return 0;
    if (!checked_mul(slot_count, slot_bytes, &bytes) ||
        !checked_add(offset, bytes, &offset)) return 0;

    if (!align_up(offset, alignment, &offset)) return 0;
    if (!checked_add(offset, scratch_bytes, &offset)) return 0;

    return offset;
}

static OresRtArenaStatus require_turn(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn) {
    if (!arena) return ORES_RT_ARENA_INVALID;
    if (arena->retired) return ORES_RT_ARENA_RETIRED;
    if (!arena->sealed) return ORES_RT_ARENA_NOT_SEALED;
    if (!arena->active ||
        turn.domain != arena->domain ||
        turn.epoch != arena->epoch ||
        ores_rt_carrier_arena != arena ||
        ores_rt_carrier_epoch != turn.epoch) {
        return ORES_RT_ARENA_STALE;
    }
    return ORES_RT_ARENA_OK;
}

static OresRtArenaStatus require_handle(
    OresRealtimeActorArena* arena,
    OresRtArenaHandle handle,
    OresRealtimeArenaSlot** out_slot) {
    if (!arena || !out_slot) return ORES_RT_ARENA_INVALID;
    if (handle.domain != arena->domain || handle.index >= arena->slot_count)
        return ORES_RT_ARENA_STALE;
    OresRealtimeArenaSlot* slot = &arena->slots[(size_t)handle.index];
    if (!slot->live || slot->generation != handle.generation)
        return ORES_RT_ARENA_STALE;
    *out_slot = slot;
    return ORES_RT_ARENA_OK;
}

static int span_ok(size_t length, size_t offset, size_t bytes) {
    return offset <= length && bytes <= length - offset;
}

OresRtArenaStatus ores_rt_actor_arena_init(
    OresRealtimeActorArena* arena,
    void* backing,
    size_t backing_bytes,
    uint64_t domain,
    uint64_t owner,
    uint64_t incarnation,
    size_t slot_count,
    size_t slot_bytes,
    size_t scratch_bytes) {
    if (!arena || !backing || domain == 0 || owner == 0 || incarnation == 0)
        return ORES_RT_ARENA_INVALID;

    const size_t alignment = _Alignof(max_align_t);
    if (((uintptr_t)backing & (uintptr_t)(alignment - 1)) != 0)
        return ORES_RT_ARENA_ALIGNMENT;

    const uintptr_t backing_start = (uintptr_t)backing;
    if (backing_bytes > UINTPTR_MAX - backing_start)
        return ORES_RT_ARENA_INVALID;
    const uintptr_t backing_end = backing_start + backing_bytes;
    const uintptr_t control_start = (uintptr_t)arena;
    if (sizeof(*arena) > UINTPTR_MAX - control_start)
        return ORES_RT_ARENA_INVALID;
    const uintptr_t control_end = control_start + sizeof(*arena);
    if (control_start < backing_end && backing_start < control_end)
        return ORES_RT_ARENA_INVALID;

    const size_t required =
        ores_rt_actor_arena_required_bytes(slot_count, slot_bytes, scratch_bytes);
    if (required == 0 || backing_bytes < required)
        return ORES_RT_ARENA_CAPACITY;

    memset(arena, 0, sizeof(*arena));
    memset(backing, 0, required);

    arena->domain = domain;
    arena->owner = owner;
    arena->incarnation = incarnation;
    arena->slot_count = slot_count;
    arena->slot_bytes = slot_bytes;
    arena->scratch_bytes = scratch_bytes;
    arena->arena_bytes = required;
    arena->backing = (unsigned char*)backing;

    size_t offset = 0;
    size_t bytes = 0;

    (void)align_up(offset, alignment, &offset);
    arena->slots = (OresRealtimeArenaSlot*)(arena->backing + offset);
    (void)checked_mul(slot_count, sizeof(OresRealtimeArenaSlot), &bytes);
    offset += bytes;

    (void)align_up(offset, alignment, &offset);
    arena->free_slots = (size_t*)(arena->backing + offset);
    (void)checked_mul(slot_count, sizeof(size_t), &bytes);
    offset += bytes;

    (void)align_up(offset, alignment, &offset);
    arena->slab = arena->backing + offset;
    (void)checked_mul(slot_count, slot_bytes, &bytes);
    offset += bytes;

    (void)align_up(offset, alignment, &offset);
    arena->scratch = arena->backing + offset;

    arena->free_count = slot_count;
    for (size_t i = 0; i < slot_count; ++i) {
        arena->slots[i].generation = 1;
        arena->free_slots[i] = slot_count - 1 - i;
    }

    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_seal(
    OresRealtimeActorArena* arena,
    size_t page_bytes) {
    if (!arena || !arena->backing || arena->arena_bytes == 0)
        return ORES_RT_ARENA_INVALID;
    if (arena->retired) return ORES_RT_ARENA_RETIRED;
    if (arena->active) return ORES_RT_ARENA_BUSY;
    if (arena->sealed) return ORES_RT_ARENA_OK;
    if (page_bytes == 0 || (page_bytes & (page_bytes - 1)) != 0)
        return ORES_RT_ARENA_INVALID;

    volatile unsigned char* bytes = arena->backing;
    for (size_t i = 0; i < arena->arena_bytes; i += page_bytes) {
        const unsigned char value = bytes[i];
        bytes[i] = value;
    }
    const size_t last = arena->arena_bytes - 1;
    const unsigned char value = bytes[last];
    bytes[last] = value;
    arena->sealed = 1;
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_enter(
    OresRealtimeActorArena* arena,
    uint64_t owner,
    uint64_t incarnation,
    OresRtArenaTurn* out_turn) {
    if (!arena || !out_turn) return ORES_RT_ARENA_INVALID;
    if (arena->retired) return ORES_RT_ARENA_RETIRED;
    if (!arena->sealed) return ORES_RT_ARENA_NOT_SEALED;
    if (arena->active || ores_rt_carrier_arena != NULL)
        return ORES_RT_ARENA_BUSY;
    if (owner != arena->owner || incarnation != arena->incarnation)
        return ORES_RT_ARENA_WRONG_OWNER;
    if (arena->epoch == UINT64_MAX)
        return ORES_RT_ARENA_GENERATION_EXHAUSTED;

    ++arena->epoch;
    arena->active = 1;
    ores_rt_carrier_arena = arena;
    ores_rt_carrier_epoch = arena->epoch;
    out_turn->domain = arena->domain;
    out_turn->epoch = arena->epoch;
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_leave(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn) {
    OresRtArenaStatus status = require_turn(arena, turn);
    if (status != ORES_RT_ARENA_OK) return status;

    memset(arena->scratch, 0, arena->scratch_top);
    arena->scratch_top = 0;
    arena->active = 0;
    ores_rt_carrier_arena = NULL;
    ores_rt_carrier_epoch = 0;
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_alloc(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    size_t bytes,
    OresRtArenaHandle* out_handle) {
    OresRtArenaStatus status = require_turn(arena, turn);
    if (status != ORES_RT_ARENA_OK) return status;
    if (!out_handle || bytes == 0 || bytes > arena->slot_bytes)
        return ORES_RT_ARENA_INVALID;
    if (arena->free_count == 0)
        return ORES_RT_ARENA_CAPACITY;

    const size_t index = arena->free_slots[--arena->free_count];
    if (index >= arena->slot_count)
        return ORES_RT_ARENA_INVALID;
    OresRealtimeArenaSlot* slot = &arena->slots[index];
    if (slot->live)
        return ORES_RT_ARENA_INVALID;
    if (slot->generation == UINT64_MAX)
        return ORES_RT_ARENA_GENERATION_EXHAUSTED;

    slot->live = 1;
    slot->length = bytes;
    out_handle->domain = arena->domain;
    out_handle->index = (uint64_t)index;
    out_handle->generation = slot->generation;
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_read(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaHandle handle,
    size_t offset,
    void* out,
    size_t bytes) {
    OresRtArenaStatus status = require_turn(arena, turn);
    if (status != ORES_RT_ARENA_OK) return status;
    OresRealtimeArenaSlot* slot = NULL;
    status = require_handle(arena, handle, &slot);
    if (status != ORES_RT_ARENA_OK) return status;
    if (!span_ok(slot->length, offset, bytes) || (bytes != 0 && !out))
        return ORES_RT_ARENA_INVALID;
    if (bytes != 0) {
        memcpy(out,
               arena->slab + (size_t)handle.index * arena->slot_bytes + offset,
               bytes);
    }
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_write(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaHandle handle,
    size_t offset,
    const void* src,
    size_t bytes) {
    OresRtArenaStatus status = require_turn(arena, turn);
    if (status != ORES_RT_ARENA_OK) return status;
    OresRealtimeArenaSlot* slot = NULL;
    status = require_handle(arena, handle, &slot);
    if (status != ORES_RT_ARENA_OK) return status;
    if (!span_ok(slot->length, offset, bytes) || (bytes != 0 && !src))
        return ORES_RT_ARENA_INVALID;
    if (bytes != 0) {
        memcpy(arena->slab + (size_t)handle.index * arena->slot_bytes + offset,
               src,
               bytes);
    }
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_drop(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaHandle handle) {
    OresRtArenaStatus status = require_turn(arena, turn);
    if (status != ORES_RT_ARENA_OK) return status;
    OresRealtimeArenaSlot* slot = NULL;
    status = require_handle(arena, handle, &slot);
    if (status != ORES_RT_ARENA_OK) return status;
    if (slot->generation == UINT64_MAX)
        return ORES_RT_ARENA_GENERATION_EXHAUSTED;
    if (arena->free_count >= arena->slot_count)
        return ORES_RT_ARENA_INVALID;

    memset(arena->slab + (size_t)handle.index * arena->slot_bytes,
           0,
           arena->slot_bytes);
    slot->live = 0;
    slot->length = 0;
    ++slot->generation;
    arena->free_slots[arena->free_count++] = (size_t)handle.index;
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_scratch_alloc(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    size_t bytes,
    size_t alignment,
    OresRtArenaScratch* out_scratch) {
    OresRtArenaStatus status = require_turn(arena, turn);
    if (status != ORES_RT_ARENA_OK) return status;
    if (!out_scratch || bytes == 0 || alignment == 0 ||
        (alignment & (alignment - 1)) != 0 ||
        alignment > _Alignof(max_align_t)) {
        return ORES_RT_ARENA_INVALID;
    }

    size_t at = 0;
    if (!align_up(arena->scratch_top, alignment, &at))
        return ORES_RT_ARENA_CAPACITY;
    if (at > arena->scratch_bytes || bytes > arena->scratch_bytes - at)
        return ORES_RT_ARENA_CAPACITY;

    arena->scratch_top = at + bytes;
    out_scratch->domain = arena->domain;
    out_scratch->epoch = turn.epoch;
    out_scratch->offset = (uint64_t)at;
    out_scratch->length = (uint64_t)bytes;
    return ORES_RT_ARENA_OK;
}

static OresRtArenaStatus require_scratch(
    OresRealtimeActorArena* arena,
    OresRtArenaScratch scratch,
    size_t offset,
    size_t bytes) {
    if (!arena) return ORES_RT_ARENA_INVALID;
    if (scratch.domain != arena->domain ||
        scratch.epoch != arena->epoch ||
        scratch.offset > arena->scratch_top ||
        scratch.length > arena->scratch_top - (size_t)scratch.offset) {
        return ORES_RT_ARENA_STALE;
    }
    if (!span_ok((size_t)scratch.length, offset, bytes))
        return ORES_RT_ARENA_INVALID;
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_scratch_read(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaScratch scratch,
    size_t offset,
    void* out,
    size_t bytes) {
    OresRtArenaStatus status = require_turn(arena, turn);
    if (status != ORES_RT_ARENA_OK) return status;
    status = require_scratch(arena, scratch, offset, bytes);
    if (status != ORES_RT_ARENA_OK) return status;
    if (bytes != 0 && !out) return ORES_RT_ARENA_INVALID;
    if (bytes != 0)
        memcpy(out, arena->scratch + (size_t)scratch.offset + offset, bytes);
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_scratch_write(
    OresRealtimeActorArena* arena,
    OresRtArenaTurn turn,
    OresRtArenaScratch scratch,
    size_t offset,
    const void* src,
    size_t bytes) {
    OresRtArenaStatus status = require_turn(arena, turn);
    if (status != ORES_RT_ARENA_OK) return status;
    status = require_scratch(arena, scratch, offset, bytes);
    if (status != ORES_RT_ARENA_OK) return status;
    if (bytes != 0 && !src) return ORES_RT_ARENA_INVALID;
    if (bytes != 0)
        memcpy(arena->scratch + (size_t)scratch.offset + offset, src, bytes);
    return ORES_RT_ARENA_OK;
}

OresRtArenaStatus ores_rt_actor_arena_retire(
    OresRealtimeActorArena* arena) {
    if (!arena || !arena->backing) return ORES_RT_ARENA_INVALID;
    if (arena->retired) return ORES_RT_ARENA_RETIRED;
    if (arena->active || ores_rt_carrier_arena == arena)
        return ORES_RT_ARENA_BUSY;

    memset(arena->backing, 0, arena->arena_bytes);
    arena->retired = 1;
    arena->sealed = 0;
    arena->free_count = 0;
    arena->scratch_top = 0;
    return ORES_RT_ARENA_OK;
}
