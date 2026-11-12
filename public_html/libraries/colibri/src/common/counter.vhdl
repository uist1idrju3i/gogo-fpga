--! @title Simple Counter
--! @file counter.vhdl
--! @author Alberto Perro (alberto.perro at cern.ch)
--! @date 04-03-2024
--! @version 0.2

--! Some of the work was inspired by the PoC Library (https://github.com/VLSI-EDA/PoC)
--! Release log:

--! - 0.2 Modify g_MODULO behavior to avoid integer limits at 32 bits
--! - 0.1 first release
--!
-- SPDX-FileCopyrightText: 2026 CERN
-- SPDX-License-Identifier: CERN-OHL-W-2.0

library ieee;
  use ieee.std_logic_1164.all;
  use ieee.numeric_std.all;
  use ieee.math_real.all;

library colibri;
  use colibri.utils.all;

entity counter is
  generic (
    g_MODULO        : natural := 0;
    g_COUNTER_WIDTH : natural := log2ceil(g_MODULO)
  );
  port (
    signal clk_i        : in    std_logic;
    signal reset_i      : in    std_logic;
    signal enable_i     : in    std_logic;
    signal value_o      : out   unsigned(g_COUNTER_WIDTH - 1 downto 0);
    signal wraparound_o : out   std_logic
  );
end entity counter;

architecture rtl of counter is

  signal counter_int : unsigned(g_COUNTER_WIDTH - 1 downto 0) := (others => '0');

begin

  assert g_COUNTER_WIDTH >= log2ceil(g_MODULO)
    report "ERROR: counter width not sufficient for selected modulo"
    severity failure;

  proc_cnt : process (clk_i) is
  begin

    if rising_edge(clk_i) then
      if ((reset_i or wraparound_o) = '1') then
        counter_int <= (others => '0');
      elsif (enable_i = '1') then
        counter_int <= counter_int + 1;
      end if;
    end if;

  end process proc_cnt;

  value_o <= counter_int;

  gen_wrap : if g_MODULO > 0 generate
    wraparound_o <= enable_i when (counter_int = g_MODULO - 1) else
                    '0';
  else generate
    wraparound_o <= enable_i when (counter_int = (counter_int'range => '1')) else
                    '0';
  end generate gen_wrap;

end architecture rtl;
