#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#if defined(PROBE_BTOR2_IDS)
#include "btor2parser.h"

int main(int argc, char **argv) {
  if (argc > 2 || (argc == 2 && strcmp(argv[1], "--alias-only"))) return 24;
  Btor2Parser *parser = btor2parser_new();
  if (!btor2parser_read_lines(parser, stdin)) {
    fprintf(stderr, "%s\n", btor2parser_error(parser));
    btor2parser_delete(parser);
    return 22;
  }
  const int64_t ids[] = {0, 1, -1, 2, -2, INT32_MAX, INT64_C(2147483648),
    -INT64_C(2147483648), INT64_C(4294967295), -INT64_C(4294967295),
    INT64_C(4294967297), -INT64_C(4294967297), INT64_MAX, -INT64_MAX};
  int failed = 0;
  for (size_t i = 0; i < sizeof(ids) / sizeof(ids[0]); ++i) {
    const int64_t id = ids[i];
    if (argc == 2 && (id == INT64_C(2147483648) || id == -INT64_C(2147483648))) continue;
    const int64_t expected = id == 1 || id == -1 ? 1 : id == 2 || id == -2 ? 2 : 0;
    Btor2Line *line = btor2parser_get_line_by_id(parser, id);
    const int64_t actual = line ? line->id : 0;
    printf("id=%" PRId64 " found=%" PRId64 "\n", id, actual);
    if (actual != expected) failed = 1;
  }
  btor2parser_delete(parser);
  return failed ? 23 : 0;
}
#elif defined(PROBE_BOOLECTOR_TRACE)
#include "boolector.h"
#include "btortrapi.h"

int main(int argc, char **argv) {
  if (argc != 3 || (strcmp(argv[1], "plain") && strcmp(argv[1], "gzip"))) return 24;
  Btor *btor = boolector_new();
  puts("trace-requested");
  fflush(stdout);
  btor_trapi_open_trace(btor, argv[2]);
  if (!btor->apitrace) {
    fputs("Trace stream was not created\n", stderr);
    boolector_delete(btor);
    return 25;
  }
  fputs("boundary-probe\n", btor->apitrace);
  fflush(btor->apitrace);
  puts("trace-opened");
  boolector_delete(btor);
  return 0;
}
#else
#error Boundary probe mode is required
#endif
