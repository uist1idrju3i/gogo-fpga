-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;

package shared_pkg is
  constant mask : std_logic_vector(3 downto 0) := x"A";
  function mix(value : std_logic_vector(3 downto 0)) return std_logic_vector;
end package;
