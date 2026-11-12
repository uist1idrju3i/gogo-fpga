-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
library common;

entity top is
  port (clk : in std_logic; led : out std_logic);
end entity;

architecture rtl of top is
  signal value : unsigned(7 downto 0) := (others => '0');
  signal cycles : unsigned(2 downto 0) := (others => '0');
  signal ready, valid : std_ulogic;
  signal result : std_ulogic_vector(7 downto 0);
begin
  pipeline : entity common.handshake_pipeline
    generic map (data_width => 8, full_throughput => true,
                 pipeline_control_signals => true, pipeline_data_signals => true)
    port map (clk => clk, input_ready => ready, input_valid => '1',
              input_data => std_ulogic_vector(value), input_strobe => "1",
              output_ready => not cycles(2), output_valid => valid, output_data => result);
  process (clk) is
  begin
    if rising_edge(clk) then
      cycles <= cycles + 1;
      if ready = '1' then
        value <= value + 1;
      end if;
    end if;
  end process;
  led <= result(0) xor valid;
end architecture;
