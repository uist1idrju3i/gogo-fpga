-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;
library alpha, beta;

entity named_top is
  port (a : in std_logic_vector(3 downto 0); ya, yb : out std_logic_vector(3 downto 0));
end entity;

architecture rtl of named_top is
begin
  a_child: entity alpha.child port map (a => a, y => ya);
  b_child: entity beta.child port map (a => a, y => yb);
end architecture;
