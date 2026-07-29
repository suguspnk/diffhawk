#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const FAT_MAGIC = 0xcafebabe;
const MACHO_64_MAGIC = 0xfeedfacf;
const LC_UUID = 0x1b;
const FAT_ARCH_SIZE = 20;
const MACHO_64_HEADER_SIZE = 32;

function checkedRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(`invalid ${label} range`);
  }
}

function sliceRanges(buffer) {
  checkedRange(buffer, 0, 8, 'Mach-O header');
  if (buffer.readUInt32BE(0) !== FAT_MAGIC) {
    return [{ offset: 0, size: buffer.length }];
  }

  const count = buffer.readUInt32BE(4);
  checkedRange(buffer, 8, count * FAT_ARCH_SIZE, 'fat architecture table');
  return Array.from({ length: count }, (_, index) => {
    const entry = 8 + index * FAT_ARCH_SIZE;
    const offset = buffer.readUInt32BE(entry + 8);
    const size = buffer.readUInt32BE(entry + 12);
    checkedRange(buffer, offset, size, 'fat Mach-O slice');
    return { offset, size };
  });
}

export function normalizeMachOUuids(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Mach-O input must be a Buffer');
  }

  let normalized = 0;
  for (const slice of sliceRanges(buffer)) {
    checkedRange(buffer, slice.offset, MACHO_64_HEADER_SIZE, 'Mach-O slice header');
    if (buffer.readUInt32LE(slice.offset) !== MACHO_64_MAGIC) {
      throw new Error('only 64-bit little-endian Mach-O slices are supported');
    }

    const commandCount = buffer.readUInt32LE(slice.offset + 16);
    const commandBytes = buffer.readUInt32LE(slice.offset + 20);
    const commandsStart = slice.offset + MACHO_64_HEADER_SIZE;
    checkedRange(buffer, commandsStart, commandBytes, 'Mach-O load commands');
    const commandsEnd = commandsStart + commandBytes;
    if (commandsEnd > slice.offset + slice.size) {
      throw new Error('Mach-O load commands exceed their slice');
    }

    let commandOffset = commandsStart;
    let sliceUuids = 0;
    for (let index = 0; index < commandCount; index += 1) {
      if (commandOffset + 8 > commandsEnd) {
        throw new Error('Mach-O load command exceeds its declared region');
      }
      const command = buffer.readUInt32LE(commandOffset);
      const commandSize = buffer.readUInt32LE(commandOffset + 4);
      if (commandSize < 8) throw new Error('invalid Mach-O load command size');
      if (commandOffset + commandSize > commandsEnd) {
        throw new Error('Mach-O load command exceeds its declared region');
      }

      if (command === LC_UUID) {
        if (commandSize < 24) throw new Error('invalid LC_UUID command size');
        buffer.fill(0, commandOffset + 8, commandOffset + 24);
        sliceUuids += 1;
        normalized += 1;
      }
      commandOffset += commandSize;
    }

    if (commandOffset !== commandsEnd || sliceUuids !== 1) {
      throw new Error('expected exactly one LC_UUID command per Mach-O slice');
    }
  }
  return normalized;
}

async function main() {
  const [target, extra] = process.argv.slice(2);
  if (!target || extra) {
    throw new Error('usage: node vendor/normalize-macho-uuids.mjs <Mach-O executable>');
  }
  const binary = await readFile(target);
  normalizeMachOUuids(binary);
  await writeFile(target, binary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
