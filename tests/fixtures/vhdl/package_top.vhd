library ieee;
use ieee.std_logic_1164.all;
use work.bit_ops.all;

entity package_top is
  port (a : in std_logic; y : out std_logic);
end entity;

architecture rtl of package_top is
begin
  u_gate : entity work.bit_ops_gate
    port map (a => a, y => y);
end architecture;
