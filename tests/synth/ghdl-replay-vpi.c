#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vpi_user.h>

enum { MAX_PORTS = 1024, MAX_WIDTH = 4096, MAX_NAME = 1023 };
typedef struct {
  char direction;
  char name[MAX_NAME + 1];
  char bits[MAX_WIDTH + 1];
  vpiHandle handle;
} port_t;

static FILE *input;
static port_t *ports;
static unsigned steps, count, flush, inactive, now, end_time;
static uint64_t ticks_per_ns;
static vpiHandle clock_port;
static s_vpi_time delay;

static void fail(const char *message) {
  vpi_printf("FORMAL_GHDL_ERROR %s\n", message);
  fflush(stdout);
  exit(EXIT_FAILURE);
}

static int binary(const char *bits) {
  return bits[0] != '\0' && strspn(bits, "01") == strlen(bits);
}

static void put(vpiHandle handle, char *bits) {
  s_vpi_value value = {.format = vpiBinStrVal};
  value.value.str = bits;
  vpi_put_value(handle, &value, NULL, vpiNoDelay);
}

static void read_step(unsigned step) {
  char tag[32];
  unsigned number;
  if (fscanf(input, "%31s %u", tag, &number) != 2 || strcmp(tag, "STEP") || number != step)
    fail("invalid step");
  vpi_printf("FORMAL_GHDL_DRIVE %u\n", step);
  for (unsigned i = 0; i < count; i++) {
    char direction, name[MAX_NAME + 1], bits[MAX_WIDTH + 1];
    if (fscanf(input, " %c %1023s %4096s", &direction, name, bits) != 3 ||
        (direction != 'I' && direction != 'O') || !binary(bits))
      fail("invalid port data");
    port_t *port = &ports[i];
    if (step == 1) {
      for (unsigned j = 0; j < i; j++)
        if (!strcmp(ports[j].name, name)) fail("duplicate port");
      port->handle = vpi_handle_by_name(name, NULL);
      if (!port->handle || port->handle == clock_port) fail("missing or invalid port");
      if (vpi_get(vpiDirection, port->handle) != (direction == 'I' ? vpiInput : vpiOutput))
        fail("port direction mismatch");
      if (vpi_get(vpiSize, port->handle) != (PLI_INT32)strlen(bits)) fail("port width mismatch");
      strcpy(port->name, name);
      port->direction = direction;
    } else if (port->direction != direction || strcmp(port->name, name) || strlen(port->bits) != strlen(bits)) {
      fail("inconsistent port data");
    }
    strcpy(port->bits, bits);
    if (direction == 'I') put(port->handle, port->bits);
  }
  if (step == 1) {
    char top_name[MAX_NAME + 1];
    strcpy(top_name, ports[0].name);
    char *separator = strchr(top_name, '.');
    if (!separator || strchr(separator + 1, '.')) fail("invalid top-level port name");
    *separator = '\0';
    size_t prefix = strlen(top_name);
    for (unsigned i = 0; i < count; i++)
      if (strncmp(ports[i].name, top_name, prefix) || ports[i].name[prefix] != '.')
        fail("inconsistent port scope");
    vpiHandle roots = vpi_iterate(vpiModule, NULL);
    vpiHandle top = roots ? vpi_scan(roots) : NULL;
    const char *actual_top_name = top ? vpi_get_str(vpiName, top) : NULL;
    if (!top || vpi_get(vpiType, top) != vpiModule || !actual_top_name || strcmp(actual_top_name, top_name))
      fail("missing top module");
    vpiHandle iterator = vpi_iterate(vpiPort, top);
    unsigned actual_count = 0;
    if (!iterator) fail("missing top-level ports");
    while (vpi_scan(iterator)) actual_count++;
    if (actual_count != count + (clock_port ? 1 : 0)) fail("incomplete top-level port inventory");
  }
}

static void check(unsigned step) {
  for (unsigned i = 0; i < count; i++) {
    port_t *port = &ports[i];
    s_vpi_value value = {.format = vpiBinStrVal};
    vpi_get_value(port->handle, &value);
    if (!value.value.str || strcmp(port->bits, value.value.str)) fail("observed port mismatch or unknown value");
    vpi_printf("FORMAL_GHDL_PORT %u %c %s %s\n", step, port->direction, port->name, value.value.str);
  }
  vpi_printf("FORMAL_GHDL_CHECK %u\n", step);
}

static PLI_INT32 advance(s_cb_data *data) {
  (void)data;
  if (now == 0) {
    if (clock_port) put(clock_port, inactive ? "1" : "0");
    read_step(1);
  }
  if (clock_port && now > 0 && now % 10 == 0) {
    if (now / 10 < steps) vpi_printf("FORMAL_GHDL_EDGE %u\n", now / 10 + 1);
    else if (flush && now / 10 == steps) vpi_printf("FORMAL_GHDL_FLUSH\n");
    else fail("unexpected edge");
    put(clock_port, inactive ? "0" : "1");
  }
  if (now > 1 && now % 10 == 1 && now / 10 < steps) read_step(now / 10 + 1);
  if (now % 10 == 2 && now / 10 < steps) check(now / 10 + 1);
  if (clock_port && now % 10 == 5) put(clock_port, inactive ? "1" : "0");
  if (now == end_time) {
    char extra;
    if (fscanf(input, " %c", &extra) != EOF || ferror(input)) fail("unused or unreadable input");
    if (fclose(input)) fail("failed to close input");
    vpi_printf("FORMAL_GHDL_DONE\n");
    fflush(stdout);
    vpi_control(vpiFinish, 0);
    return 0;
  }
  now++;
  delay = (s_vpi_time){.type = vpiSimTime, .high = (PLI_UINT32)(ticks_per_ns >> 32), .low = (PLI_UINT32)ticks_per_ns};
  s_cb_data callback = {.reason = cbAfterDelay, .cb_rtn = advance, .time = &delay};
  if (!vpi_register_cb(&callback)) fail("failed to register timer");
  return 0;
}

static PLI_INT32 start(s_cb_data *data) {
  input = fopen("formal-ghdl-input.txt", "r");
  if (!input) fail("missing input");
  char tag[32], clock_name[MAX_NAME + 1];
  if (fscanf(input, "%31s %u %u %u %u %1023s", tag, &steps, &count, &flush, &inactive, clock_name) != 6 ||
      strcmp(tag, "FORMAL_GHDL_V1") || steps < 1 || steps > 1024 || count < 1 || count > MAX_PORTS ||
      flush > 1 || inactive > 1 || (flush && !strcmp(clock_name, "-")))
    fail("invalid header");
  if (strcmp(clock_name, "-")) {
    clock_port = vpi_handle_by_name(clock_name, NULL);
    if (!clock_port || vpi_get(vpiSize, clock_port) != 1 || vpi_get(vpiDirection, clock_port) != vpiInput)
      fail("invalid clock");
  }
  ports = calloc(count, sizeof(*ports));
  if (!ports) fail("allocation failed");
  int precision = vpi_get(vpiTimePrecision, NULL);
  if (precision > -9 || precision < -15) fail("unsupported time precision");
  ticks_per_ns = 1;
  for (int p = precision; p < -9; p++) ticks_per_ns *= 10;
  end_time = flush ? 10 * steps + 1 : 10 * (steps - 1) + 3;
  vpi_printf("FORMAL_GHDL_BEGIN %u %u %d\n", steps, count, precision);
  return advance(data);
}

static void register_start(void) {
  s_cb_data callback = {.reason = cbStartOfSimulation, .cb_rtn = start};
  if (!vpi_register_cb(&callback)) fail("failed to register startup");
}

void (*vlog_startup_routines[])(void) = {register_start, NULL};
