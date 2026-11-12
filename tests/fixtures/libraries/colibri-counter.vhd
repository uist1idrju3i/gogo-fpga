-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
library colibri;

entity top is
  port (clk : in std_logic; led : out std_logic);
end entity;

architecture rtl of top is
  signal value : unsigned(3 downto 0);
begin
  counter : entity colibri.counter
    generic map (g_MODULO => 10, g_COUNTER_WIDTH => 4)
    port map (clk_i => clk, reset_i => '0', enable_i => '1',
              value_o => value, wraparound_o => led);
end architecture;
