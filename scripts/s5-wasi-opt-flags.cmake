if(NOT DEFINED WASI_OPT_FLAGS OR WASI_OPT_FLAGS STREQUAL "")
  return()
endif()

get_property(s5_wasi_opt_flags_applied GLOBAL PROPERTY S5_WASI_OPT_FLAGS_APPLIED)
if(s5_wasi_opt_flags_applied)
  return()
endif()
set_property(GLOBAL PROPERTY S5_WASI_OPT_FLAGS_APPLIED TRUE)

separate_arguments(s5_wasi_opt_flags NATIVE_COMMAND "${WASI_OPT_FLAGS}")
if(s5_wasi_opt_flags)
  add_compile_options(${s5_wasi_opt_flags})
endif()
