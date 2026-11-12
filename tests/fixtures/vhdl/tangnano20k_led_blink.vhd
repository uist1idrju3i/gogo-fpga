library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity top is
  port (
    clk : in std_logic;
    led : out std_logic
  );
end entity top;

architecture rtl of top is
  signal counter : unsigned(23 downto 0) := (others => '0');
  signal led_state : std_logic := '0';
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if counter = to_unsigned(13499999, counter'length) then
        counter <= (others => '0');
        led_state <= not led_state;
      else
        counter <= counter + 1;
      end if;
    end if;
  end process;

  led <= led_state;
end architecture rtl;
