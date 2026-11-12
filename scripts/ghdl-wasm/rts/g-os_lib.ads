-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
with System;

package GNAT.OS_Lib is
   type File_Descriptor is new Integer;
   Invalid_FD : constant File_Descriptor := -1;

   type OS_Time is new Long_Long_Integer;
   Invalid_Time : constant OS_Time := OS_Time'First;

   type Mode_Type is (Text, Binary);

   type String_Access is access all String;
   type Argument_List is array (Integer range <>) of String_Access;

   Directory_Separator : constant Character := '/';
   Path_Separator : constant Character := ':';

   function Is_Absolute_Path (Name : String) return Boolean;
   function Is_Regular_File (Name : String) return Boolean;
   function Is_Executable_File (Name : String) return Boolean;
   function Is_Executable_File (Name : System.Address) return Boolean;
   function Is_Directory (Name : String) return Boolean;

   procedure Delete_File (Name : String; Success : out Boolean);
   procedure Rename_File
     (Old_Name : String;
      New_Name : String;
      Success  : out Boolean);

   function File_Time_Stamp (Name : String) return OS_Time;
   function Open_Read
     (Name : System.Address;
      Mode : Mode_Type) return File_Descriptor;
   function Create_File
     (Name : System.Address;
      Mode : Mode_Type) return File_Descriptor;
   procedure Close (Fd : File_Descriptor);
   function File_Length (Fd : File_Descriptor) return Long_Integer;
   function Read
     (Fd     : File_Descriptor;
      Buffer : System.Address;
      Length : Natural) return Integer;
   function Write
     (Fd     : File_Descriptor;
      Buffer : System.Address;
      Length : Natural) return Integer;
   function Spawn (Command : String; Args : Argument_List) return Integer;
   function Locate_Exec_On_Path (Command : String) return String_Access;
   procedure Free (Name : in out String_Access);
end GNAT.OS_Lib;
