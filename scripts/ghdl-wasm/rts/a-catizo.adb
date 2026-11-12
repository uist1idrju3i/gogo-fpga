-- Copyright (c) 2026, Y.Yamashiro
-- SPDX-License-Identifier: BSD-3-Clause
package body Ada.Calendar.Time_Zones is
   function UTC_Time_Offset (Date : Time := Clock) return Time_Offset is
      pragma Unreferenced (Date);
   begin
      return 0;
   end UTC_Time_Offset;
end Ada.Calendar.Time_Zones;
