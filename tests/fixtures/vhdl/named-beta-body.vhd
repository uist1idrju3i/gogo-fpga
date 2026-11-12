-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;

package body shared_pkg is
  function mix(value : std_logic_vector(3 downto 0)) return std_logic_vector is
  begin
    return value xor work.shared_pkg.mask;
  end function;
end package body;
