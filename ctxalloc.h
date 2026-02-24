/*
 * Copyright (C) 2025 adnihilum authors
 *
 * This file is part of adnihilum.
 *
 * adnihilum is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * adnihilum is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with adnihilum.  If not, see <https://www.gnu.org/licenses/>.
 */
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * zeroed-on-allocation freelist pool allocator for request contexts
 */

#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/*
 * ====================================================================== 
 */

typedef uint32_t ctxalloc_size_t;
typedef union ctxalloc_block_t ctxalloc_block_t;
typedef struct ctxalloc_t ctxalloc_t;

static inline ctxalloc_size_t ctxa_footprint(ctxalloc_size_t count);
static inline ctxalloc_t *ctxa_init(void *memory, ctxalloc_size_t count);
static inline req_ctx_t *ctxa_alloc(ctxalloc_t *alloc);
static inline void ctxa_free(ctxalloc_t *alloc, void *ptr);

/*
 * ====================================================================== 
 */

union ctxalloc_block_t {
	ctxalloc_block_t *next;
	req_ctx_t req_ctx;
};

struct ctxalloc_t {
	ctxalloc_block_t *free_list;
	ctxalloc_size_t capacity;
	ctxalloc_size_t available;
};

static inline ctxalloc_size_t ctxa_footprint(ctxalloc_size_t count)
{
	return count * sizeof(ctxalloc_block_t) + sizeof(ctxalloc_t);
}

static inline ctxalloc_t *ctxa_init(void *memory, ctxalloc_size_t count)
{
	ctxalloc_size_t footprint = ctxa_footprint(count);
	ctxalloc_t *alloc =
		(ctxalloc_t *)(memory + footprint - sizeof(ctxalloc_t));

	alloc->capacity = count;
	alloc->available = count;
	alloc->free_list = NULL;

	ctxalloc_block_t *pool = memory;
	alloc->free_list = pool;
	for (ctxalloc_size_t i = 0; i < count - 1; ++i) {
		pool[i].next = &pool[i + 1];
	}
	pool[count - 1].next = NULL;

	return alloc;
}

static inline req_ctx_t *ctxa_alloc(ctxalloc_t *alloc)
{
	ctxalloc_block_t *block = alloc->free_list;
	if (!block) {
		return NULL;
	}

	alloc->free_list = block->next;
	alloc->available -= 1;
	memset(block, 0, sizeof(*block));
	return &(block->req_ctx);
}

static inline void ctxa_free(ctxalloc_t *alloc, void *ptr)
{
	ctxalloc_block_t *block = (ctxalloc_block_t *)ptr;
	block->next = alloc->free_list;
	alloc->free_list = block;
	alloc->available += 1;
}
