-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
with Ghdl_Wasm_Epoch;

package body Ada.Calendar is
   Seconds_Per_Day : constant Long_Long_Integer := 86_400;

   function Is_Leap_Year (Value : Integer) return Boolean is
     (Value mod 4 = 0 and then
      (Value mod 100 /= 0 or else Value mod 400 = 0));

   function Days_In_Year (Value : Integer) return Integer is
     (if Is_Leap_Year (Value) then 366 else 365);

   function Days_In_Month (Year : Integer; Month : Integer) return Integer is
   begin
      case Month is
         when 2 =>
            return (if Is_Leap_Year (Year) then 29 else 28);
         when 4 | 6 | 9 | 11 =>
            return 30;
         when others =>
            return 31;
      end case;
   end Days_In_Month;

   function Clock return Time is
     (Time (Ghdl_Wasm_Epoch.Source_Date_Epoch));

   function "-" (Left : Time; Right : Duration) return Time is
   begin
      return Time (Long_Long_Integer (Left) - Long_Long_Integer (Right));
   end "-";

   procedure Split
     (Date    : Time;
      Year    : out Year_Number;
      Month   : out Month_Number;
      Day     : out Day_Number;
      Seconds : out Day_Duration)
   is
      Whole_Days : Long_Long_Integer :=
        Long_Long_Integer (Date) / Seconds_Per_Day;
      Remainder : Long_Long_Integer :=
        Long_Long_Integer (Date) rem Seconds_Per_Day;
      Year_Value : Integer := 1970;
      Month_Value : Integer := 1;
   begin
      if Remainder < 0 then
         Whole_Days := Whole_Days - 1;
         Remainder := Remainder + Seconds_Per_Day;
      end if;

      if Whole_Days >= 0 then
         while Whole_Days >= Long_Long_Integer (Days_In_Year (Year_Value))
           and then Year_Value < Year_Number'Last
         loop
            Whole_Days := Whole_Days - Long_Long_Integer
              (Days_In_Year (Year_Value));
            Year_Value := Year_Value + 1;
         end loop;
      else
         while Whole_Days < 0 and then Year_Value > Year_Number'First loop
            Year_Value := Year_Value - 1;
            Whole_Days := Whole_Days + Long_Long_Integer
              (Days_In_Year (Year_Value));
         end loop;
      end if;

      if Year_Value < Year_Number'First then
         Year_Value := Year_Number'First;
         Whole_Days := 0;
      elsif Year_Value > Year_Number'Last then
         Year_Value := Year_Number'Last;
         Whole_Days := Long_Long_Integer (Days_In_Year (Year_Value) - 1);
      end if;

      while Whole_Days >= Long_Long_Integer
        (Days_In_Month (Year_Value, Month_Value))
      loop
         Whole_Days := Whole_Days - Long_Long_Integer
           (Days_In_Month (Year_Value, Month_Value));
         Month_Value := Month_Value + 1;
      end loop;

      Year := Year_Number (Year_Value);
      Month := Month_Number (Month_Value);
      Day := Day_Number (Integer (Whole_Days) + 1);
      Seconds := Day_Duration (Remainder);
   end Split;
end Ada.Calendar;
