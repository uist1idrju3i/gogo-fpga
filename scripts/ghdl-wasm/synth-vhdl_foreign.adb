--  This file is part of GHDL.
--
--  This program is free software: you can redistribute it and/or modify
--  it under the terms of the GNU General Public License as published by
--  the Free Software Foundation, either version 2, or (at your option)
--  any later version.
--
--  This program is distributed in the hope that it will be useful,
--  but WITHOUT ANY WARRANTY; without even the implied warranty of
--  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
--  GNU General Public License for more details.
--
--  You should have received a copy of the GNU General Public License
--  along with this program.  If not, see <gnu.org/licenses>.

with Synth.Errors; use Synth.Errors;

package body Synth.Vhdl_Foreign is
   function Call_Subprogram (Syn_Inst : Synth_Instance_Acc;
                             Sub_Inst : Synth_Instance_Acc;
                             Imp      : Node;
                             Loc      : Node) return Valtyp
   is
      pragma Unreferenced (Sub_Inst, Imp);
   begin
      Error_Msg_Synth
        (Syn_Inst, Loc,
         "foreign subprogram calls are not supported in WASM synthesis");
      return No_Valtyp;
   end Call_Subprogram;

   procedure Initialize is
   begin
      null;
   end Initialize;
end Synth.Vhdl_Foreign;
