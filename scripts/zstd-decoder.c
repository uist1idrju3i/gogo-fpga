#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#include "zstd.h"

void *dec_alloc(size_t n) {
  return malloc(n == 0 ? 1 : n);
}

void dec_free(void *p) {
  free(p);
}

long long dec_decode(const uint8_t *src, size_t src_len, uint8_t *dst,
                     size_t dst_len) {
  if ((src_len != 0 && src == NULL) || (dst_len != 0 && dst == NULL)) {
    return -1;
  }

  size_t written = ZSTD_decompress(dst, dst_len, src, src_len);
  if (ZSTD_isError(written) || written > dst_len) {
    return -2;
  }

  return (long long)written;
}
