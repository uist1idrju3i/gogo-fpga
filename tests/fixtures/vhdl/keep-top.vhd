library ieee;
use ieee.std_logic_1164.all;

entity top is
  port (
    clk : in std_logic;
    led : out std_logic
  );
end entity;

architecture rtl of top is
  signal kept_signal : std_logic;
  attribute keep : boolean;
  attribute keep of kept_signal : signal is true;
begin
  kept_signal <= clk;
  led <= kept_signal;
end architecture;
