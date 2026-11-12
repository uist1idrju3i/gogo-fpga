library ieee;
use ieee.std_logic_1164.all;

package bit_ops is
  function invert(value : std_logic) return std_logic;
end package;

package body bit_ops is
  function invert(value : std_logic) return std_logic is
  begin
    return not value;
  end function;
end package body;

library ieee;
use ieee.std_logic_1164.all;
use work.bit_ops.all;

entity bit_ops_gate is
  port (a : in std_logic; y : out std_logic);
end entity;

architecture rtl of bit_ops_gate is
begin
  y <= invert(a);
end architecture;
