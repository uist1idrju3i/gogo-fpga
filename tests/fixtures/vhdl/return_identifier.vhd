entity return_identifier is
  port (
    a : in integer range 0 to 255;
    y : out integer range 0 to 255
  );
end entity;

architecture rtl of return_identifier is
  function identity(value : integer) return result of integer is
  begin
    return value;
  end function;
begin
  y <= identity(a);
end architecture;
