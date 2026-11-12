-- Adapted from synth-explorer/tools/ghdl-wasm/bug.adb.
-- Copyright 2025 synth-explorer contributors.
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- https://www.apache.org/licenses/LICENSE-2.0
-- SPDX-License-Identifier: Apache-2.0
--  wasm32 stub: crash-report box without Ada.Exceptions introspection,
--  which the AdaWebPack runtime does not provide.
with Simple_IO; use Simple_IO;

package body Bug is
   procedure Disp_Bug_Box (Except : Exception_Occurrence)
   is
      pragma Unreferenced (Except);
   begin
      Put_Line_Err ("******************** GHDL Bug occurred ****************");
   end Disp_Bug_Box;

   function Get_Gnat_Version return String is
   begin
      return "unknown (wasm32)";
   end Get_Gnat_Version;
end Bug;
