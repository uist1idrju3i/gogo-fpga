library ieee;
use ieee.std_logic_1164.all;

entity top is
  port (
    clk : in std_logic;
    led : out std_logic
  );
end entity;

architecture rtl of top is
  function identity(value : std_logic) return result of std_logic is
  begin
    return value;
  end function;
begin
  led <= identity(clk);
end architecture;
