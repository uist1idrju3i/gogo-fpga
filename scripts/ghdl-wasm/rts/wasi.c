/* Copyright (c) 2026, 午後のFPGA */
/* SPDX-License-Identifier: GPL-2.0-or-later */
#include <stddef.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

void *__gnat_malloc(size_t size) {
  return malloc(size);
}

void __gnat_free(void *pointer) {
  free(pointer);
}

FILE *__ghdl_get_stdin(void) {
  return stdin;
}

FILE *__ghdl_get_stdout(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  return stdout;
}

FILE *__ghdl_get_stderr(void) {
  return stderr;
}

int __ghdl_open_read(const char *name) {
  return open(name, O_RDONLY);
}

int __ghdl_create_file(const char *name) {
  return open(name, O_WRONLY | O_CREAT | O_TRUNC, 0666);
}

int __ghdl_is_regular_file(const char *name) {
  struct stat info;
  return stat(name, &info) == 0 && S_ISREG(info.st_mode);
}

int __ghdl_is_directory(const char *name) {
  struct stat info;
  return stat(name, &info) == 0 && S_ISDIR(info.st_mode);
}

int __ghdl_file_mtime(const char *name, long long *mtime) {
  struct stat info;
  if (stat(name, &info) != 0) {
    return -1;
  }
  *mtime = (long long)info.st_mtime;
  return 0;
}

int __ghdl_file_length(int fd, long long *length) {
  struct stat info;
  if (fstat(fd, &info) != 0 || info.st_size < 0) {
    return -1;
  }
  *length = (long long)info.st_size;
  return 0;
}

long long __ghdl_read_all(int fd, void *buffer, size_t length) {
  unsigned char *position = buffer;
  size_t total = 0;
  while (total < length) {
    ssize_t count = read(fd, position + total, length - total);
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    if (count == 0) {
      break;
    }
    total += (size_t)count;
  }
  return (long long)total;
}
