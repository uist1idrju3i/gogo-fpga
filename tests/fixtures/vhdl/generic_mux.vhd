library ieee;
use ieee.std_logic_1164.all;

entity generic_mux is
  generic (WIDTH : positive := 8);
  port (
    a, b : in std_logic_vector(WIDTH - 1 downto 0);
    select_b : in std_logic;
    y : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of generic_mux is
begin
  y <= b when select_b = '1' else a;
end architecture;
