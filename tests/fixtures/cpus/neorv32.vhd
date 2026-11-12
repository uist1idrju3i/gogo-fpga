-- SPDX-License-Identifier: BSD-3-Clause
library ieee;
use ieee.std_logic_1164.all;
library neorv32;
use neorv32.neorv32_package.all;

entity neorv32_bridge is
  port (
    clk, resetn : in std_ulogic;
    i_addr : out std_ulogic_vector(31 downto 0);
    i_req : out std_ulogic;
    i_rdata : in std_ulogic_vector(31 downto 0);
    i_ack : in std_ulogic;
    d_addr, d_wdata : out std_ulogic_vector(31 downto 0);
    d_wstrb : out std_ulogic_vector(3 downto 0);
    d_req : out std_ulogic;
    d_rdata : in std_ulogic_vector(31 downto 0);
    d_ack : in std_ulogic
  );
end entity;

architecture rtl of neorv32_bridge is
  signal instruction_request, data_request : bus_req_t;
  signal instruction_response, data_response : bus_rsp_t := rsp_terminate_c;
begin
  i_addr <= instruction_request.addr;
  i_req <= instruction_request.stb;
  d_addr <= data_request.addr;
  d_wdata <= data_request.data;
  d_req <= data_request.stb;
  d_wstrb <= data_request.ben when data_request.rw = '1' else "0000";

  process(clk)
  begin
    if rising_edge(clk) then
      instruction_response <= (ack => i_ack, err => '0', data => i_rdata);
      data_response <= (ack => d_ack, err => '0', data => d_rdata);
      if resetn = '0' then
        instruction_response <= rsp_terminate_c;
        data_response <= rsp_terminate_c;
      end if;
    end if;
  end process;

  cpu : entity neorv32.neorv32_cpu
    generic map (
      BOOT_ADDR => x"00000000", RISCV_ISA_E => true,
      RISCV_ISA_C => false, RISCV_ISA_M => false,
      TRACE_PORT_EN => false, TRACE_SIMLOG_EN => false
    )
    port map (
      clk_i => clk, rstn_i => resetn, mtime_i => (others => '0'),
      trace_o => open, sleep_o => open, ifence_o => open, dfence_o => open,
      msi_i => '0', mei_i => '0', mti_i => '0', firq_i => (others => '0'), dbi_i => '0',
      ibus_req_o => instruction_request, ibus_rsp_i => instruction_response,
      dbus_req_o => data_request, dbus_rsp_i => data_response
    );
end architecture;
