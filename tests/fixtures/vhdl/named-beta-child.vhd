-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;
use work.shared_pkg.all;

entity child is
  port (a : in std_logic_vector(3 downto 0); y : out std_logic_vector(3 downto 0));
end entity;

architecture rtl of child is
begin
  y <= mix(a);
end architecture;
