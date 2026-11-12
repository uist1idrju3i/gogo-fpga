-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
package Interfaces.C is
   pragma Pure;
   pragma Elaborate_Body;

   subtype int is Integer;
   subtype long is Long_Integer;
   subtype long_long is Long_Long_Integer;

   type unsigned is mod 2 ** Integer'Size;
   type unsigned_long_long is mod 2 ** 64;
   type size_t is mod 2 ** Standard'Address_Size;
   type ssize_t is range
     -(2 ** (Standard'Address_Size - 1)) ..
     (2 ** (Standard'Address_Size - 1)) - 1;
end Interfaces.C;
