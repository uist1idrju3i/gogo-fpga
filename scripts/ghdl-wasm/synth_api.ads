-- Adapted from synth-explorer/tools/ghdl-wasm/synth_api.ads.
-- Copyright 2025 synth-explorer contributors.
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- https://www.apache.org/licenses/LICENSE-2.0
-- SPDX-License-Identifier: Apache-2.0
-- Modified by gogo-fpga/toolchain to select the VHDL standard at runtime.
--  Minimal exported entry points to drive GHDL's synthesis kernel from a
--  WebAssembly host, bypassing the native command-line driver.
with Types; use Types;

package Synth_Api is
   function Synth_Set_Std (Std : Integer) return Integer;

   --  Initialize analysis, load the bundled standard libraries, and
   --  configure diagnostics. 0 = success.
   function Synth_Init return Integer;

   function Synth_Set_Formal (Enable : Integer; Psl : Integer) return Integer;

   function Synth_Set_Library
     (Name : Thin_String_Ptr; Len : Natural) return Integer;

   --  Analyze FILE into the work library. The caller must provide files in
   --  dependency order (packages before units that use them).
   --  0 = success; negative values identify an analysis failure.
   function Analyze_File
     (File : Thin_String_Ptr; Len : Natural) return Integer;

   --  Configure, elaborate, and synthesize entity NAME (lowercase), then
   --  write a Verilog netlist through the host's stdio imports.
   --  0 = success; negative values identify the failing stage.
   function Synth_Top (Name : Thin_String_Ptr; Len : Natural) return Integer;
end Synth_Api;
