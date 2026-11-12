-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
package Ada.Calendar is
   type Time is private;

   subtype Year_Number is Integer range 1901 .. 2399;
   subtype Month_Number is Integer range 1 .. 12;
   subtype Day_Number is Integer range 1 .. 31;
   subtype Day_Duration is Duration range 0.0 .. 86_400.0;

   function Clock return Time;
   function "-" (Left : Time; Right : Duration) return Time;
   procedure Split
     (Date    : Time;
      Year    : out Year_Number;
      Month   : out Month_Number;
      Day     : out Day_Number;
      Seconds : out Day_Duration);

private
   type Time is new Long_Long_Integer;
end Ada.Calendar;
