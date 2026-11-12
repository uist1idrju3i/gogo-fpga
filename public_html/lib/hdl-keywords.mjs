const VHDL_KEYWORD_TEXT =
  "abs,access,after,alias,all,and,architecture,array,assert,attribute,begin,block," +
  "body,buffer,bus,case,component,configuration,constant,disconnect,downto,else,elsif,end,end block,end case," +
  "end component,end for,end generate,end if,end loop,end process,end record,end units,entity,exit,file,for," +
  "function,generate,generic,generic map,group,guarded,if,impure,in,inertial,inout,is,label,library,linkage," +
  "literal,loop,map,mod,nand,new,next,nor,null,of,on,open,or,others,out,package,package body,port,port map," +
  "postponed,procedure,process,pure,range,record,register,reject,rem,report,return,rol,ror,select,severity,signal," +
  "sla,sll,sra,srl,subtype,then,to,transport,type,unaffected,units,until,use,variable,wait,when,while,with,xnor,xor," +
  "force,release,protected";

const VERILOG_KEYWORD_TEXT =
  "accept_on alias always always_comb always_ff always_latch and assert assign assume automatic before begin bind " +
  "bins binsof bit break buf bufif0 bufif1 byte case casex casez cell chandle checker class clocking cmos config " +
  "const constraint context continue cover covergroup coverpoint cross deassign default defparam design disable " +
  "dist do edge else end endcase endchecker endclass endclocking endconfig endfunction endgenerate endgroup " +
  "endinterface endmodule endpackage endprimitive endprogram endproperty endsequence endtable endtask " +
  "enum event eventually expect export extends extern final first_match for force foreach forever fork forkjoin " +
  "function generate genvar global highz0 highz1 if iff ifnone ignore_bins illegal_bins implements implies import " +
  "incdir include initial inout input inside instance int integer interconnect interface intersect join join_any " +
  "join_none large let liblist library local localparam logic longint macromodule matches medium modport module " +
  "nand negedge nettype new nexttime nmos nor noshowcancelled not notif0 notif1 null or output package packed " +
  "parameter pmos posedge primitive priority program property protected pull0 pull1 pulldown pullup " +
  "pulsestyle_ondetect pulsestyle_onevent pure rand randc randcase randsequence rcmos real realtime ref reg " +
  "reject_on release repeat restrict return rnmos rpmos rtran rtranif0 rtranif1 s_always s_eventually s_nexttime " +
  "s_until s_until_with scalared sequence shortint shortreal showcancelled signed small soft solve specify " +
  "specparam static string strong strong0 strong1 struct super supply0 supply1 sync_accept_on sync_reject_on " +
  "table tagged task this throughout time timeprecision timeunit tran tranif0 tranif1 tri tri0 tri1 triand trior " +
  "trireg type typedef union unique unique0 unsigned until until_with untyped use uwire var vectored virtual void " +
  "wait wait_order wand weak weak0 weak1 while wildcard wire with within wor xnor xor";

export const VHDL_KEYWORDS = Object.freeze(
  [...new Set(VHDL_KEYWORD_TEXT.split(/[\s,]+/))].sort(),
);

export const VERILOG_KEYWORDS = Object.freeze(
  [...new Set(VERILOG_KEYWORD_TEXT.split(/\s+/))].sort(),
);

export const KEYWORDS_BY_LANGUAGE = Object.freeze({
  verilog: VERILOG_KEYWORDS,
  vhdl: VHDL_KEYWORDS,
  plain: Object.freeze([]),
});

const ALL_KEYWORDS = new Set(
  [...VERILOG_KEYWORDS, ...VHDL_KEYWORDS].map((keyword) =>
    keyword.toLowerCase(),
  ),
);
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_$]*/g;

export function collectIdentifiers(texts) {
  const sourceTexts =
    typeof texts === "string"
      ? [texts]
      : texts instanceof Map
        ? texts.values()
        : texts ?? [];
  const identifiers = new Set();
  for (const text of sourceTexts) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
      if (!ALL_KEYWORDS.has(match[0].toLowerCase())) {
        identifiers.add(match[0]);
      }
    }
  }
  return [...identifiers].sort();
}
