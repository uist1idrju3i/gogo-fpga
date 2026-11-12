-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
with Grt.Stdio;

package body Simple_IO is
   procedure Put_To (S : String; Stream : Grt.Stdio.FILEs) is
      Result : Integer;
   begin
      for C of S loop
         Result := Grt.Stdio.fputc (Integer (Character'Pos (C)), Stream);
      end loop;
      Grt.Stdio.fflush (Stream);
   end Put_To;

   procedure Put (S : String) is
   begin
      Put_To (S, Grt.Stdio.stdout);
   end Put;

   procedure Put (C : Character) is
   begin
      Put (String'(1 => C));
   end Put;

   procedure Put_Line (S : String) is
   begin
      Put (S & ASCII.LF);
   end Put_Line;

   procedure New_Line is
   begin
      Put (ASCII.LF);
   end New_Line;

   procedure Put_Err (S : String) is
   begin
      Put_To (S, Grt.Stdio.stderr);
   end Put_Err;

   procedure Put_Err (C : Character) is
   begin
      Put_Err (String'(1 => C));
   end Put_Err;

   procedure Put_Line_Err (S : String) is
   begin
      Put_Err (S & ASCII.LF);
   end Put_Line_Err;

   procedure New_Line_Err is
   begin
      Put_Err (ASCII.LF);
   end New_Line_Err;
end Simple_IO;
