-- Copyright (c) 2026, 午後のFPGA
-- SPDX-License-Identifier: GPL-2.0-or-later
with Interfaces.C;
with System;
with Ada.Unchecked_Deallocation;

package body GNAT.OS_Lib is
   package C renames Interfaces.C;
   use type C.unsigned;
   use type C.ssize_t;

   function C_Open_Read (Name : System.Address) return C.int;
   pragma Import (C, C_Open_Read, "__ghdl_open_read");

   function C_Create_File (Name : System.Address) return C.int;
   pragma Import (C, C_Create_File, "__ghdl_create_file");

   function C_Close (Fd : C.int) return C.int;
   pragma Import (C, C_Close, "close");

   function C_Read_All
     (Fd : C.int;
      Buffer : System.Address;
      Length : C.size_t) return C.long_long;
   pragma Import (C, C_Read_All, "__ghdl_read_all");

   function C_Write
     (Fd : C.int;
      Buffer : System.Address;
      Length : C.size_t) return C.ssize_t;
   pragma Import (C, C_Write, "write");

   function C_Is_Regular_File (Name : System.Address) return C.int;
   pragma Import (C, C_Is_Regular_File, "__ghdl_is_regular_file");

   function C_Is_Directory (Name : System.Address) return C.int;
   pragma Import (C, C_Is_Directory, "__ghdl_is_directory");

   function C_File_Mtime
     (Name : System.Address;
      Mtime : access C.long_long) return C.int;
   pragma Import (C, C_File_Mtime, "__ghdl_file_mtime");

   function C_File_Length
     (Fd : C.int;
      Length : access C.long_long) return C.int;
   pragma Import (C, C_File_Length, "__ghdl_file_length");

   function C_Unlink (Name : System.Address) return C.int;
   pragma Import (C, C_Unlink, "unlink");

   function C_Rename
     (Old_Name : System.Address;
      New_Name : System.Address) return C.int;
   pragma Import (C, C_Rename, "rename");

   procedure Free_String is new Ada.Unchecked_Deallocation
     (String, String_Access);

   function Is_Absolute_Path (Name : String) return Boolean is
     (Name'Length > 0 and then Name (Name'First) = '/');

   function Is_Regular_File (Name : String) return Boolean is
      Nul_Name : constant String := Name & ASCII.NUL;
   begin
      return C_Is_Regular_File (Nul_Name'Address) /= 0;
   end Is_Regular_File;

   function Is_Executable_File (Name : String) return Boolean is
      pragma Unreferenced (Name);
   begin
      return False;
   end Is_Executable_File;

   function Is_Executable_File (Name : System.Address) return Boolean is
      pragma Unreferenced (Name);
   begin
      return False;
   end Is_Executable_File;

   function Is_Directory (Name : String) return Boolean is
      Nul_Name : constant String := Name & ASCII.NUL;
   begin
      return C_Is_Directory (Nul_Name'Address) /= 0;
   end Is_Directory;

   procedure Delete_File (Name : String; Success : out Boolean) is
      Nul_Name : constant String := Name & ASCII.NUL;
   begin
      Success := C_Unlink (Nul_Name'Address) = 0;
   end Delete_File;

   procedure Rename_File
     (Old_Name : String;
      New_Name : String;
      Success  : out Boolean)
   is
      Nul_Old_Name : constant String := Old_Name & ASCII.NUL;
      Nul_New_Name : constant String := New_Name & ASCII.NUL;
   begin
      Success := C_Rename
        (Nul_Old_Name'Address, Nul_New_Name'Address) = 0;
   end Rename_File;

   function File_Time_Stamp (Name : String) return OS_Time is
      Mtime : aliased C.long_long;
      Nul_Name : constant String := Name & ASCII.NUL;
   begin
      if C_File_Mtime (Nul_Name'Address, Mtime'Access) /= 0 then
         return Invalid_Time;
      end if;
      return OS_Time (Mtime);
   end File_Time_Stamp;

   function Open_Read
     (Name : System.Address;
      Mode : Mode_Type) return File_Descriptor
   is
      pragma Unreferenced (Mode);
   begin
      return File_Descriptor (C_Open_Read (Name));
   end Open_Read;

   function Create_File
     (Name : System.Address;
      Mode : Mode_Type) return File_Descriptor
   is
      pragma Unreferenced (Mode);
   begin
      return File_Descriptor (C_Create_File (Name));
   end Create_File;

   procedure Close (Fd : File_Descriptor) is
      Result : C.int;
      pragma Unreferenced (Result);
   begin
      Result := C_Close (C.int (Fd));
   end Close;

   function File_Length (Fd : File_Descriptor) return Long_Integer is
      Length : aliased C.long_long;
   begin
      if C_File_Length (C.int (Fd), Length'Access) /= 0 then
         return -1;
      end if;
      return Long_Integer (Length);
   end File_Length;

   function Read
     (Fd     : File_Descriptor;
      Buffer : System.Address;
      Length : Natural) return Integer
   is
      Result : constant C.long_long :=
        C_Read_All (C.int (Fd), Buffer, C.size_t (Length));
   begin
      return (if Result < 0 then -1 else Integer (Result));
   end Read;

   function Write
     (Fd     : File_Descriptor;
      Buffer : System.Address;
      Length : Natural) return Integer
   is
      Result : constant C.ssize_t :=
        C_Write (C.int (Fd), Buffer, C.size_t (Length));
   begin
      if Result < 0 then
         return -1;
      end if;
      return Integer (Result);
   end Write;

   function Spawn (Command : String; Args : Argument_List) return Integer is
      pragma Unreferenced (Command, Args);
   begin
      return -1;
   end Spawn;

   function Locate_Exec_On_Path (Command : String) return String_Access is
      pragma Unreferenced (Command);
   begin
      return null;
   end Locate_Exec_On_Path;

   procedure Free (Name : in out String_Access) is
   begin
      if Name /= null then
         Free_String (Name);
      end if;
   end Free;
end GNAT.OS_Lib;
