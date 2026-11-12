--! @title Common Functions
--! @file utils.vhdl
--! @author Alberto Perro (alberto.perro at cern.ch)
--! @date 30-11-2023
--! @version 0.1

--! Some of the work was inspired by the PoC Library (https://github.com/VLSI-EDA/PoC)
--! Release log:
--! - 0.1 first release
--!
-- SPDX-FileCopyrightText: 2026 CERN
-- SPDX-License-Identifier: CERN-OHL-W-2.0

library ieee;
  use ieee.std_logic_1164.all;
  use ieee.numeric_std.all;
  use ieee.math_real.all;

package utils is

  type compiler_t is (AUTO, QUARTUS, VIVADO);

  -- COMMON MATH FUNCTIONS
  --! ceil(a/b)
  function div_ceil (a : natural; b : positive) return natural;

  --! ceil(a/b)
  function div_ceil (a : unsigned; b : positive) return unsigned;

  --! ceil(a/b)
  function div_ceil (a : time; b : positive) return time;

  --! ceil(a/b)
  function div_ceil (a : time; b : time) return natural;

  --! computes ceil(log2(arg)) and return unsigned of bits size
  function log2ceil (arg : unsigned; bits : natural) return unsigned;

  --! computes ceil(log2(arg)) NOTE: log2ceil of 0 returns 0
  function log2ceil (arg : natural) return natural;

  --! compute Greatest Common Divisor between N1 and N2
  function greatest_common_div (n1 : positive; n2 : positive) return positive;

  --! compute Greatest Least Common Multiple between N1 and N2
  function least_common_mult (n1 : positive; n2 : positive) return positive;

  -- UTILITIES
  --! register generator
  function registered (signal clk : std_logic; constant isregistered : boolean) return boolean;

  --! check if compiler is quartus
  function compiler_is_quartus return boolean;

  --! check if compiler is vivado
  function compiler_is_vivado return boolean;

  --! return compiler used
  function get_compiler return compiler_t;

  -- BIT/BYTE MANIPULATION
  --! count ones in std_logic_vector
  function count_ones (arg : std_logic_vector) return natural;

  --! invert order of bits in std_logic_vector
  function invert_bit_order (word : std_logic_vector) return std_logic_vector;

  --! invert order of bytes in std_logic_vector
  function swap_endianness (vec : std_logic_vector) return std_logic_vector;

  --! slice from left on signal value (for synth)
  function slice_bytes_left (vec : std_logic_vector; pos : unsigned) return std_logic_vector;

  --! slice from right on signal value (for synth)
  function slice_bytes_right (vec : std_logic_vector; pos : unsigned) return std_logic_vector;

  --! slice middle on signal value (for synth)
  function slice_bytes (vec : std_logic_vector; pos_l : unsigned; pos_r : unsigned) return std_logic_vector;

  --! slice from left on signal value (for synth)
  function slice_bytes_left (vec : std_logic_vector; pos : natural) return std_logic_vector;

  --! slice from right on signal value (for synth)
  function slice_bytes_right (vec : std_logic_vector; pos : natural) return std_logic_vector;

  --! slice middle on signal value (for synth)
  function slice_bytes (vec : std_logic_vector; pos_l : natural; pos_r : natural) return std_logic_vector;

  --! mask from left on signal value (for synth)
  function mask_bytes_left (pos : natural;constant size : positive) return std_logic_vector;

  --! mask to right on signal value (for synth)
  function mask_bytes_right (pos : natural;constant size : positive) return std_logic_vector;

  --! mask middle on signal value (for synth)
  function mask_bytes (pos_l : natural; pos_r : natural;constant size : positive) return std_logic_vector;

  --! xor all bits in std_logic_vector (for synth)
  function xorvec (vec : std_logic_vector) return std_logic;

  --! and all bits in std_logic_vector (to be used in Xilinx)
  function andvec (vec : std_logic_vector) return std_logic;

  -- PATTERNS
  --! generate word with even bits to 1 odd bits to 0
  function gen_even (len : natural) return std_logic_vector;

  --! generate word with even bits to 0 odd bits to 1
  function gen_odd (len : natural) return std_logic_vector;

  --! CONDITIONALS
  --! If-then-else : pick between two integers
  function if_sel (condition : boolean; pos_case : integer; neg_case : integer) return integer;

  --! If-then-else : pick between two unsigneds
  function if_sel (condition : boolean; pos_case : unsigned; neg_case : unsigned) return unsigned;

  --! If-then-else : pick between two signeds
  function if_sel (condition : boolean; pos_case : signed; neg_case : signed) return signed;

  --! If-then-else : pick between two std_logic_vectors
  function if_sel (condition : boolean; pos_case : std_logic_vector; neg_case : std_logic_vector)
  return std_logic_vector;

end package utils;

package body utils is

  -- MATH FUNCTIONS
  function div_ceil (a : natural; b : positive) return natural is -- calculates: ceil(a / b)
  begin

    return (a + (b - 1)) / b;

  end function div_ceil;

  function div_ceil (a : unsigned; b : positive) return unsigned is -- calculates: ceil(a / b)
  begin

    return resize((resize(a, a'length + 1) + (b - 1)) / b, a'length);

  end function div_ceil;

  function div_ceil (a : time; b : positive) return time is -- calculates: ceil(a / b)
  begin

    return (((a / 1 fs) + ((b - 1))) / b) * (1 fs);

  end function div_ceil;

  function div_ceil (a : time; b : time) return natural is -- calculates: ceil(a / b)
  begin

    return (a + ((b - 1 fs))) / b;

  end function div_ceil;

  function log2ceil (arg : unsigned; bits : natural) return unsigned is

    variable v_tmp : unsigned(arg'range);
    variable v_log : unsigned(arg'range);

  begin

    if (arg = 1) then
      return (arg'range => '0');
    end if;

    v_tmp := (0 => '1', others => '0');
    v_log := (others => '0');

    while arg > v_tmp loop
      v_tmp := v_tmp * 2;
      v_log := v_log + 1;
    end loop;

    return v_log;

  end function log2ceil;

  function log2ceil (arg : natural) return natural is

    variable v_tmp : positive;
    variable v_log : natural;

  begin

    if (arg < 1) then
      return 0;
    end if;

    v_tmp := 1;
    v_log := 0;

    while arg > v_tmp loop
      v_tmp := v_tmp * 2;
      v_log := v_log + 1;
    end loop;

    return v_log;

  end function log2ceil;

  -- greatest common divisor (gcd)
  function greatest_common_div (n1 : positive; n2 : positive) return positive is

    variable v_m1        : positive;
    variable v_m2        : natural;
    variable v_remainder : natural;

  begin

    if (n1 > n2) then
      v_m1 := n1;
      v_m2 := n2;
    else
      v_m1 := n2;
      v_m2 := n1;
    end if;

    while v_m2 /= 0 loop
      v_remainder := v_m1 mod v_m2;
      v_m1        := v_m2;
      v_m2        := v_remainder;
    end loop;

    return v_m1;

  end function greatest_common_div;

  -- least common multiple (lcm)
  function least_common_mult (n1 : positive; n2 : positive) return positive is
  begin

    return ((n1 * n2) / greatest_common_div(n1, n2));

  end function least_common_mult;

  -- register generator
  function registered (signal clk : std_logic; constant isregistered : boolean) return boolean is
  begin

    if (isregistered) then
      return rising_edge(clk);
    else
      return true;
    end if;

  end function registered;

  --! check if compiler is quartus
  function compiler_is_quartus return boolean is

    variable v_ret : boolean := true;

  begin

    -- altera translate_off
    v_ret := false;
    -- altera translate_on
    return v_ret;

  end function compiler_is_quartus;

  --! check if compiler is vivado
  function compiler_is_vivado return boolean is

    variable v_ret : boolean := true;

  begin

    -- xilinx translate_off
    v_ret := false;
    -- xilinx translate_on
    return v_ret;

  end function compiler_is_vivado;

  --! return compiler used
  function get_compiler return compiler_t is

    variable v_ret : compiler_t := AUTO;

  begin

    if (compiler_is_quartus) then
      v_ret := QUARTUS;
      report "Detected Quartus Compiler";
    elsif (compiler_is_vivado) then
      v_ret := VIVADO;
      report "Detected Vivado Compiler";
    else
      report "Couldn't find compiler used: selecting AUTO";
    end if;

    return v_ret;

  end function get_compiler;

  -- BIT/BYTE MANIPULATION
  -- count ones
  function count_ones (arg : std_logic_vector) return natural is

    variable v_count : natural range 0 to arg'length;

  begin

    v_count := 0;

    for i in arg'range loop

      if (arg(i) = '1') then
        v_count := v_count + 1;
      end if;

    end loop;

    return v_count;

  end function count_ones;

  -- invert bit order
  function invert_bit_order (word : std_logic_vector) return std_logic_vector is

    variable v_res : std_logic_vector(word'range);

  begin

    for i in 0 to word'length - 1 loop
      v_res(i) := word(word'length - i - 1);
    end loop;

    return v_res;

  end function invert_bit_order;

  --! swap byte order
  function swap_endianness (vec : std_logic_vector) return std_logic_vector is

    variable v_ret       : std_logic_vector(vec'range);
    constant c_VEC_BYTES : positive := vec'length / 8;

  begin

    assert vec'length mod 8 = 0
      report "Can't swap endianness if not byte-aligned."
      severity failure;

    for i in 0 to c_VEC_BYTES - 1 loop
      v_ret(vec'left - i * 8 downto vec'left - (i + 1) * 8 + 1) :=
        vec(vec'left - (c_VEC_BYTES - 1 - i) * 8 downto vec'left - (c_VEC_BYTES - i) * 8 + 1);
    end loop;

    return v_ret;

  end function swap_endianness;

  --! slice from left on signal value (for synth)
  function slice_bytes_left (vec : std_logic_vector; pos : unsigned) return std_logic_vector is

    variable v_ret : vec'subtype;

  begin

    assert vec'length mod 8 = 0
      report "Can't slice if not byte-aligned."
      severity failure;
    v_ret := vec and mask_bytes_left(to_integer(pos), vec'length / 8);
    return v_ret;

  end function slice_bytes_left;

  --! slice from right on signal value (for synth)
  function slice_bytes_right (vec : std_logic_vector; pos : unsigned) return std_logic_vector is

    variable v_ret : vec'subtype;

  begin

    assert vec'length mod 8 = 0
      report "Can't slice if not byte-aligned."
      severity failure;
    v_ret := vec and mask_bytes_left(to_integer(pos), vec'length / 8);
    v_ret := std_logic_vector(shift_left(unsigned(v_ret), vec'length - (to_integer(pos) * 8)));
    return v_ret;

  end function slice_bytes_right;

  --! slice middle on signal value (for synth)
  function slice_bytes (vec : std_logic_vector; pos_l : unsigned; pos_r : unsigned) return std_logic_vector is

    variable v_ret : vec'subtype;

  begin

    assert vec'length mod 8 = 0
      report "Can't slice if not byte-aligned."
      severity failure;
    v_ret := vec and mask_bytes_left(to_integer(pos_r), vec'length);
    v_ret := std_logic_vector(shift_left(unsigned(v_ret), to_integer(pos_l) * 8));
    return v_ret;

  end function slice_bytes;

  --! slice from left on signal value (for synth)
  function slice_bytes_left (vec : std_logic_vector; pos : natural) return std_logic_vector is

    variable v_ret : vec'subtype;

  begin

    assert vec'length mod 8 = 0
      report "Can't slice if not byte-aligned."
      severity failure;
    v_ret := vec and mask_bytes_left(pos, vec'length / 8);
    return v_ret;

  end function slice_bytes_left;

  --! slice from right on signal value (for synth)
  function slice_bytes_right (vec : std_logic_vector; pos : natural) return std_logic_vector is

    variable v_ret : vec'subtype;

  begin

    assert vec'length mod 8 = 0
      report "Can't slice if not byte-aligned."
      severity failure;
    v_ret := vec and mask_bytes_left(pos, vec'length / 8);
    v_ret := std_logic_vector(shift_left(unsigned(v_ret), vec'length - (pos * 8)));
    return v_ret;

  end function slice_bytes_right;

  --! slice middle on signal value (for synth)
  function slice_bytes (vec : std_logic_vector; pos_l : natural; pos_r : natural) return std_logic_vector is

    variable v_ret : vec'subtype;

  begin

    assert vec'length mod 8 = 0
      report "Can't slice if not byte-aligned."
      severity failure;
    v_ret := vec and mask_bytes_left(pos_r, vec'length / 8);
    v_ret := std_logic_vector(shift_left(unsigned(v_ret), pos_l * 8));
    return v_ret;

  end function slice_bytes;

  --! mask from left on signal value (for synth)
  function mask_bytes_left (pos : natural;constant size : positive) return std_logic_vector is

    variable v_ret : std_logic_vector(size * 8 - 1 downto 0);

  begin

    for i in 0 to v_ret'length / 8 - 1 loop

      if (i < pos) then
        v_ret(v_ret'left - (i * 8) downto v_ret'length - (i + 1) * 8) := (others => '1');
      else
        v_ret(v_ret'left - (i * 8) downto v_ret'length - (i + 1) * 8) := (others => '0');
      end if;

    end loop;

    return v_ret;

  end function mask_bytes_left;

  --! mask to right on signal value (for synth)
  function mask_bytes_right (pos : natural;constant size : positive) return std_logic_vector is

    variable v_ret : std_logic_vector(size * 8 - 1 downto 0);

  begin

    v_ret := not mask_bytes_left(pos, size);
    return v_ret;

  end function mask_bytes_right;

  --! mask middle on signal value (for synth)
  function mask_bytes (pos_l : natural; pos_r : natural;constant size : positive) return std_logic_vector is

    variable v_ret : std_logic_vector(size * 8 - 1 downto 0);

  begin

    v_ret := mask_bytes_left(pos_l, size) and mask_bytes_right(pos_l, size);
    return v_ret;

  end function mask_bytes;

  --! xor all bits in std_logic_vector (for synth)
  function xorvec (vec : std_logic_vector) return std_logic is

    variable v_ret : std_logic;

  begin

    v_ret := '0';

    for i in vec'range loop
      v_ret := v_ret xor vec(i);
    end loop;

    return v_ret;

  end function xorvec;

  --! and all bits in std_logic_vector (to be used in Xilinx)
  function andvec (vec : std_logic_vector) return std_logic is

    variable v_ret : std_logic;

  begin

    v_ret := '1';

    for i in vec'range loop
      v_ret := v_ret and vec(i);
    end loop;

    return v_ret;

  end function andvec;

  --! generate word with even bits to 1 odd bits to 0
  function gen_even (len : natural) return std_logic_vector is

    variable v_ret     : std_logic_vector(len - 1 downto 0);
    variable v_uns_idx : unsigned(log2ceil(len) - 1 downto 0);

  begin

    for i in 0 to len - 1 loop
      v_uns_idx := to_unsigned(i, v_uns_idx'length);

      if (v_uns_idx(0) = '0') then
        v_ret(i) := '1';
      else
        v_ret(i) := '0';
      end if;

    end loop;

    return v_ret;

  end function gen_even;

  --! generate word with even bits to 0 odd bits to 1
  function gen_odd (len : natural) return std_logic_vector is

    variable v_ret     : std_logic_vector(len - 1 downto 0);
    variable v_uns_idx : unsigned(log2ceil(len) - 1 downto 0);

  begin

    for i in 0 to len - 1 loop
      v_uns_idx := to_unsigned(i, v_uns_idx'length);

      if (v_uns_idx(0) = '1') then
        v_ret(i) := '1';
      else
        v_ret(i) := '0';
      end if;

    end loop;

    return v_ret;

  end function gen_odd;

  function if_sel (condition : boolean; pos_case : integer; neg_case : integer) return integer is
  begin

    if (condition) then
      return pos_case;
    else
      return neg_case;
    end if;

  end function if_sel;

  function if_sel (condition : boolean; pos_case : unsigned; neg_case : unsigned) return unsigned is
  begin

    if (condition) then
      return pos_case;
    else
      return neg_case;
    end if;

  end function if_sel;

  function if_sel (condition : boolean; pos_case : signed; neg_case : signed) return signed is
  begin

    if (condition) then
      return pos_case;
    else
      return neg_case;
    end if;

  end function if_sel;

  function if_sel (condition : boolean; pos_case : std_logic_vector; neg_case : std_logic_vector)
  return std_logic_vector is
  begin

    if (condition) then
      return pos_case;
    else
      return neg_case;
    end if;

  end function if_sel;

end package body utils;
