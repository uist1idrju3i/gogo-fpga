-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
library olo;
use olo.olo_base_pkg_logic.all;

entity top is
  port (clk : in std_logic; led : out std_logic);
end entity;

architecture rtl of top is
  signal value : unsigned(7 downto 0) := (others => '0');
  signal delayed : std_logic_vector(7 downto 0) := (others => '0');
  signal gray, decoded : std_logic_vector(7 downto 0);
begin
  gray <= binaryToGray(std_logic_vector(value));
  decoded <= grayToBinary(delayed);
  process (clk) is
  begin
    if rising_edge(clk) then
      value <= value + 1;
      delayed <= gray;
    end if;
  end process;
  led <= gray(0) xor decoded(1);
end architecture;
