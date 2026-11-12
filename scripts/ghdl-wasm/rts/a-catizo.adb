-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
package body Ada.Calendar.Time_Zones is
   function UTC_Time_Offset (Date : Time := Clock) return Time_Offset is
      pragma Unreferenced (Date);
   begin
      return 0;
   end UTC_Time_Offset;
end Ada.Calendar.Time_Zones;
