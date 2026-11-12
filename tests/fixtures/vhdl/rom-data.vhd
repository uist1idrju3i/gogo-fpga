-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.textio.all;

entity rom_data is
  port (address : in integer range 0 to 1; value : out std_logic_vector(3 downto 0));
end entity;

architecture rtl of rom_data is
  type rom_t is array (0 to 1) of std_logic_vector(3 downto 0);
  impure function read_rom return rom_t is
    file source : text open read_mode is "rom-data.hex";
    variable row : line;
    variable number : integer;
    variable result : rom_t;
  begin
    for index in result'range loop
      readline(source, row);
      read(row, number);
      result(index) := std_logic_vector(to_unsigned(number, 4));
    end loop;
    return result;
  end function;
  constant rom : rom_t := read_rom;
begin
  value <= rom(address);
end architecture;
