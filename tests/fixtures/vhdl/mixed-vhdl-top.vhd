library ieee;
use ieee.std_logic_1164.all;

entity child is
  port (
    clk : in std_logic;
    led : out std_logic
  );
end entity;

architecture verilog_blackbox of child is
  attribute syn_black_box : boolean;
  attribute syn_black_box of verilog_blackbox : architecture is true;
begin
end architecture;

library ieee;
use ieee.std_logic_1164.all;

entity top is
  port (
    clk : in std_logic;
    led : out std_logic
  );
end entity;

architecture rtl of top is
begin
  u_child : entity work.child
    port map (clk => clk, led => led);
end architecture;
