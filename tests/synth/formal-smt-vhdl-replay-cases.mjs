const counter = (body, edge = "rising_edge", init = "(others => '0')") => `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  signal count : unsigned(3 downto 0) := ${init};
begin
  process(clk) begin
    if ${edge}(clk) then count <= count + 1; end if;
  end process;
  q <= count;
${body}
end architecture;
`;

const reset = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk, rst : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  signal count : unsigned(3 downto 0) := (others => '0');
  signal started : std_logic := '0';
begin
  process(clk) begin
    if rising_edge(clk) then
      started <= '1';
      if rst = '1' then count <= (others => '0'); else count <= count + 1; end if;
    end if;
  end process;
  q <= count;
  A_RESET: assert rst /= (not started);
  P_BOUND: assert count < 3;
end architecture;
`;

export const smtVhdlReplayCases = [
  { name: "depth-n-minus-1", clock: "clk", source: counter("  P_BOUND: assert count < 3;"), depth: 3, status: "PASS", replay: "rejected" },
  { name: "depth-n", clock: "clk", source: counter("  P_BOUND: assert count < 3;"), depth: 4 },
  { name: "depth-n-plus-1", clock: "clk", source: counter("  P_BOUND: assert count < 3;"), depth: 5 },
  { name: "prove-basecase", clock: "clk", source: counter("  P_BOUND: assert count < 3;"), mode: "prove", depth: 5 },
  { name: "negedge", clock: "clk", source: counter("  P_BOUND: assert count < 3;", "falling_edge"), depth: 5, edge: "negedge" },
  { name: "nonzero-initial", clock: "clk", source: counter("  P_BOUND: assert count < 5;", "rising_edge", "4x\"2\""), depth: 5 },
  { name: "psl", clock: "clk", psl: true, source: `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk, a : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  signal count : unsigned(3 downto 0) := (others => '0');
begin
  process(clk) begin
    if rising_edge(clk) then count <= count + 1; end if;
  end process;
  q <= count;
  -- psl default clock is rising_edge(clk);
  -- psl P_BOUND: assert always (count < 3);
end architecture;
`, depth: 5 },
  { name: "combinational", clock: "clk", source: `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk, a, b : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  signal n : unsigned(3 downto 0) := (others => '0');
begin
  process(clk) begin
    if rising_edge(clk) then n <= n + 1; end if;
  end process;
  q <= 4x"4" when (a = '1' and b = '1') else n;
  P_BOUND: assert q /= 4x"4";
end architecture;
`, depth: 3 },
  { name: "reset", clock: "clk", source: reset, depth: 5 },
  { name: "assumption", clock: "clk", psl: true, source: `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk, enable : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  signal count : unsigned(3 downto 0) := (others => '0');
begin
  process(clk) begin
    if rising_edge(clk) then count <= count + 1; end if;
  end process;
  q <= count;
  -- psl default clock is rising_edge(clk);
  -- psl A_ENABLE: assume always (enable = '1');
  P_BOUND: assert count < 3;
end architecture;
`, depth: 5 },
  { name: "multiple-properties", clock: "clk", source: counter("  P_SMALL: assert count < 6;\n  P_BOUND: assert count < 3;"), depth: 5 },
  { name: "hierarchy", clock: "clk", source: `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity child is
  port (clk : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of child is
  signal count : unsigned(3 downto 0) := (others => '0');
begin
  process(clk) begin
    if rising_edge(clk) then count <= count + 1; end if;
  end process;
  q <= count;
  P_BOUND: assert count < 3;
end architecture;
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  component child is
    port (clk : in std_logic; q : out unsigned(3 downto 0));
  end component;
begin
  u: child port map (clk => clk, q => q);
end architecture;
`, depth: 5 },
  { name: "arbitrary-initial", clock: "clk", source: `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  signal count : unsigned(3 downto 0);
begin
  process(clk) begin
    if rising_edge(clk) then count <= count + 1; end if;
  end process;
  q <= count;
  P_BOUND: assert count < 3;
end architecture;
`, depth: 5, replay: "rejected" },
  { name: "memory", clock: "clk", source: `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk, a : in std_logic);
end entity;
architecture rtl of top is
  type memory is array (0 to 1) of unsigned(2 downto 0);
  signal mem : memory := (others => (others => '0'));
begin
  process(clk) begin
    if rising_edge(clk) then
      if a = '1' then mem(0) <= mem(0) + 1; else mem(1) <= mem(1) + 1; end if;
    end if;
  end process;
  P_BOUND: assert mem(0) /= 3;
end architecture;
`, depth: 5, vhdlReplay: "rejected" },
  { name: "no-property", clock: "clk", source: `library ieee;
use ieee.std_logic_1164.all;
entity top is
  port (clk : in std_logic; y : out std_logic);
end entity;
architecture rtl of top is
begin
  y <= clk;
end architecture;
`, depth: 3, status: "PASS", replay: "rejected" },
  { name: "vacuous-assumption", clock: "clk", psl: true, source: `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk, a : in std_logic; y : out std_logic);
end entity;
architecture rtl of top is
  signal n : unsigned(3 downto 0) := (others => '0');
begin
  process(clk) begin
    if rising_edge(clk) then n <= n + 1; end if;
  end process;
  y <= n(0);
  -- psl default clock is rising_edge(clk);
  -- psl A_EMPTY: assume always (false);
  -- psl P_BOUND: assert always (y = '1');
end architecture;
`, depth: 3, status: "ERROR", replay: "rejected" },
].map(fixture => ({ mode: "bmc", status: "FAIL", replay: "verified", edge: "posedge", clock: null, psl: false, vhdl: true, ...fixture,
  kind: fixture.status === "ERROR" ? "tool-error" : fixture.status === "PASS" ? "bounded-pass" : "counterexample",
  witness: !["PASS", "ERROR"].includes(fixture.status) }));
