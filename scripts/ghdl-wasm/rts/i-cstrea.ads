-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
with Interfaces.C;
with System;

package Interfaces.C_Streams is
   pragma Preelaborate;
   pragma Elaborate_Body;

   subtype FILEs is System.Address;
   subtype int is Interfaces.C.int;
   subtype size_t is Interfaces.C.size_t;

   NULL_Stream : constant FILEs;

   function fopen (Path : System.Address; Mode : System.Address) return FILEs;
   function fwrite
     (Buffer : System.Address;
      Size   : size_t;
      Count  : size_t;
      Stream : FILEs) return size_t;
   function fclose (Stream : FILEs) return int;

private
   NULL_Stream : constant FILEs := System'To_Address (0);

   pragma Import (C, fopen);
   pragma Import (C, fwrite);
   pragma Import (C, fclose);
end Interfaces.C_Streams;
