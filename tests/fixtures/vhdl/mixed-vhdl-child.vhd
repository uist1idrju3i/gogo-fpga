library ieee;
use ieee.std_logic_1164.all;

entity child is
  port (
    clk : in std_logic;
    led : out std_logic
  );
end entity;

architecture rtl of child is
begin
  led <= clk;
end architecture;
