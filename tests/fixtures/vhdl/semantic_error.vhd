library ieee;
use ieee.std_logic_1164.all;

entity semantic_error is
  port (a : in std_logic; y : out std_logic);
end entity;

architecture rtl of semantic_error is
begin
  y <= a and missing_signal;
end architecture;
