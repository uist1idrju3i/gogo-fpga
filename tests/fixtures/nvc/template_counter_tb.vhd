library ieee;
use ieee.std_logic_1164.all;

entity template_counter_tb is
end entity;

architecture test of template_counter_tb is
  signal clk : std_logic := '0';
  signal led : std_logic;
begin
  clk <= not clk after 5 ns;

  dut : entity work.top
    port map (
      clk => clk,
      led => led
    );

  process
  begin
    wait for 40 ns;
    report "led=" & std_logic'image(led) severity note;
    std.env.stop;
    wait;
  end process;
end architecture;
