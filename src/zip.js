// A minimal ZIP writer — enough to put a CSV and a pile of WAVs into one file.
//
// Everything is stored, not deflated. WAV barely compresses, and shipping a
// DEFLATE implementation to save a few percent would be far more code than this
// whole file. "Stored" is a first-class ZIP method, so the result opens
// everywhere without a decompressor being involved at all.
//
// No ZIP64: that caps a library at 4 GB and 65,535 clips, which is orders of
// magnitude past anything realistic here.
(function () {
  const NS = (window.YLR = window.YLR || {});

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ZIP stores timestamps in the MS-DOS packed format, which starts at 1980 and
  // has two-second resolution.
  function dosTime(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    const year = Math.max(1980, d.getFullYear());
    return {
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
    };
  }

  function writer(size) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;
    return {
      bytes,
      u16(v) {
        view.setUint16(at, v, true);
        at += 2;
      },
      u32(v) {
        view.setUint32(at, v >>> 0, true);
        at += 4;
      },
      raw(src) {
        bytes.set(src, at);
        at += src.length;
      }
    };
  }

  async function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof data === "string") return new TextEncoder().encode(data);
    return new Uint8Array(await data.arrayBuffer()); // Blob
  }

  // files: [{ name, data: Blob | ArrayBuffer | Uint8Array | string, date? }]
  async function zip(files, onProgress) {
    const encoder = new TextEncoder();
    const parts = [];
    const entries = [];
    let offset = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = encoder.encode(file.name);
      const bytes = await toBytes(file.data);
      const crc = crc32(bytes);
      const stamp = dosTime(file.date);

      const header = writer(30 + name.length);
      header.u32(0x04034b50);
      header.u16(20); // version needed
      header.u16(0x0800); // UTF-8 filename
      header.u16(0); // stored
      header.u16(stamp.time);
      header.u16(stamp.date);
      header.u32(crc);
      header.u32(bytes.length);
      header.u32(bytes.length);
      header.u16(name.length);
      header.u16(0); // no extra field
      header.raw(name);

      parts.push(header.bytes, bytes);
      entries.push({ name, crc, size: bytes.length, offset, stamp });
      offset += header.bytes.length + bytes.length;
      if (onProgress) onProgress(i + 1, files.length);
    }

    let directorySize = 0;
    for (const e of entries) directorySize += 46 + e.name.length;
    const directory = writer(directorySize + 22);
    for (const e of entries) {
      directory.u32(0x02014b50);
      directory.u16(20); // version made by
      directory.u16(20); // version needed
      directory.u16(0x0800);
      directory.u16(0);
      directory.u16(e.stamp.time);
      directory.u16(e.stamp.date);
      directory.u32(e.crc);
      directory.u32(e.size);
      directory.u32(e.size);
      directory.u16(e.name.length);
      directory.u16(0); // extra
      directory.u16(0); // comment
      directory.u16(0); // disk number
      directory.u16(0); // internal attrs
      directory.u32(0); // external attrs
      directory.u32(e.offset);
      directory.raw(e.name);
    }
    directory.u32(0x06054b50);
    directory.u16(0); // this disk
    directory.u16(0); // disk holding the directory
    directory.u16(entries.length);
    directory.u16(entries.length);
    directory.u32(directorySize);
    directory.u32(offset);
    directory.u16(0); // no comment

    parts.push(directory.bytes);
    return new Blob(parts, { type: "application/zip" });
  }

  NS.zip = zip;
})();
