-- Copyright (c) 2026, Y.Yamashiro
-- SPDX-License-Identifier: BSD-3-Clause
package Ada.Calendar.Time_Zones is
   type Time_Offset is range -(28 * 60) .. 28 * 60;

   function UTC_Time_Offset (Date : Time := Clock) return Time_Offset;
end Ada.Calendar.Time_Zones;
