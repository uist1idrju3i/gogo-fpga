# SPDX-License-Identifier: BSD-3-Clause
.option norvc
.option norelax
.text
.globl _start
_start:
  addi x1, x0, 256
  addi x2, x0, 512
  lw x3, 4(x2)
  addi x4, x0, 0
  addi x5, x0, 8
loop:
  xori x6, x3, 85
  add x6, x6, x4
  sw x6, 0(x1)
  lw x7, 0(x1)
  bne x6, x7, failure
  sw x7, 0(x2)
  addi x1, x1, 4
  addi x4, x4, 1
  blt x4, x5, loop
  jal x0, _start
failure:
  addi x7, x0, -1
  sw x7, 0(x2)
  jal x0, failure
