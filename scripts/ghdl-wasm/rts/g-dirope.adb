-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
with Interfaces.C;
with System;

package body GNAT.Directory_Operations is
   use type System.Address;

   function C_Getcwd
     (Buffer : System.Address;
      Size   : Interfaces.C.size_t) return System.Address;
   pragma Import (C, C_Getcwd, "getcwd");

   function Get_Current_Dir return String is
      Buffer : String (1 .. 4096);
      Result : System.Address;
      Last   : Natural := 0;
   begin
      Result := C_Getcwd (Buffer'Address, Interfaces.C.size_t (Buffer'Length));
      if Result = System'To_Address (0) then
         return "";
      end if;

      while Last < Buffer'Last and then Buffer (Last + 1) /= ASCII.NUL loop
         Last := Last + 1;
      end loop;
      if Last = Buffer'Last and then Buffer (Last) /= ASCII.NUL then
         return "";
      end if;
      return Buffer (1 .. Last);
   end Get_Current_Dir;
end GNAT.Directory_Operations;
