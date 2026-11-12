#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#include <linux/xz.h>

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

  xz_crc32_init();
  xz_crc64_init();
  struct xz_dec *decoder = xz_dec_init(XZ_SINGLE, 0);
  if (decoder == NULL) {
    return -2;
  }

  struct xz_buf buffer = {
      .in = src,
      .in_pos = 0,
      .in_size = src_len,
      .out = dst,
      .out_pos = 0,
      .out_size = dst_len,
  };
  enum xz_ret result = xz_dec_run(decoder, &buffer);
  size_t written = buffer.out_pos;
  bool consumed_all = buffer.in_pos == src_len;
  xz_dec_end(decoder);

  if (result != XZ_STREAM_END || !consumed_all || written > dst_len) {
    return -3;
  }

  return (long long)written;
}
