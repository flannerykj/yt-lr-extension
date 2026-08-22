// Just enough ISO-BMFF to cut a time range out of a fragmented MP4 without
// downloading the whole thing.
//
// Netflix (like most DASH packagers) lays its audio out as
//   ftyp | moov | sidx | moof mdat | moof mdat | ...
// The `sidx` is a table of subsegments — byte length and duration for each — so
// a time range maps to a byte range, which the CDN will serve on its own. Prefix
// the init part (everything before the first moof) and the result decodes as a
// standalone file.
(function () {
  const NS = (window.YLR = window.YLR || {});

  function fourcc(view, off) {
    return (
      String.fromCharCode(view.getUint8(off)) +
      String.fromCharCode(view.getUint8(off + 1)) +
      String.fromCharCode(view.getUint8(off + 2)) +
      String.fromCharCode(view.getUint8(off + 3))
    );
  }

  // Walks the top-level boxes of `buffer`, stopping at the first one that runs
  // past the end of what we have (a partial download).
  function boxes(buffer) {
    const view = new DataView(buffer);
    const out = [];
    let off = 0;
    while (off + 8 <= view.byteLength) {
      let size = view.getUint32(off);
      const type = fourcc(view, off + 4);
      let header = 8;
      if (size === 1) {
        if (off + 16 > view.byteLength) break;
        // 64-bit sizes only matter for mdat, which we never need to walk into.
        const hi = view.getUint32(off + 8);
        const lo = view.getUint32(off + 12);
        size = hi * 4294967296 + lo;
        header = 16;
      } else if (size === 0) {
        size = view.byteLength - off; // "to end of file"
      }
      if (size < header) break; // malformed
      out.push({ type, start: off, size, header, end: off + size });
      if (off + size > view.byteLength) {
        out[out.length - 1].truncated = true;
        break;
      }
      off += size;
    }
    return out;
  }

  function findBox(list, type) {
    return list.find((b) => b.type === type) || null;
  }

  // Everything before the first media fragment: the init segment a decoder needs
  // in front of any subset of the fragments.
  function initLength(list) {
    const first = list.find((b) => b.type === "moof" || b.type === "mdat");
    if (first) return first.start;
    const last = list[list.length - 1];
    return last && !last.truncated ? last.end : 0;
  }

  // An audio sample entry of `enca` means the samples are CENC-encrypted, and no
  // amount of byte fetching will make them decodable.
  function looksEncrypted(buffer) {
    const view = new DataView(buffer);
    const limit = Math.min(view.byteLength - 4, 4 * 1024 * 1024);
    for (let i = 0; i < limit; i++) {
      const c = fourcc(view, i);
      if (c === "enca" || c === "encv" || c === "pssh" || c === "sinf") return c;
    }
    return null;
  }

  // sidx -> [{ start, end, byteStart, byteEnd }] in seconds and absolute bytes.
  function parseSidx(buffer, box) {
    const view = new DataView(buffer);
    let off = box.start + box.header;
    const version = view.getUint8(off);
    off += 4; // version + flags
    off += 4; // reference_ID
    const timescale = view.getUint32(off);
    off += 4;
    let earliest;
    let firstOffset;
    if (version === 0) {
      earliest = view.getUint32(off);
      off += 4;
      firstOffset = view.getUint32(off);
      off += 4;
    } else {
      earliest = view.getUint32(off) * 4294967296 + view.getUint32(off + 4);
      off += 8;
      firstOffset = view.getUint32(off) * 4294967296 + view.getUint32(off + 4);
      off += 8;
    }
    off += 2; // reserved
    const count = view.getUint16(off);
    off += 2;
    if (!timescale || !count) return null;

    const entries = [];
    let byteAt = box.end + firstOffset;
    let timeAt = earliest;
    for (let i = 0; i < count; i++) {
      if (off + 12 > view.byteLength) break;
      const sizeWord = view.getUint32(off);
      const duration = view.getUint32(off + 4);
      off += 12;
      const referenceType = sizeWord >>> 31; // 1 = points at another sidx
      const referencedSize = sizeWord & 0x7fffffff;
      if (referenceType === 0) {
        entries.push({
          start: timeAt / timescale,
          end: (timeAt + duration) / timescale,
          byteStart: byteAt,
          byteEnd: byteAt + referencedSize - 1
        });
      }
      byteAt += referencedSize;
      timeAt += duration;
    }
    return entries.length ? entries : null;
  }

  // The subsegments covering [start, end], as one contiguous byte range —
  // fragments are stored in order, so one request gets them all.
  function rangeFor(entries, start, end) {
    const hit = entries.filter((e) => e.end > start && e.start < end);
    if (!hit.length) return null;
    return {
      t0: hit[0].start,
      byteStart: hit[0].byteStart,
      byteEnd: hit[hit.length - 1].byteEnd,
      count: hit.length
    };
  }

  function concat(head, tail) {
    const out = new Uint8Array(head.byteLength + tail.byteLength);
    out.set(new Uint8Array(head), 0);
    out.set(new Uint8Array(tail), head.byteLength);
    return out.buffer;
  }

  // ---- fragmented MP4 -> ADTS AAC ----
  //
  // decodeAudioData will not take a fragmented MP4: the moov carries no sample
  // tables, because the samples are described by the trun in each moof. Pulling
  // the raw AAC frames out and giving each an ADTS header produces a plain .aac
  // stream, which it decodes without complaint.

  function fourccAt(view, off) {
    return fourcc(view, off);
  }

  // The init part is small, so the sample entry and esds are found by scanning
  // for their fourcc rather than descending the whole box tree.
  const CODECS = ["mp4a", "enca", "ec-3", "ac-3", "dtsc", "mha1", "Opus"];

  function codecOf(init) {
    const view = new DataView(init);
    for (let i = 0; i + 4 <= view.byteLength; i++) {
      const c = fourccAt(view, i);
      if (CODECS.indexOf(c) !== -1) return c;
    }
    return null;
  }

  // MPEG-4 descriptors use a variable-length size: 7 bits per byte, top bit
  // meaning "another byte follows".
  function descriptorLength(view, off) {
    let size = 0;
    let read = 0;
    for (let i = 0; i < 4; i++) {
      const b = view.getUint8(off + i);
      size = (size << 7) | (b & 0x7f);
      read++;
      if (!(b & 0x80)) break;
    }
    return { size, read };
  }

  // AudioSpecificConfig -> what an ADTS header needs.
  function parseASC(bytes) {
    let bitPos = 0;
    const read = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byte = bytes[bitPos >> 3];
        if (byte === undefined) return v << (n - i - 1);
        v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
        bitPos++;
      }
      return v;
    };
    const readAOT = () => {
      const a = read(5);
      return a === 31 ? 32 + read(6) : a;
    };
    let aot = readAOT();
    let freqIndex = read(4);
    if (freqIndex === 15) read(24);
    const channels = read(4);
    // HE-AAC (SBR) and HE-AACv2 (PS) wrap an AAC-LC core. ADTS describes the
    // core, so unwrap to it and keep the core sample rate.
    if (aot === 5 || aot === 29) {
      const extIndex = read(4);
      if (extIndex === 15) read(24);
      aot = readAOT();
    }
    if (!channels || freqIndex > 12) return null;
    // ADTS carries the profile in two bits, so it can only describe audio object
    // types 1-4 (Main / LC / SSR / LTP). Anything else — notably xHE-AAC, which
    // Netflix ships as its lowest-bitrate stream — has no ADTS representation.
    return { profile: aot, freqIndex, channels, adtsCapable: aot >= 1 && aot <= 4 };
  }

  function aotName(aot) {
    if (aot === 2) return "AAC-LC";
    if (aot === 5) return "HE-AAC";
    if (aot === 29) return "HE-AACv2";
    if (aot === 42) return "xHE-AAC";
    return "audio object type " + aot;
  }

  // ES_Descriptor (0x03) -> DecoderConfigDescriptor (0x04) -> DecSpecificInfo
  // (0x05), which holds the AudioSpecificConfig.
  function walkDescriptors(init, view, from, limit) {
    let off = from;
    for (let step = 0; step < 8 && off + 2 <= limit; step++) {
      const tag = view.getUint8(off);
      const len = descriptorLength(view, off + 1);
      const body = off + 1 + len.read;
      if (tag === 0x05) {
        const asc = new Uint8Array(init.slice(body, body + Math.max(2, len.size)));
        return parseASC(asc);
      }
      if (tag === 0x03) {
        // ES_ID(2) + flags(1), then whichever optional fields the flags claim.
        const flags = view.getUint8(body + 2);
        let next = body + 3;
        if (flags & 0x80) next += 2; // dependsOn_ES_ID
        if (flags & 0x40) next += 1 + view.getUint8(next); // URL
        if (flags & 0x20) next += 2; // OCR_ES_ID
        off = next;
      } else if (tag === 0x04) {
        // objectType(1) streamType(1) bufferSizeDB(3) maxBitrate(4) avgBitrate(4)
        off = body + 13;
      } else break;
    }
    return null;
  }

  function audioConfig(init) {
    const view = new DataView(init);
    for (let i = 0; i + 8 <= view.byteLength; i++) {
      if (fourccAt(view, i) !== "esds") continue;
      const boxStart = i - 4;
      const size = boxStart >= 0 ? view.getUint32(boxStart) : 0;
      const limit =
        size > 8 && boxStart + size <= view.byteLength ? boxStart + size : view.byteLength;
      const walked = walkDescriptors(init, view, i + 4 + 4, limit);
      if (walked) return walked;
      // Packagers vary in which optional descriptor fields they emit, so if the
      // walk goes off course, find the DecSpecificInfo by its tag instead.
      for (let j = i + 8; j + 2 < limit; j++) {
        if (view.getUint8(j) !== 0x05) continue;
        const len = descriptorLength(view, j + 1);
        if (len.size < 2 || len.size > 64) continue;
        const asc = parseASC(new Uint8Array(init.slice(j + 1 + len.read, j + 1 + len.read + len.size)));
        if (asc) return asc;
      }
    }
    return null;
  }

  function childBoxes(buffer, box) {
    const view = new DataView(buffer);
    const out = [];
    let off = box.start + box.header;
    while (off + 8 <= box.end && off + 8 <= view.byteLength) {
      const size = view.getUint32(off);
      const type = fourcc(view, off + 4);
      if (size < 8 || off + size > box.end) break;
      out.push({ type, start: off, size, header: 8, end: off + size });
      off += size;
    }
    return out;
  }

  // Where each sample of one fragment lives: its byte offset and size.
  //
  // The offset matters as much as the size. A trun's data_offset is measured
  // from the start of its moof (the DASH default-base-is-moof rule), and it is
  // NOT always the first byte after the mdat header — assuming that yields
  // frames sliced at the wrong boundary, which decodes as noise or not at all.
  function fragmentSamples(buffer, moof) {
    const view = new DataView(buffer);
    const out = [];
    for (const traf of childBoxes(buffer, moof).filter((b) => b.type === "traf")) {
      let defaultSize = 0;
      let baseOffset = moof.start;
      const kids = childBoxes(buffer, traf);
      const tfhd = kids.find((b) => b.type === "tfhd");
      if (tfhd) {
        const flags = view.getUint32(tfhd.start + tfhd.header) & 0xffffff;
        let off = tfhd.start + tfhd.header + 4 + 4; // version/flags + track_ID
        if (flags & 0x000001) {
          baseOffset = view.getUint32(off) * 4294967296 + view.getUint32(off + 4);
          off += 8;
        }
        if (flags & 0x000002) off += 4;
        if (flags & 0x000008) off += 4;
        if (flags & 0x000010) defaultSize = view.getUint32(off);
      }
      for (const trun of kids.filter((b) => b.type === "trun")) {
        const flags = view.getUint32(trun.start + trun.header) & 0xffffff;
        let off = trun.start + trun.header + 4;
        const count = view.getUint32(off);
        off += 4;
        let at = baseOffset;
        if (flags & 0x000001) {
          at = baseOffset + view.getInt32(off);
          off += 4;
        }
        if (flags & 0x000004) off += 4;
        const perSample =
          (flags & 0x000100 ? 4 : 0) +
          (flags & 0x000200 ? 4 : 0) +
          (flags & 0x000400 ? 4 : 0) +
          (flags & 0x000800 ? 4 : 0);
        for (let i = 0; i < count; i++) {
          let size = defaultSize;
          if (flags & 0x000200) {
            const sizeAt = off + i * perSample + (flags & 0x000100 ? 4 : 0);
            if (sizeAt + 4 > view.byteLength) break;
            size = view.getUint32(sizeAt);
          }
          if (size <= 0) break;
          out.push({ at, size });
          at += size;
        }
      }
    }
    return out;
  }

  function adtsHeader(frameLength, profile, freqIndex, channels) {
    const h = new Uint8Array(7);
    h[0] = 0xff;
    h[1] = 0xf1; // MPEG-4, layer 0, no CRC
    h[2] = (((profile - 1) & 3) << 6) | ((freqIndex & 15) << 2) | ((channels >> 2) & 1);
    h[3] = ((channels & 3) << 6) | ((frameLength >> 11) & 3);
    h[4] = (frameLength >> 3) & 0xff;
    h[5] = ((frameLength & 7) << 5) | 0x1f;
    h[6] = 0xfc;
    return h;
  }

  // init (for the codec config) + media fragments -> an ADTS AAC buffer, or null
  // if this isn't AAC or the config can't be read.
  function toADTS(init, media) {
    const codec = codecOf(init);
    if (codec !== "mp4a") return { buffer: null, codec, reason: "not AAC" };
    const config = audioConfig(init);
    if (!config) return { buffer: null, codec, reason: "no readable AudioSpecificConfig" };
    if (!config.adtsCapable)
      return {
        buffer: null,
        codec,
        config,
        reason: aotName(config.profile) + " cannot be carried in ADTS"
      };

    const list = boxes(media);
    const parts = [];
    let frames = 0;
    let skipped = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].type !== "moof") continue;
      const mdat = list[i + 1];
      if (!mdat || mdat.type !== "mdat" || mdat.truncated) continue;
      const payloadStart = mdat.start + mdat.header;
      const samples = fragmentSamples(media, list[i]);
      const last = samples[samples.length - 1];
      // Do the declared offsets land inside this fragment's mdat? If they don't,
      // the file numbers them from a base outside the range we fetched, so read
      // the payload straight through instead.
      const trustOffsets =
        !!last && samples[0].at >= payloadStart && last.at + last.size <= mdat.end;
      let cursor = payloadStart;
      for (const sample of samples) {
        const at = trustOffsets ? sample.at : cursor;
        cursor = at + sample.size;
        if (at < payloadStart || at + sample.size > mdat.end) {
          skipped++;
          continue;
        }
        parts.push(
          adtsHeader(sample.size + 7, config.profile, config.freqIndex, config.channels)
        );
        parts.push(new Uint8Array(media.slice(at, at + sample.size)));
        frames++;
      }
    }
    if (!frames)
      return { buffer: null, codec, config, reason: "no AAC frames found in the fragments" };
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return { buffer: out.buffer, codec, config, frames, skipped };
  }

  NS.mp4 = {
    boxes,
    findBox,
    initLength,
    looksEncrypted,
    parseSidx,
    rangeFor,
    concat,
    codecOf,
    audioConfig,
    aotName,
    toADTS
  };
})();
