library ieee;
use ieee.std_logic_1164.all;

entity combinational is
  port (
    a, b, c : in std_logic;
    y : out std_logic
  );
end entity;

architecture rtl of combinational is
begin
  y <= (a and b) or c;
end architecture;
